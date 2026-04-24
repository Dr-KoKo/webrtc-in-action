// Media slice — Phase 10 (T072 / T073, contract §3.11, FR-014a).
//
// Mirrors the mic / camera / screen-share triplet we have announced
// locally (`local`) and the last triplet we have received from the
// remote peer (`remote`). Remote UI updates are driven exclusively by
// inbound `media_state` messages — never inferred from whether media
// packets keep flowing (constitution Principle IX + research §4).
//
// Toggling a track in Phase 10 flips `track.enabled` only, which does
// NOT trigger SDP renegotiation; the slice simply records the new
// triplet so the UI can render the right icon state and the dispatcher
// can log inbound changes.

export type MediaTriplet = {
  readonly microphone: "on" | "off";
  readonly camera: "on" | "off";
  readonly screenShare: "active" | "inactive";
};

export type MediaKind = "microphone" | "camera";

export const defaultLocalMediaTriplet: MediaTriplet = {
  microphone: "on",
  camera: "on",
  screenShare: "inactive",
};

export interface MediaSlice {
  readonly local: MediaTriplet;
  readonly remote: MediaTriplet | null;
}

export const initialMediaSlice: MediaSlice = {
  local: defaultLocalMediaTriplet,
  remote: null,
};

export type MediaAction =
  | { type: "LOCAL_MEDIA_STATE_SET"; triplet: MediaTriplet }
  | { type: "REMOTE_MEDIA_STATE_RECEIVED"; triplet: MediaTriplet }
  | { type: "MEDIA_STATE_RESET" };

export function mediaReducer(
  state: MediaSlice,
  action: MediaAction,
): MediaSlice {
  switch (action.type) {
    case "LOCAL_MEDIA_STATE_SET":
      if (tripletsEqual(state.local, action.triplet)) return state;
      return { ...state, local: action.triplet };
    case "REMOTE_MEDIA_STATE_RECEIVED":
      if (state.remote && tripletsEqual(state.remote, action.triplet)) {
        return state;
      }
      return { ...state, remote: action.triplet };
    case "MEDIA_STATE_RESET":
      return initialMediaSlice;
    default: {
      const _exhaustive: never = action;
      void _exhaustive;
      return state;
    }
  }
}

export function tripletsEqual(a: MediaTriplet, b: MediaTriplet): boolean {
  return (
    a.microphone === b.microphone &&
    a.camera === b.camera &&
    a.screenShare === b.screenShare
  );
}
