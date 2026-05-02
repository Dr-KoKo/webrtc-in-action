// Zustand store for the mesh mode (Phase F3 of the frontend rings
// refactor — `specs/frontend-architecture.md` §3.4).
//
// Replaces the previous `useReducer` + Context. The per-slice reducer
// functions stay as the authoritative state-transition logic; the
// store wraps `meshRootReducer` and exposes `dispatch` as the verb
// that runs an action through the reducer. This keeps every existing
// callsite working unchanged AND gives Phase F5's verb files (which
// run outside React) `store.getState()` access without ref-mirroring.

import { createStore, type StoreApi } from "zustand/vanilla";
import {
  initialMeshRootState,
  meshRootReducer,
  type MeshRootAction,
  type MeshRootState,
} from "./reducer";

export interface MeshStoreState extends MeshRootState {
  dispatch(action: MeshRootAction): void;
}

export type MeshStore = StoreApi<MeshStoreState>;

export function createMeshStore(
  initialState: MeshRootState = initialMeshRootState,
): MeshStore {
  return createStore<MeshStoreState>((set, get) => ({
    ...initialState,
    dispatch: (action) => {
      const next = meshRootReducer(get(), action);
      set(next);
    },
  }));
}
