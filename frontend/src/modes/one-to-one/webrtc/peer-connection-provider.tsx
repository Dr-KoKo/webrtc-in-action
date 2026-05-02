// PeerConnectionProvider — Phase 7 (T051–T054) + Phase 8 (T057–T062).
//
// Owns the `RTCPeerConnection` lifecycle + the offer/answer
// negotiation flow. Lives between the SignalingProvider and the
// LocalMediaProvider in `App.tsx` so it can read the live local
// `MediaStream` and send/receive SDP over the shared WS.
//
// Registration model:
//   The main `dispatcher.ts` no longer handles `ready_for_offer`,
//   `offer`, `answer`, or `ice_candidate` — those are reserved for
//   this provider's own `client.onMessage` subscription. Each side
//   parses the raw frame through the shared Zod schema (cheap;
//   avoids coupling the two handlers). The dispatcher continues to
//   handle join / presence / media-release / error / leave so the
//   two listeners never overlap.
//
// Contract / data-model references:
// - §3.7 `ready_for_offer` — PC construction trigger; role assigned
//   by admissionOrder; exactly once per pairing attempt. Late
//   duplicates log `unexpected_ready_for_offer` and are ignored.
// - §3.8 `offer`, §3.9 `answer` — the only C→S→C negotiation
//   relay messages Phase 7 sends.
// - §3.10 `ice_candidate` — Phase 8 trickle ICE; `candidate: null`
//   is end-of-candidates and is never passed to `addIceCandidate`.
// - data-model §B.1 — session FSM transitions:
//     waiting-for-peer → connecting (on ready_for_offer)
//     connecting       → connected  (on RTCPeerConnectionState ===
//                                    "connected").
// - data-model §B.4 — four getters mirrored into the reducer slice
//   so UI indicators stay in sync.
// - data-model §B.6 — `IceBuffer` holds remote candidates that
//   arrived before the local `setRemoteDescription` resolves.
//
// Phase 8 adds: local `onicecandidate` → send; inbound
// `ice_candidate` buffered via `IceBuffer` until SRD; `ontrack` →
// aggregated remote `MediaStream` exposed via a getter + version
// counter (same DI shape as `LocalMediaProvider`); Learning
// Inspector snapshot updated from the SDP / candidate summaries.
// DataChannel `onopen/onmessage` wiring remains Phase 9 work.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useDispatch, useRootState } from "../state";
import type {
  PeerConnectionAction,
  PeerConnectionSnapshot,
} from "../state/peer-connection";
import { makeEventLogEntry } from "../state/event-log";
import { useSignalingClient } from "../signaling/provider";
import {
  signalingMessageSchema,
  type AnswerMessage,
  type IceCandidateMessage,
  type OfferMessage,
  type ReadyForOfferMessage,
} from "../protocol/schema";
import { useLocalMedia } from "./local-media-provider";
import {
  createPeerConnection,
  type CreatePeerConnectionOptions,
  type PeerConnectionHandle,
} from "./peer-connection";
import {
  createIceBuffer,
  type IceBuffer,
} from "./ice-buffer";
import {
  wrapDataChannel,
  type ChatSendResult,
  type DataChannelStateValue,
  type DataChannelWrapper,
} from "./data-channel";
import {
  makeChatMessage,
  validateChatMessage,
  type ChatValidationError,
} from "../state/chat";
import {
  initialInspectorSnapshot,
  summarizeCandidate,
  summarizeIceServers,
  summarizeSdp,
  type LearningInspectorSnapshot,
} from "./learning-inspector";
import { CONTRACT_VERSION } from "../types/contract";

export interface PeerConnectionContextValue {
  /** Read-only accessor. Browser objects live here; reducer state
   *  only mirrors getter snapshots (see PeerConnectionSlice). */
  getHandle(): PeerConnectionHandle | null;
  /**
   * Phase 8 — aggregated remote `MediaStream` (audio+video tracks
   * collected from `ontrack`). Kept in a ref for the same reason as
   * the local stream: streams are not React-state-safe. Consumers
   * subscribe by reading `remoteStreamVersion` in their effect deps.
   */
  getRemoteStream(): MediaStream | null;
  remoteStreamVersion: number;
  hasRemoteStream: boolean;
  /** Learning Inspector v1 snapshot (FR-030). Summaries only. */
  inspector: LearningInspectorSnapshot;
  /**
   * Phase 9 — send a chat message over the DataChannel. Returns a
   * structured result so callers (Chat.tsx) can decide how to render
   * a validation / not-open / backpressure failure. Appends a
   * `chat_message_sent` event-log entry on success and a
   * `chat_message_appended` transcript entry.
   */
  sendChatMessage(text: string): ChatSendOutcome;
  /**
   * Phase 12 (§C.5) — tear down the RTCDataChannel + RTCPeerConnection
   * + IceBuffer + remote media state. Idempotent. Does NOT stop local
   * MediaStreamTracks and does NOT close the WebSocket — the caller
   * (Path A / B / C orchestrator in `webrtc/cleanup.ts`) is responsible
   * for those steps in the order §C.5 requires. `source` labels the
   * cleanup path so future observability can distinguish the three
   * entry points; the actual event-log "cleanup completed" line is
   * emitted by the orchestrator, not here.
   */
  teardownPeerConnection(source: CleanupSource): void;
}

export type CleanupSource =
  | "local_leave"
  | "remote_peer_left"
  | "local_failure";

export type ChatSendOutcome =
  | { ok: true }
  | { ok: false; reason: ChatSendError };

