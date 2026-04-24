// PeerConnectionProvider — Phase 7 (T051–T054).
//
// Owns the `RTCPeerConnection` lifecycle + the offer/answer
// negotiation flow. Lives between the SignalingProvider and the
// LocalMediaProvider in `App.tsx` so it can read the live local
// `MediaStream` and send/receive SDP over the shared WS.
//
// Registration model:
//   The main `dispatcher.ts` no longer handles `ready_for_offer`,
//   `offer`, or `answer` — those are reserved for this provider's
//   own `client.onMessage` subscription. Each side parses the raw
//   frame through the shared Zod schema (cheap; avoids coupling the
//   two handlers). The dispatcher continues to handle join /
//   presence / media-release / error / leave so the two listeners
//   never overlap.
//
// Contract / data-model references:
// - §3.7 `ready_for_offer` — PC construction trigger; role assigned
//   by admissionOrder; exactly once per pairing attempt. Late
//   duplicates log `unexpected_ready_for_offer` and are ignored.
// - §3.8 `offer`, §3.9 `answer` — the only C→S→C negotiation
//   relay messages this phase sends.
// - data-model §B.1 — `waiting-for-peer → connecting` on receipt.
// - data-model §B.4 — four getters mirrored into the reducer slice
//   so UI indicators stay in sync.
//
// Phase-7 scope is strictly offer/answer. `onicecandidate` / ICE
// buffering / `ontrack` remote-media rendering are Phase 8 work;
// the DataChannel's `onopen/onmessage` wiring is Phase 9.

import {
  createContext,
  useContext,
  useEffect,
  useRef,
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
  type OfferMessage,
  type ReadyForOfferMessage,
} from "../signaling/schema";
import { useLocalMedia } from "./local-media-provider";
import {
  createPeerConnection,
  type CreatePeerConnectionOptions,
  type PeerConnectionHandle,
} from "./peer-connection";
import { CONTRACT_VERSION } from "../types/contract";

interface PeerConnectionContextValue {
  /** Read-only accessor. Browser objects live here; reducer state
   *  only mirrors getter snapshots (see PeerConnectionSlice). */
  getHandle(): PeerConnectionHandle | null;
}

const PeerConnectionContext = createContext<PeerConnectionContextValue | null>(
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

  // Mirror the latest session slice into a ref so the async WS
  // handler reads fresh values (the handler closure captures the
  // initial `state` otherwise and we'd mis-gate on stale fields).
  const sessionRef = useRef(state.session);
  sessionRef.current = state.session;

  // Same for the local-media getter so the async handler can fetch
  // the live stream at acquire-time without re-subscribing.
  const getLocalStreamRef = useRef(localMedia.getStream);
  getLocalStreamRef.current = localMedia.getStream;

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

  // Cleanup on unmount: close the PC if still open.
  useEffect(() => {
    return () => {
      handleRef.current?.close();
      handleRef.current = null;
    };
  }, []);

  async function handleReadyForOffer(msg: ReadyForOfferMessage): Promise<void> {
    // Contract §3.7 validation (client): handle exactly once per
    // pairing attempt; ignore if arriving in any other state.
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
      ...(role === "answerer"
        ? {
            onDataChannel: (dc: RTCDataChannel) => {
              // Answerer: the offerer's pre-offer DataChannel has
              // arrived. Phase 7 only logs receipt; Phase 9 will
              // wire `onmessage` / `onopen` without another
              // negotiation round.
              dispatch({
                type: "EVENT_LOG_APPEND",
                entry: makeEventLogEntry({
                  type: "data_channel_created",
                  direction: "remote",
                  summary: `ondatachannel fired (label="${dc.label}", ordered=${dc.ordered})`,
                }),
              });
            },
          }
        : {}),
    });
    handleRef.current = handle;

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
        }),
      });
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

  const value: PeerConnectionContextValue = {
    getHandle: () => handleRef.current,
  };

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
