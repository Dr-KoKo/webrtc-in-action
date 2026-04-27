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

const MeshSignalingContext = createContext<MeshSignalingClient | null>(null);

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

  const dispatcher = useMemo(
    () =>
      createMeshDispatcher({
        dispatch,
        client,
        getSelfPeerId: () => stateRef.current.local.peerId,
        getRosterServerSeq: () => stateRef.current.roster.serverSeq,
        getLocalFsm: () => stateRef.current.local.fsm,
      }),
    [dispatch, client],
  );

  useEffect(() => {
    const offMessage = client.onMessage((raw) => dispatcher(raw));
    const offTransport = client.onTransportChange((transport) => {
      dispatch({ type: "MESH_TRANSPORT_CHANGED", transport });
      dispatch({
        type: "MESH_EVENT_APPEND",
        entry: makeMeshEventEntry({
          scope: "room",
          type: transportToEventType(transport),
          summary: `mesh signaling ${transport}`,
        }),
      });
    });
    return () => {
      offMessage();
      offTransport();
    };
  }, [client, dispatch, dispatcher]);

  // Tear down the socket on unmount so navigating away from `/mesh/*`
  // releases the slot. Best-effort `leave_room` send is owned by the
  // M11 cleanup path; M4/M5 just close the WS.
  useEffect(() => {
    return () => {
      client.close();
    };
  }, [client]);

  return (
    <MeshSignalingContext.Provider value={client}>
      {children}
    </MeshSignalingContext.Provider>
  );
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
