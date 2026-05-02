// Mesh signaling provider — owns the `MeshSignalingClient` instance,
// subscribes its inbound + transport observers to the mesh dispatcher /
// local reducer, and exposes the client to descendants.
//
// One client per `MeshApp` mount. Tests inject a mock client via the
// optional `client` prop so the provider can run without opening real
// sockets.

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { createMeshDispatcher } from "./dispatcher";
import {
  createMeshSignalingClient,
  type MeshSignalingClient,
  type MeshTransportState,
} from "./client";
import { useMeshDispatch, useMeshState } from "../state";
import { makeMeshEventEntry, type MeshEventType } from "../state/eventLog";
import {
  createMeshPairManager,
  type MeshPairManager,
} from "../webrtc/pairManager";
import { subscribeLocalStream } from "../webrtc/mediaAcquisition";

const MeshSignalingContext = createContext<MeshSignalingClient | null>(null);
const MeshPairManagerContext = createContext<MeshPairManager | null>(null);

function transportToEventType(transport: MeshTransportState): MeshEventType {
  switch (transport) {
    case "open":
      return "signaling_connected";
    case "connecting":
      return "signaling_connecting";
    case "error":
      return "signaling_error";
    default:
      return "signaling_disconnected";
  }
}

export interface MeshSignalingProviderProps {
  children: ReactNode;
  // Optional injected client (tests). Defaults to a fresh real client.
  client?: MeshSignalingClient;
}

export function MeshSignalingProvider({
  children,
  client: injected,
}: MeshSignalingProviderProps) {
  const clientRef = useRef<MeshSignalingClient | null>(null);
  if (clientRef.current === null) {
    clientRef.current = injected ?? createMeshSignalingClient();
  }
  const client = clientRef.current;
  const dispatch = useMeshDispatch();
  const state = useMeshState();
  const stateRef = useRef(state);
  stateRef.current = state;

  // PairManager — created lazily on the first pair_negotiation_instruction
  // (it needs the localPeerId + room context which only exist after
  // join_accepted). The factory is rebuilt if peerId/roomId change.
  const pairManagerRef = useRef<MeshPairManager | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  useEffect(() => {
    return subscribeLocalStream((s) => {
      localStreamRef.current = s;
    });
  }, []);

  function ensurePairManager(): MeshPairManager | null {
    if (pairManagerRef.current) return pairManagerRef.current;
    const localPeerId = stateRef.current.local.peerId;
    const roomId = stateRef.current.local.roomId;
    if (!localPeerId || !roomId) return null;
    const stream = localStreamRef.current;
    if (!stream) return null;
    pairManagerRef.current = createMeshPairManager({
      roomId,
      localPeerId,
      dispatch,
      send: (m) => client.send(m),
      mediaSource: {
        getTracks: () => {
          const s = localStreamRef.current;
          return s ? s.getTracks() : [];
        },
        getStream: () => localStreamRef.current,
      },
      peerConnectionFactory: (cfg) => new RTCPeerConnection(cfg),
    });
    return pairManagerRef.current;
  }

  const dispatcher = useMemo(
    () =>
      createMeshDispatcher({
        dispatch,
        client,
        getSelfPeerId: () => stateRef.current.local.peerId,
        getRosterServerSeq: () => stateRef.current.roster.serverSeq,
        getLocalFsm: () => stateRef.current.local.fsm,
        getPairManager: () => ensurePairManager(),
      }),
    // Including dispatch/client in deps is enough — ensurePairManager
    // closes over refs and is stable across renders by reading them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dispatch, client],
  );

  useEffect(() => {
    const offMessage = client.onMessage((raw) => dispatcher(raw));
    const offTransport = client.onTransportChange((transport) => {
      // Capture mid-session snapshot BEFORE the transport-changed
      // action mutates fsm — so we can decide whether the drop should
      // surface as a Path D signaling-error entry.
      const before = stateRef.current.local.fsm;
      const wasMidSession =
        before !== "idle" &&
        before !== "left" &&
        before !== "leaving" &&
        before !== "signaling-error";
      dispatch({ type: "MESH_TRANSPORT_CHANGED", transport });
      dispatch({
        type: "MESH_EVENT_APPEND",
        entry: makeMeshEventEntry({
          scope: "room",
          type: transportToEventType(transport),
          summary: `mesh signaling ${transport}`,
        }),
      });
      // M12 / T091 (Path D / SC-005b) — emit one local-scoped
      // `signaling_error` entry when the transport drops mid-session.
      // The reducer simultaneously walks fsm → signaling-error so the
      // banner appears on the next render. Do NOT auto-reconnect.
      if ((transport === "closed" || transport === "error") && wasMidSession) {
        dispatch({
          type: "MESH_EVENT_APPEND",
          entry: makeMeshEventEntry({
            scope: "local",
            type: "signaling_error",
            summary: "signaling error: mesh /ws/mesh transport lost",
            detail: { transport, previousFsm: before },
          }),
        });
      }
    });
    return () => {
      offMessage();
      offTransport();
    };
  }, [client, dispatch, dispatcher]);

  // Tear down the socket on unmount so navigating away from `/mesh/*`
  // releases the slot. Best-effort `leave_room` send is owned by the
  // M11 cleanup path; M4/M5 just close the WS. M6 also closes any
  // open RTCPeerConnections so DTLS / STUN bindings drain.
  useEffect(() => {
    return () => {
      pairManagerRef.current?.closeAll();
      pairManagerRef.current = null;
      client.close();
    };
  }, [client]);

  return (
    <MeshSignalingContext.Provider value={client}>
      <MeshPairManagerContext.Provider value={pairManagerRef.current}>
        {children}
      </MeshPairManagerContext.Provider>
    </MeshSignalingContext.Provider>
  );
}

export function useMeshPairManager(): MeshPairManager | null {
  return useContext(MeshPairManagerContext);
}

export function useMeshSignalingClient(): MeshSignalingClient {
  const ctx = useContext(MeshSignalingContext);
  if (!ctx) {
    throw new Error(
      "useMeshSignalingClient must be used inside <MeshSignalingProvider>",
    );
  }
  return ctx;
}