export type ChatSendError =
  | ChatValidationError
  | "not-open"
  | "backpressure"
  | "invalid";

// Exported so tests may provide a custom value (see
// `tests/unit/screen-share-button.spec.tsx`). Production code MUST go
// through `<PeerConnectionProvider>` + `usePeerConnection()` — the
// export is a test seam, not a public API. Mirrors `LocalMediaContext`
// at `local-media-provider.tsx:60`.
export const PeerConnectionContext = createContext<PeerConnectionContextValue | null>(
  null,
);

export interface PeerConnectionProviderProps {
  children: ReactNode;
  /**
   * Test seam — production `createPeerConnection` uses the real
   * `RTCPeerConnection` constructor. Tests that want to inspect the
   * handshake without a browser can inject a fake factory (used by
   * `CreatePeerConnectionOptions.factory`).
   */
  peerConnectionFactory?: CreatePeerConnectionOptions["factory"];
}

export function PeerConnectionProvider({
  children,
  peerConnectionFactory,
}: PeerConnectionProviderProps) {
  const dispatch = useDispatch();
  const state = useRootState();
  const client = useSignalingClient();
  const localMedia = useLocalMedia();

  // The PC itself and transient pairing context live in refs because
  // they are not serializable and must not live in React state.
  const handleRef = useRef<PeerConnectionHandle | null>(null);
  const iceBufferRef = useRef<IceBuffer | null>(null);
  // Phase 9 — live chat DataChannel wrapper. Provider-owned; never
  // placed in reducer state. Reducer mirrors only the scalar
  // `DataChannelState` value via the dataChannel slice.
  const chatChannelRef = useRef<DataChannelWrapper | null>(null);
  // Aggregated remote stream — `ontrack` pushes every track here; the
  // version counter bumps each time so consumers re-bind their
  // `<video>` `srcObject`. This mirrors LocalMediaProvider's DI shape.
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const [remoteStreamVersion, setRemoteStreamVersion] = useState(0);
  const [inspector, setInspector] = useState<LearningInspectorSnapshot>(
    initialInspectorSnapshot,
  );
  // Cached room id for outbound `ice_candidate` relays — populated when
  // `ready_for_offer` fires. Avoids a stale-state race in the onicecandidate
  // callback, which is invoked from a browser task separate from the session
  // update cycle.
  const activeRoomIdRef = useRef<string | null>(null);
  const roleRef = useRef<"offerer" | "answerer" | null>(null);

  // Mirror the latest session slice into a ref so the async WS
  // handler reads fresh values (the handler closure captures the
  // initial `state` otherwise and we'd mis-gate on stale fields).
  const sessionRef = useRef(state.session);
  sessionRef.current = state.session;

  // Same for the local-media getter so the async handler can fetch
  // the live stream at acquire-time without re-subscribing.
  const getLocalStreamRef = useRef(localMedia.getStream);
  getLocalStreamRef.current = localMedia.getStream;

  const bumpRemoteVersion = useCallback(() => {
    setRemoteStreamVersion((v) => v + 1);
  }, []);

  const resetRemoteStream = useCallback(() => {
    const current = remoteStreamRef.current;
    if (current) {
      for (const track of current.getTracks()) {
        // We do NOT stop remote tracks here — they belong to the
        // remote peer and the browser manages their lifecycle when
        // the PC closes. Detaching is sufficient.
        current.removeTrack(track);
      }
    }
    remoteStreamRef.current = null;
    bumpRemoteVersion();
  }, [bumpRemoteVersion]);

  useEffect(() => {
    const unsubscribe = client.onMessage((raw) => {
      // Parse once more via the shared schema. Any parse failure is
      // swallowed here because the main dispatcher has already logged
      // the malformed envelope (single source of error-log truth).
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        return;
      }
      const parsed = signalingMessageSchema.safeParse(json);
      if (!parsed.success) return;
      const msg = parsed.data;
      switch (msg.type) {
        case "ready_for_offer":
          void handleReadyForOffer(msg);
          return;
        case "offer":
          void handleOffer(msg);
          return;
        case "answer":
          void handleAnswer(msg);
          return;
        case "ice_candidate":
          void handleIceCandidate(msg);
          return;
        default:
          return;
      }
    });
    return unsubscribe;
    // `dispatch`, `client`, `peerConnectionFactory` are stable for
    // the provider's lifetime (context-supplied); the handlers below
    // close over them via closure. We intentionally do NOT depend on
    // reducer state — reads go through `sessionRef` / `handleRef`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, dispatch]);

  // ------------------------------------------------------------------
  // DataChannel wiring (Phase 9). Wraps the browser RTCDataChannel
  // (offerer-created or answerer-received) and routes its lifecycle +
  // inbound messages into the reducer. Called twice in the lifetime of
  // a pairing at most: once from the offerer's `createChatDataChannel`
  // result, once from the answerer's `ondatachannel` event. The
  // `origin` label just narrates whether this side created or received
  // the channel — it does NOT split the code path.
  // ------------------------------------------------------------------
  function attachChatDataChannel(
    channel: RTCDataChannel,
    origin: "offerer" | "answerer",
  ): void {
    // Idempotence guard: if a wrapper already exists (e.g., duplicate
    // ondatachannel or a post-Phase-12 second pairing that hasn't
    // cleaned up yet), log and replace defensively. Phase 9 does not
    // exercise this path but the guard avoids silent leaks.
    const existing = chatChannelRef.current;
    if (existing) {
      existing.close();
      chatChannelRef.current = null;
    }
    const wrapper = wrapDataChannel({
      channel,
      onStateChange: (next: DataChannelStateValue) => {
        dispatch({ type: "DATA_CHANNEL_STATE_CHANGED", state: next });
        dispatch({
          type: "EVENT_LOG_APPEND",
          entry: makeEventLogEntry({
            type: "data_channel_state_changed",
            direction: origin === "offerer" ? "local" : "remote",
            summary: `dataChannel("${channel.label}") → ${next}`,
            transport: "datachannel",
          }),
        });
      },
      onMessage: (data: unknown) => {
        const result = validateChatMessage(data);
        if (!result.ok) {
          dispatch({
            type: "EVENT_LOG_APPEND",
            entry: makeEventLogEntry({
              type: "data_channel_error",
              direction: "remote",
              summary: `chat message rejected (${result.reason})`,
              code: `chat_invalid_${result.reason}`,
              transport: "datachannel",
            }),
          });
          return;
        }
        const message = makeChatMessage({ from: "peer", text: result.text });
        dispatch({ type: "CHAT_MESSAGE_APPENDED", message });
        dispatch({
          type: "EVENT_LOG_APPEND",
          entry: makeEventLogEntry({
            type: "chat_message_received",
            direction: "remote",
            summary: `chat received: ${summarizeChatText(result.text)}`,
            transport: "datachannel",
          }),
        });
      },
      onError: (ev: Event) => {
        const errorEv = ev as RTCErrorEvent;
        const detail =
          errorEv && errorEv.error && errorEv.error.message
            ? errorEv.error.message
            : "unknown";
        dispatch({
          type: "EVENT_LOG_APPEND",
          entry: makeEventLogEntry({
            type: "data_channel_error",
            direction: "system",
            summary: `dataChannel error: ${detail}`,
            code: "data_channel_error",
            transport: "datachannel",
          }),
        });
      },
    });
    chatChannelRef.current = wrapper;
  }

  // Phase 12 (§C.5) — shared teardown body. Invoked from three places:
  //   1. unmount effect below (HMR / StrictMode / route change).
  //   2. leaveSession() in `webrtc/cleanup.ts` (Path A).
  //   3. remotePeerLeft() in `webrtc/cleanup.ts` (Path B).
  //   4. onConnectionStateChange="failed" in this provider (Path C).
  // Does NOT touch local MediaStreamTracks or the WebSocket — the
  // step order for each path lives in the orchestrator, not here.
  // Idempotent: every ref / close() is guarded against double-invoke.
  const teardownPeerConnection = useCallback((_source: CleanupSource): void => {
    chatChannelRef.current?.close();
    chatChannelRef.current = null;
    handleRef.current?.close();
    handleRef.current = null;
    iceBufferRef.current?.close();
    iceBufferRef.current = null;
    activeRoomIdRef.current = null;
    roleRef.current = null;
    // Detach remote tracks; the browser owns their underlying
    // lifetime. Also clears the RemoteMediaState indicator via the
    // orchestrator's REMOTE_MEDIA_STATE_CLEARED dispatch (not done
    // here — teardown is pure DOM/browser teardown).
    const rs = remoteStreamRef.current;
    if (rs) {
      for (const t of rs.getTracks()) rs.removeTrack(t);
    }
    remoteStreamRef.current = null;
    setRemoteStreamVersion((v) => v + 1);
    setInspector(initialInspectorSnapshot);
    dispatch({ type: "PEER_CONNECTION_CLOSED" });
    dispatch({ type: "DATA_CHANNEL_RESET" });
  }, [dispatch]);

  // Unmount cleanup — final safety net. Mirrors the Phase-9 structure;
  // mid-lifetime teardown paths call `teardownPeerConnection` directly
  // via the context (Path A/B/C orchestrators).
  useEffect(() => {
    return () => {
      chatChannelRef.current?.close();
      chatChannelRef.current = null;
      handleRef.current?.close();
      handleRef.current = null;
      iceBufferRef.current?.close();
      iceBufferRef.current = null;
      activeRoomIdRef.current = null;
      roleRef.current = null;
      const rs = remoteStreamRef.current;
      if (rs) {
        for (const t of rs.getTracks()) rs.removeTrack(t);
      }
      remoteStreamRef.current = null;
    };
  }, []);

  async function handleReadyForOffer(msg: ReadyForOfferMessage): Promise<void> {
    // Contract §3.7 validation (client): handle exactly once per
    // pairing attempt; ignore if arriving in any other state.
    //
    // PHASE 12 HOOK — the `handleRef.current !== null` guard makes the
    // provider single-use by design for Phase 8. The Phase-8 session
    // reducer has no transition back to `waiting-for-peer` from
    // `connecting`/`connected`, so this branch is unreachable through
    // any shipped user path. Phase 12's cleanup work (T086+) will add
    // `peer_left → waiting-for-peer` and with it the second-pairing
    // flow; that phase MUST: (a) lift this guard, (b) call
    // `teardownPeerConnection()` — see the unmount cleanup below —
    // before re-creating the PC, and (c) reset `remoteStreamRef` +
    // `inspector` so stale remote media / summaries don't survive the
    // new pairing. Keep the guard noisy (log the unexpected receipt)
    // rather than silently overwriting the PC ref.
    const currentSession = sessionRef.current.session;
    if (currentSession !== "waiting-for-peer" || handleRef.current !== null) {
      dispatch({
        type: "EVENT_LOG_APPEND",
        entry: makeEventLogEntry({
          type: "error_occurred",
          direction: "system",
          summary: `unexpected_ready_for_offer (state=${currentSession}${
            handleRef.current ? ", PC already exists" : ""
          })`,
          code: "unexpected_ready_for_offer",
          transport: "signaling",
        }),
      });
      return;
    }

    const { role, remotePeer, iceServers: inboundIceServers } = msg.payload;
    // Strip explicit `undefined` keys so the object matches
    // `RTCIceServer` under `exactOptionalPropertyTypes: true`. The Zod
    // schema treats `username` / `credential` as optional-and-possibly-
    // undefined, but the DOM lib treats them as present-and-string.
    const iceServers: RTCIceServer[] = inboundIceServers.map((s) => ({
      urls: s.urls,
      ...(s.username !== undefined ? { username: s.username } : {}),
      ...(s.credential !== undefined ? { credential: s.credential } : {}),
    }));

    dispatch({
      type: "EVENT_LOG_APPEND",
      entry: makeEventLogEntry({
        type: "ready_for_offer_received",
        direction: "remote",
        summary: `ready_for_offer received (role=${role}, remote=${shortenId(remotePeer.peerId)}, iceServers=${iceServers.length})`,
        transport: "signaling",
      }),
    });

    // Reducer transitions waiting-for-peer → connecting.
    dispatch({ type: "READY_FOR_OFFER" });

    // Cache role + room id for out-of-band callbacks (onicecandidate,
    // ontrack) that fire outside the WS handler closure.
    roleRef.current = role;
    activeRoomIdRef.current = msg.roomId ?? sessionRef.current.roomId;

    // Seed the inspector snapshot with the configured iceServers.
    setInspector((prev) => ({
      ...prev,
      configured: summarizeIceServers(iceServers),
    }));

    const handle = createPeerConnection({
      iceServers,
      role,
      ...(peerConnectionFactory ? { factory: peerConnectionFactory } : {}),
      onSignalingStateChange: (next) => {
        dispatchSnapshot(dispatch, { signalingState: next });
        dispatch({
          type: "EVENT_LOG_APPEND",
          entry: makeEventLogEntry({
            type: "signaling_state_changed",
            direction: "local",
            summary: `signalingState → ${next}`,
          }),
        });
      },
      onConnectionStateChange: (next) => {
        dispatchSnapshot(dispatch, { connectionState: next });
        dispatch({
          type: "EVENT_LOG_APPEND",
          entry: makeEventLogEntry({
            type: "peer_connection_state_changed",
            direction: "local",
            summary: `connectionState → ${next}`,
          }),
        });
        // Phase-8 FSM promotion: PC reached `connected` → session
        // goes connecting → connected. The reducer ignores the action
        // from any other state, so a spurious event during
        // renegotiation/cleanup is harmless.
        if (next === "connected" && sessionRef.current.session === "connecting") {
          dispatch({ type: "CONNECTION_ESTABLISHED" });
        }
        // Phase-12 (§C.5 Path C) — terminal local PC failure. Enter
        // `failed`, tear down the PC / DC / remote state, but keep
        // local tracks + WS alive. The user picks Leave or Rejoin from
        // the FailurePanel to complete Path A.
        if (
          next === "failed" &&
          (sessionRef.current.session === "connecting" ||
            sessionRef.current.session === "connected")
        ) {
          dispatch({ type: "CONNECTION_FAILED" });
          dispatch({ type: "REMOTE_MEDIA_STATE_CLEARED" });
          dispatch({
            type: "EVENT_LOG_APPEND",
            entry: makeEventLogEntry({
              type: "error_occurred",
              direction: "local",
              summary: "connection failed — manual Leave or Rejoin",
              code: "ice_failure",
            }),
          });
          teardownPeerConnection("local_failure");
          dispatch({
            type: "EVENT_LOG_APPEND",
            entry: makeEventLogEntry({
              type: "cleanup_completed",
              direction: "system",
              summary: "cleanup completed (path=local_failure)",
              code: "local_failure",
            }),
          });
        }
      },
      onIceConnectionStateChange: (next) => {
        dispatchSnapshot(dispatch, { iceConnectionState: next });
        dispatch({
          type: "EVENT_LOG_APPEND",
          entry: makeEventLogEntry({
            type: "peer_connection_state_changed",
            direction: "local",
            summary: `iceConnectionState → ${next}`,
          }),
        });
      },
      onIceGatheringStateChange: (next) => {
        dispatchSnapshot(dispatch, { iceGatheringState: next });
        dispatch({
          type: "EVENT_LOG_APPEND",
          entry: makeEventLogEntry({
            type: "peer_connection_state_changed",
            direction: "local",
            summary: `iceGatheringState → ${next}`,
          }),
        });
      },
      onIceCandidate: (cand) => {
        // T057 — forward every local candidate over signaling. `null`
        // marks end-of-candidates and MUST be forwarded as
        // `{candidate: null}` (contract §3.10). Event-log summary
        // avoids the raw candidate body per NFR-006.
        sendIceCandidate(cand);
        if (cand === null) {
          setInspector((prev) => ({
            ...prev,
            observed: { ...prev.observed, endOfLocalCandidates: true },
          }));
          return;
        }
        const summary = summarizeCandidate(cand);
        setInspector((prev) => ({
          ...prev,
          observed: tallyCandidate(prev.observed, summary.type, "local"),
        }));
      },
      onTrack: (ev) => {
        // T060 — aggregate every remote track into a single shared
        // MediaStream. Chromium emits one `track` event per track in
        // the remote SDP, so we accumulate into `remoteStreamRef`.
        // The browser-provided `ev.streams[0]` would also work but
        // is unreliable when the remote peer split audio+video into
        // separate m-sections (rare, but allowed).
        let aggregate = remoteStreamRef.current;
        if (!aggregate) {
          aggregate = new MediaStream();
          remoteStreamRef.current = aggregate;
        }
        if (!aggregate.getTracks().some((t) => t.id === ev.track.id)) {
          aggregate.addTrack(ev.track);
        }
        bumpRemoteVersion();
        dispatch({
          type: "EVENT_LOG_APPEND",
          entry: makeEventLogEntry({
            type: "remote_track_received",
            direction: "remote",
            summary: `remote track received (kind=${ev.track.kind}, id=${shortenId(ev.track.id)})`,
          }),
        });
      },
      ...(role === "answerer"
        ? {
            onDataChannel: (dc: RTCDataChannel) => {
              // T066 — answerer side: the offerer's pre-offer
              // DataChannel has arrived. Log receipt AND wire the
              // full lifecycle through `attachChatDataChannel` so
              // readyState transitions flow into the dataChannel
              // slice and inbound `message` events append chat
              // entries.
              dispatch({
                type: "EVENT_LOG_APPEND",
                entry: makeEventLogEntry({
                  type: "data_channel_created",
                  direction: "remote",
                  summary: `ondatachannel fired (label="${dc.label}", ordered=${dc.ordered})`,
                  transport: "datachannel",
                }),
              });
              attachChatDataChannel(dc, "answerer");
            },
          }
        : {}),
    });
    handleRef.current = handle;

    // Create a fresh IceBuffer for this pairing. It routes inbound
    // remote candidates to `addIceCandidate`, applying immediately
    // after the local `setRemoteDescription` resolves, or buffering
    // them in arrival order until then.
    iceBufferRef.current = createIceBuffer({
      target: {
        addIceCandidate: (c) => handle.addRemoteIceCandidate(c),
      },
      onError: (err, _c) => {
        dispatch({
          type: "EVENT_LOG_APPEND",
          entry: makeEventLogEntry({
            type: "error_occurred",
            direction: "local",
            summary: `addIceCandidate failed: ${(err as Error).message ?? "unknown"}`,
            code: "add_ice_candidate_failed",
          }),
        });
      },
    });

    dispatch({
      type: "PEER_CONNECTION_CREATED",
      snapshot: handle.getSnapshot(),
    });
    dispatch({
      type: "EVENT_LOG_APPEND",
      entry: makeEventLogEntry({
        type: "peer_connection_created",
        direction: "local",
        summary: `RTCPeerConnection created (role=${role}, iceServers=${iceServers.length})`,
      }),
    });

    // Attach existing local tracks. Per Phase-7 constraints we DO
    // NOT reacquire media here — the LocalMediaProvider has already
    // delivered the stream as part of the pending-media → waiting-
    // for-peer transition. If the stream is missing we log and bail
    // (should not happen under the current FSM; data-model §B.1).
    const stream = getLocalStreamRef.current();
    if (!stream) {
      dispatch({
        type: "EVENT_LOG_APPEND",
        entry: makeEventLogEntry({
          type: "error_occurred",
          direction: "local",
          summary:
            "peer_connection_created without a local MediaStream — attach skipped",
          code: "missing_local_stream",
        }),
      });
    } else {
      handle.attachLocalTracks(stream);
    }

    if (role === "offerer") {
      const dc = handle.createChatDataChannel();
      dispatch({
        type: "EVENT_LOG_APPEND",
        entry: makeEventLogEntry({
          type: "data_channel_created",
          direction: "local",
          summary: `createDataChannel("chat") (ordered=${dc.ordered})`,
          transport: "datachannel",
        }),
      });
      // T065 — wire offerer-created channel into the reducer
      // lifecycle. The wrapper emits an initial `connecting` state
      // synchronously; subsequent `open` / `closing` / `close`
      // events drive the dataChannel slice.
      attachChatDataChannel(dc, "offerer");
      try {
        const offer = await handle.createOffer();
        dispatch({
          type: "EVENT_LOG_APPEND",
          entry: makeEventLogEntry({
            type: "offer_created",
            direction: "local",
            // SDP length only — raw SDP is deliberately omitted per
            // NFR-006 / Principle VIII. `m=audio/video/application`
            // counts give a cheap didactic sanity check.
            summary: `createOffer ok (sdpBytes=${offer.sdp?.length ?? 0}, ${mLineSummary(offer.sdp)})`,
          }),
        });
        setInspector((prev) => ({
          ...prev,
          local: summarizeSdp({ type: "offer", sdp: offer.sdp ?? "" }),
        }));
        sendOffer(msg.roomId, offer);
      } catch (err) {
        dispatch({
          type: "EVENT_LOG_APPEND",
          entry: makeEventLogEntry({
            type: "error_occurred",
            direction: "local",
            summary: `createOffer failed: ${(err as Error).message ?? "unknown"}`,
            code: "create_offer_failed",
          }),
        });
      }
    }
  }

  async function handleOffer(msg: OfferMessage): Promise<void> {
    const handle = handleRef.current;
    if (!handle) {
      dispatch({
        type: "EVENT_LOG_APPEND",
        entry: makeEventLogEntry({
          type: "error_occurred",
          direction: "remote",
          summary: "offer received before ready_for_offer; ignoring",
          code: "unexpected_offer",
          transport: "signaling",
        }),
      });
      return;
    }
    if (handle.role !== "answerer") {
      dispatch({
        type: "EVENT_LOG_APPEND",
        entry: makeEventLogEntry({
          type: "error_occurred",
          direction: "remote",
          summary: `offer received but role=${handle.role}; ignoring`,
          code: "unexpected_offer",
          transport: "signaling",
        }),
      });
      return;
    }

    dispatch({
      type: "EVENT_LOG_APPEND",
      entry: makeEventLogEntry({
        type: "offer_received",
        direction: "remote",
        summary: `offer received (sdpBytes=${msg.payload.sdp.sdp.length}, ${mLineSummary(msg.payload.sdp.sdp)})`,
        transport: "signaling",
      }),
    });

    try {
      const answer = await handle.applyOffer(msg.payload.sdp);
      // T059 — remote description is now set. Flush any candidates
      // that arrived before the answerer processed the offer.
      await iceBufferRef.current?.markRemoteDescriptionSet();
      setInspector((prev) => ({
        ...prev,
        remote: summarizeSdp({
          type: "offer",
          sdp: msg.payload.sdp.sdp,
        }),
        local: summarizeSdp({ type: "answer", sdp: answer.sdp ?? "" }),
      }));
      dispatch({
        type: "EVENT_LOG_APPEND",
        entry: makeEventLogEntry({
          type: "answer_created",
          direction: "local",
          summary: `createAnswer ok (sdpBytes=${answer.sdp?.length ?? 0}, ${mLineSummary(answer.sdp)})`,
        }),
      });
      sendAnswer(msg.roomId, answer);
    } catch (err) {
      dispatch({
        type: "EVENT_LOG_APPEND",
        entry: makeEventLogEntry({
          type: "error_occurred",
          direction: "local",
          summary: `applyOffer failed: ${(err as Error).message ?? "unknown"}`,
          code: "apply_offer_failed",
        }),
      });
    }
  }

  async function handleAnswer(msg: AnswerMessage): Promise<void> {
    const handle = handleRef.current;
    if (!handle) {
      dispatch({
        type: "EVENT_LOG_APPEND",
        entry: makeEventLogEntry({
          type: "error_occurred",
          direction: "remote",
          summary: "answer received before ready_for_offer; ignoring",
          code: "unexpected_answer",
          transport: "signaling",
        }),
      });
      return;
    }
    if (handle.role !== "offerer") {
      dispatch({
        type: "EVENT_LOG_APPEND",
        entry: makeEventLogEntry({
          type: "error_occurred",
          direction: "remote",
          summary: `answer received but role=${handle.role}; ignoring`,
          code: "unexpected_answer",
          transport: "signaling",
        }),
      });
      return;
    }

    dispatch({
      type: "EVENT_LOG_APPEND",
      entry: makeEventLogEntry({
        type: "answer_received",
        direction: "remote",
        summary: `answer received (sdpBytes=${msg.payload.sdp.sdp.length}, ${mLineSummary(msg.payload.sdp.sdp)})`,
        transport: "signaling",
      }),
    });

    try {
      await handle.applyAnswer(msg.payload.sdp);
      // T059 — offerer now has a remote description. Flush any
      // candidates that trickled in before the answer arrived.
      await iceBufferRef.current?.markRemoteDescriptionSet();
      setInspector((prev) => ({
        ...prev,
        remote: summarizeSdp({
          type: "answer",
          sdp: msg.payload.sdp.sdp,
        }),
      }));
    } catch (err) {
      dispatch({
        type: "EVENT_LOG_APPEND",
        entry: makeEventLogEntry({
          type: "error_occurred",
          direction: "local",
          summary: `applyAnswer failed: ${(err as Error).message ?? "unknown"}`,
          code: "apply_answer_failed",
        }),
      });
    }
  }

  async function handleIceCandidate(msg: IceCandidateMessage): Promise<void> {
    const buffer = iceBufferRef.current;
    if (!buffer) {
      // Candidate arrived before `ready_for_offer` — shouldn't happen
      // under the contract (candidates only flow after both peers are
      // role-assigned), but surface defensively so a server-side bug
      // is visible in the log.
      dispatch({
        type: "EVENT_LOG_APPEND",
        entry: makeEventLogEntry({
          type: "error_occurred",
          direction: "remote",
          summary: "ice_candidate received without an active PC; ignoring",
          code: "unexpected_ice_candidate",
          transport: "signaling",
        }),
      });
      return;
    }
    const payloadCandidate = msg.payload.candidate;
    if (payloadCandidate === null) {
      // End-of-candidates marker from the remote peer. Record for
      // observability; never passed to addIceCandidate.
      dispatch({
        type: "EVENT_LOG_APPEND",
        entry: makeEventLogEntry({
          type: "ice_candidate_received",
          direction: "remote",
          summary: "remote ice_candidate: end-of-candidates",
          transport: "signaling",
        }),
      });
      setInspector((prev) => ({
        ...prev,
        observed: { ...prev.observed, endOfRemoteCandidates: true },
      }));
      buffer.add(null);
      return;
    }
    // Zod has already validated the payload shape (non-empty candidate
    // string, optional sdpMid / sdpMLineIndex / usernameFragment).
    // Strip explicit-undefined keys to satisfy the browser's
    // `RTCIceCandidateInit` shape under exactOptionalPropertyTypes.
    const candInit: RTCIceCandidateInit = {
      candidate: payloadCandidate.candidate,
      ...(payloadCandidate.sdpMid !== undefined
        ? { sdpMid: payloadCandidate.sdpMid }
        : {}),
      ...(payloadCandidate.sdpMLineIndex !== undefined
        ? { sdpMLineIndex: payloadCandidate.sdpMLineIndex }
        : {}),
      ...(payloadCandidate.usernameFragment !== undefined
        ? { usernameFragment: payloadCandidate.usernameFragment }
        : {}),
    };
    const summary = summarizeCandidate(candInit);
    dispatch({
      type: "EVENT_LOG_APPEND",
      entry: makeEventLogEntry({
        type: "ice_candidate_received",
        direction: "remote",
        summary: `remote ice_candidate (${summary.type}/${summary.protocol}${buffer.remoteDescriptionSet ? "" : ", buffered"})`,
        transport: "signaling",
      }),
    });
    setInspector((prev) => ({
      ...prev,
      observed: tallyCandidate(prev.observed, summary.type, "remote"),
    }));
    const apply = buffer.add(candInit);
    if (apply) {
      try {
        await apply;
      } catch {
        // `onError` on the buffer already logs. The buffer swallows
        // the rejection so the provider doesn't need extra handling.
      }
    }
  }

  function sendOffer(
    roomId: string | undefined,
    offer: RTCSessionDescriptionInit,
  ): void {
    const target = roomId ?? sessionRef.current.roomId ?? null;
    if (!target) return;
    if (!offer.sdp) return;
    try {
      client.send({
        v: CONTRACT_VERSION,
        type: "offer",
        roomId: target,
        payload: {
          sdp: { type: "offer", sdp: offer.sdp },
        },
      });
      dispatch({
        type: "EVENT_LOG_APPEND",
        entry: makeEventLogEntry({
          type: "offer_sent",
          direction: "local",
          summary: `offer sent (sdpBytes=${offer.sdp.length})`,
          transport: "signaling",
        }),
      });
    } catch (err) {
      dispatch({
        type: "EVENT_LOG_APPEND",
        entry: makeEventLogEntry({
          type: "error_occurred",
          direction: "local",
          summary: `send offer failed: ${(err as Error).message ?? "unknown"}`,
          code: "send_offer_failed",
          transport: "signaling",
        }),
      });
    }
  }

  function sendIceCandidate(
    candidate: RTCIceCandidateInit | null,
  ): void {
    const target =
      activeRoomIdRef.current ?? sessionRef.current.roomId ?? null;
    if (!target) return;
    try {
      client.send({
        v: CONTRACT_VERSION,
        type: "ice_candidate",
        roomId: target,
        payload: {
          candidate:
            candidate === null
              ? null
              : {
                  candidate: candidate.candidate ?? "",
                  // Contract §3.10: these three optional fields are
                  // forwarded as-is. Omit keys set to undefined so
                  // the Zod schema accepts the body under
                  // exactOptionalPropertyTypes.
                  ...(candidate.sdpMid !== undefined &&
                  candidate.sdpMid !== null
                    ? { sdpMid: candidate.sdpMid }
                    : {}),
                  ...(candidate.sdpMLineIndex !== undefined &&
                  candidate.sdpMLineIndex !== null
                    ? { sdpMLineIndex: candidate.sdpMLineIndex }
                    : {}),
                  ...(candidate.usernameFragment !== undefined &&
                  candidate.usernameFragment !== null
                    ? { usernameFragment: candidate.usernameFragment }
                    : {}),
                },
        },
      });
      if (candidate === null) {
        dispatch({
          type: "EVENT_LOG_APPEND",
          entry: makeEventLogEntry({
            type: "ice_candidate_sent",
            direction: "local",
            summary: "local ice_candidate: end-of-candidates",
            transport: "signaling",
          }),
        });
      } else {
        const summary = summarizeCandidate(candidate);
        dispatch({
          type: "EVENT_LOG_APPEND",
          entry: makeEventLogEntry({
            type: "ice_candidate_sent",
            direction: "local",
            summary: `local ice_candidate (${summary.type}/${summary.protocol})`,
            transport: "signaling",
          }),
        });
      }
    } catch (err) {
      dispatch({
        type: "EVENT_LOG_APPEND",
        entry: makeEventLogEntry({
          type: "error_occurred",
          direction: "local",
          summary: `send ice_candidate failed: ${(err as Error).message ?? "unknown"}`,
          code: "send_ice_candidate_failed",
          transport: "signaling",
        }),
      });
    }
  }

  function sendAnswer(
    roomId: string | undefined,
    answer: RTCSessionDescriptionInit,
  ): void {
    const target = roomId ?? sessionRef.current.roomId ?? null;
    if (!target) return;
    if (!answer.sdp) return;
    try {
      client.send({
        v: CONTRACT_VERSION,
        type: "answer",
        roomId: target,
        payload: {
          sdp: { type: "answer", sdp: answer.sdp },
        },
      });
      dispatch({
        type: "EVENT_LOG_APPEND",
        entry: makeEventLogEntry({
          type: "answer_sent",
          direction: "local",
          summary: `answer sent (sdpBytes=${answer.sdp.length})`,
          transport: "signaling",
        }),
      });
    } catch (err) {
      dispatch({
        type: "EVENT_LOG_APPEND",
        entry: makeEventLogEntry({
          type: "error_occurred",
          direction: "local",
          summary: `send answer failed: ${(err as Error).message ?? "unknown"}`,
          code: "send_answer_failed",
          transport: "signaling",
        }),
      });
    }
  }

  const getRemoteStream = useCallback(
    () => remoteStreamRef.current,
    [],
  );

  const sendChatMessage = useCallback(
    (rawInput: string): ChatSendOutcome => {
      // Pure validation first (T068) — same rule used at receive time,
      // so the local user sees the same errors the peer would be
      // protected from. Validation errors never touch the channel.
      const validation = validateChatMessage(rawInput);
      if (!validation.ok) {
        dispatch({
          type: "EVENT_LOG_APPEND",
          entry: makeEventLogEntry({
            type: "data_channel_error",
            direction: "local",
            summary: `chat send rejected (${validation.reason})`,
            code: `chat_invalid_${validation.reason}`,
            transport: "datachannel",
          }),
        });
        return { ok: false, reason: validation.reason };
      }
      const wrapper = chatChannelRef.current;
      if (!wrapper) {
        dispatch({
          type: "EVENT_LOG_APPEND",
          entry: makeEventLogEntry({
            type: "data_channel_error",
            direction: "local",
            summary: "chat send rejected (no active DataChannel)",
            code: "chat_send_no_channel",
            transport: "datachannel",
          }),
        });
        return { ok: false, reason: "not-open" };
      }
      const sendResult: ChatSendResult = wrapper.send(validation.text);
      if (!sendResult.ok) {
        dispatch({
          type: "EVENT_LOG_APPEND",
          entry: makeEventLogEntry({
            type: "data_channel_error",
            direction: "local",
            summary: `chat send failed (${sendResult.reason})`,
            code: `chat_send_${sendResult.reason}`,
            transport: "datachannel",
          }),
        });
        return { ok: false, reason: sendResult.reason };
      }
      const message = makeChatMessage({ from: "self", text: validation.text });
      dispatch({ type: "CHAT_MESSAGE_APPENDED", message });
      dispatch({
        type: "EVENT_LOG_APPEND",
        entry: makeEventLogEntry({
          type: "chat_message_sent",
          direction: "local",
          summary: `chat sent: ${summarizeChatText(validation.text)}`,
          transport: "datachannel",
        }),
      });
      return { ok: true };
    },
    [dispatch],
  );

  const value: PeerConnectionContextValue = {
    getHandle: () => handleRef.current,
    getRemoteStream,
    remoteStreamVersion,
    hasRemoteStream:
      remoteStreamVersion > 0 && remoteStreamRef.current !== null,
    inspector,
    sendChatMessage,
    teardownPeerConnection,
  };
  // Keep `resetRemoteStream` referenced so tree-shaking doesn't elide
  // it in builds; not currently invoked in Phase-8 since PC cleanup
  // alone handles teardown. Phase 12 will call it explicitly.
  void resetRemoteStream;

  return (
    <PeerConnectionContext.Provider value={value}>
      {children}
    </PeerConnectionContext.Provider>
  );
}

export function usePeerConnection(): PeerConnectionContextValue {
  const ctx = useContext(PeerConnectionContext);
  if (!ctx) {
    throw new Error(
      "usePeerConnection must be used inside <PeerConnectionProvider>",
    );
  }
  return ctx;
}

// ---------------------------------------------------------------------
// Helpers (module-private)
// ---------------------------------------------------------------------

function dispatchSnapshot(
  dispatch: (action: PeerConnectionAction) => void,
  snapshot: Partial<PeerConnectionSnapshot>,
): void {
  dispatch({ type: "PEER_CONNECTION_STATE_CHANGED", snapshot });
}

function shortenId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

// Truncate chat text for event-log summaries. The transcript itself
// stores the full text; the event log is a narration, not a log of
// raw message bodies. Keeps the UI panel readable when messages are
// near the 500-char limit.
function summarizeChatText(text: string): string {
  const limit = 80;
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

// Cheap SDP summary for the event log. Counts `m=` lines by kind
// without storing any body — satisfies the "summaries, not raw SDP"
// rule (NFR-006 / Principle VIII). Returns e.g. "m=audio+video+data".
function mLineSummary(sdp: string | undefined): string {
  if (!sdp) return "no-sdp";
  const kinds: string[] = [];
  if (/^m=audio /m.test(sdp)) kinds.push("audio");
  if (/^m=video /m.test(sdp)) kinds.push("video");
  if (/^m=application /m.test(sdp)) kinds.push("data");
  return kinds.length === 0 ? "no-m-lines" : `m=${kinds.join("+")}`;
}

// Tally a candidate type into the inspector's observed counters.
// `direction` is unused in Phase 8 (observed counts are combined
// local+remote for the didactic display), but kept in the signature
// so Phase-11's per-side inspector can split them without a rename.
function tallyCandidate(
  prev: LearningInspectorSnapshot["observed"],
  type: ReturnType<typeof summarizeCandidate>["type"],
  _direction: "local" | "remote",
): LearningInspectorSnapshot["observed"] {
  switch (type) {
    case "host":
      return { ...prev, hostCandidates: prev.hostCandidates + 1 };
    case "srflx":
      return { ...prev, srflxCandidates: prev.srflxCandidates + 1 };
    case "prflx":
      return { ...prev, prflxCandidates: prev.prflxCandidates + 1 };
    case "relay":
      return { ...prev, relayCandidates: prev.relayCandidates + 1 };
    default:
      return prev;
  }
}
