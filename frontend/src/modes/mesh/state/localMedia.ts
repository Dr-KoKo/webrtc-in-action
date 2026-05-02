// Local media-state slice (M9 / data-model §B.1 supplement).
//
// Tracks the local participant's mic / camera / screen-share indicator
// state. These are participant-level values that the user toggles via
// MeshControls; on every change we (a) flip the matching local
// MediaStreamTrack `enabled` and (b) emit one `pair_media_state` to
// `/ws/mesh` (server fan-out — FR-032).
//
// Screen-share state is included for v2 contract triple parity, but
// M9 does NOT implement screen-share start/stop behavior — it stays
// `inactive` until M10 ships getDisplayMedia. The slice never exposes
// raw MediaStream payloads.

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
    case "MESH_LOCAL_MEDIA_RESET":
      return initialMeshLocalMediaSlice;
    default:
      return state;
  }
}
