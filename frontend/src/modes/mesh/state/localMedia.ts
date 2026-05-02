// Local media-state slice (M9 / data-model §B.1 supplement; M10 adds
// screen-share transitions).
//
// Tracks the local participant's mic / camera / screen-share indicator
// state. These are participant-level values that the user toggles via
// MeshControls; on every change we (a) flip the matching local
// MediaStreamTrack `enabled` (mic / camera) or run replaceTrack across
// every active outbound video sender (screen share, M10), and (b) emit
// one `pair_media_state` to `/ws/mesh` (server fan-out — FR-032).
//
// Screen-share is participant-level, never room-level (FR-041): there
// is no `currentSharer`, no mutex, and no `screen_share_busy`. Multiple
// participants may share concurrently. The slice never exposes raw
// MediaStream payloads.

import type {
  CameraState,
  MicState,
  ScreenShareState,
} from "../signaling/schema";

export type LocalMicState = MicState; // "on" | "off"
export type LocalCameraState = CameraState; // "on" | "off"
export type LocalScreenShareState = ScreenShareState; // "active" | "inactive"

export interface MeshLocalMediaSlice {
  readonly microphone: LocalMicState;
  readonly camera: LocalCameraState;
  readonly screenShare: LocalScreenShareState;
}

export const initialMeshLocalMediaSlice: MeshLocalMediaSlice = {
  microphone: "on",
  camera: "on",
  screenShare: "inactive",
};

export type MeshLocalMediaAction =
  | { type: "MESH_LOCAL_MEDIA_MIC_TOGGLED"; next: LocalMicState }
  | { type: "MESH_LOCAL_MEDIA_CAMERA_TOGGLED"; next: LocalCameraState }
  | { type: "MESH_LOCAL_MEDIA_SCREEN_SHARE_STARTED" }
  | { type: "MESH_LOCAL_MEDIA_SCREEN_SHARE_STOPPED" }
  | { type: "MESH_LOCAL_MEDIA_RESET" };

export function meshLocalMediaReducer(
  state: MeshLocalMediaSlice,
  action: MeshLocalMediaAction,
): MeshLocalMediaSlice {
  switch (action.type) {
    case "MESH_LOCAL_MEDIA_MIC_TOGGLED": {
      if (state.microphone === action.next) return state;
      return { ...state, microphone: action.next };
    }
    case "MESH_LOCAL_MEDIA_CAMERA_TOGGLED": {
      if (state.camera === action.next) return state;
      return { ...state, camera: action.next };
    }
    case "MESH_LOCAL_MEDIA_SCREEN_SHARE_STARTED": {
      if (state.screenShare === "active") return state;
      return { ...state, screenShare: "active" };
    }
    case "MESH_LOCAL_MEDIA_SCREEN_SHARE_STOPPED": {
      if (state.screenShare === "inactive") return state;
      return { ...state, screenShare: "inactive" };
    }
    case "MESH_LOCAL_MEDIA_RESET":
      return initialMeshLocalMediaSlice;
    default:
      return state;
  }
}
