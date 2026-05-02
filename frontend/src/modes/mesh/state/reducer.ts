// Mesh root reducer — composes the six M4–M8 slices (data-model §B):
// `LocalParticipant`, `Roster`, `EventLog`, `Pairs`, `Chat`,
// `LocalMedia`. Lives in its own file (Phase F3) so `state/store.ts`
// can wrap it without dragging React types into a node-test
// environment.

import {
  initialMeshLocalParticipant,
  meshLocalReducer,
  type MeshLocalAction,
  type MeshLocalParticipant,
} from "./local";
import {
  initialMeshRosterSlice,
  meshRosterReducer,
  type MeshRosterAction,
  type MeshRosterSlice,
} from "./roster";
import {
  initialMeshEventLogSlice,
  meshEventLogReducer,
  type MeshEventLogAction,
  type MeshEventLogSlice,
} from "./eventLog";
import {
  initialMeshPairsSlice,
  meshPairsReducer,
  type MeshPairsAction,
  type MeshPairsSlice,
} from "./pairs";
import {
  initialMeshChatSlice,
  meshChatReducer,
  type MeshChatAction,
  type MeshChatSlice,
} from "./chat";
import {
  initialMeshLocalMediaSlice,
  meshLocalMediaReducer,
  type MeshLocalMediaAction,
  type MeshLocalMediaSlice,
} from "./localMedia";

export interface MeshRootState {
  local: MeshLocalParticipant;
  roster: MeshRosterSlice;
  eventLog: MeshEventLogSlice;
  pairs: MeshPairsSlice;
  chat: MeshChatSlice;
  localMedia: MeshLocalMediaSlice;
}

export type MeshRootAction =
  | MeshLocalAction
  | MeshRosterAction
  | MeshEventLogAction
  | MeshPairsAction
  | MeshChatAction
  | MeshLocalMediaAction;

export const initialMeshRootState: MeshRootState = {
  local: initialMeshLocalParticipant,
  roster: initialMeshRosterSlice,
  eventLog: initialMeshEventLogSlice,
  pairs: initialMeshPairsSlice,
  chat: initialMeshChatSlice,
  localMedia: initialMeshLocalMediaSlice,
};

function isRosterAction(a: MeshRootAction): a is MeshRosterAction {
  return (
    a.type === "MESH_ROSTER_SNAPSHOT_APPLIED" ||
    a.type === "MESH_ROSTER_UPDATE_APPLIED" ||
    a.type === "MESH_REMOTE_MEDIA_STATE_APPLIED" ||
    a.type === "MESH_ROSTER_RESET"
  );
}

function isLocalMediaAction(a: MeshRootAction): a is MeshLocalMediaAction {
  return (
    a.type === "MESH_LOCAL_MEDIA_MIC_TOGGLED" ||
    a.type === "MESH_LOCAL_MEDIA_CAMERA_TOGGLED" ||
    a.type === "MESH_LOCAL_MEDIA_SCREEN_SHARE_STARTED" ||
    a.type === "MESH_LOCAL_MEDIA_SCREEN_SHARE_STOPPED" ||
    a.type === "MESH_LOCAL_MEDIA_RESET"
  );
}

function isEventLogAction(a: MeshRootAction): a is MeshEventLogAction {
  return a.type === "MESH_EVENT_APPEND" || a.type === "MESH_EVENT_LOG_RESET";
}

function isPairsAction(a: MeshRootAction): a is MeshPairsAction {
  return (
    a.type === "MESH_PAIR_REGISTERED" ||
    a.type === "MESH_PAIR_VIEW_PATCHED" ||
    a.type === "MESH_PAIR_REMOVED" ||
    a.type === "MESH_PAIRS_RESET"
  );
}

function isChatAction(a: MeshRootAction): a is MeshChatAction {
  return (
    a.type === "MESH_CHAT_LOCAL_APPENDED" ||
    a.type === "MESH_CHAT_INBOUND_APPENDED" ||
    a.type === "MESH_CHAT_VALIDATION_FAILED" ||
    a.type === "MESH_CHAT_VALIDATION_CLEARED" ||
    a.type === "MESH_CHAT_RESET"
  );
}

export function meshRootReducer(
  state: MeshRootState,
  action: MeshRootAction,
): MeshRootState {
  if (isRosterAction(action)) {
    return { ...state, roster: meshRosterReducer(state.roster, action) };
  }
  if (isEventLogAction(action)) {
    return {
      ...state,
      eventLog: meshEventLogReducer(state.eventLog, action),
    };
  }
  if (isPairsAction(action)) {
    return { ...state, pairs: meshPairsReducer(state.pairs, action) };
  }
  if (isChatAction(action)) {
    return { ...state, chat: meshChatReducer(state.chat, action) };
  }
  if (isLocalMediaAction(action)) {
    return {
      ...state,
      localMedia: meshLocalMediaReducer(state.localMedia, action),
    };
  }
  return { ...state, local: meshLocalReducer(state.local, action) };
}
