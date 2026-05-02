// React bindings for the mesh Zustand store (Phase F3 of the
// frontend rings refactor). The reducer lives in `./reducer.ts`; the
// store in `./store.ts`; this file is the thin React surface
// (StoreProvider + useMeshState/useMeshDispatch hooks).
//
// `useMeshState`/`useMeshDispatch` keep the public API stable so
// existing components don't need to change. F5's verb files reach
// the store directly via the runtime context (no React).

import {
  createContext,
  createElement,
  useContext,
  useState,
  type ReactNode,
} from "react";
import { useStoreWithEqualityFn } from "zustand/traditional";
import {
  createMeshStore,
  type MeshStore,
  type MeshStoreState,
} from "./store";
import {
  initialMeshRootState,
  type MeshRootAction,
  type MeshRootState,
} from "./reducer";

export {
  initialMeshRootState,
  meshRootReducer,
  type MeshRootAction,
  type MeshRootState,
} from "./reducer";
export { createMeshStore } from "./store";
export type { MeshStore, MeshStoreState } from "./store";

const MeshStoreContext = createContext<MeshStore | null>(null);

export interface MeshStoreProviderProps {
  children: ReactNode;
  initialState?: MeshRootState;
}

export function MeshStoreProvider({
  children,
  initialState = initialMeshRootState,
}: MeshStoreProviderProps) {
  const [store] = useState(() => createMeshStore(initialState));
  return createElement(
    MeshStoreContext.Provider,
    { value: store },
    children,
  );
}

function useStoreApi(): MeshStore {
  const store = useContext(MeshStoreContext);
  if (!store) {
    throw new Error(
      "useMeshStore must be used inside <MeshStoreProvider>",
    );
  }
  return store;
}

const meshRootSelector = (s: MeshStoreState): MeshRootState => ({
  local: s.local,
  roster: s.roster,
  eventLog: s.eventLog,
  pairs: s.pairs,
  chat: s.chat,
  localMedia: s.localMedia,
});

function meshRootEqual(a: MeshRootState, b: MeshRootState): boolean {
  return (
    a.local === b.local &&
    a.roster === b.roster &&
    a.eventLog === b.eventLog &&
    a.pairs === b.pairs &&
    a.chat === b.chat &&
    a.localMedia === b.localMedia
  );
}

export function useMeshState(): MeshRootState {
  const store = useStoreApi();
  return useStoreWithEqualityFn(store, meshRootSelector, meshRootEqual);
}

export function useMeshDispatch(): (action: MeshRootAction) => void {
  const store = useStoreApi();
  return store.getState().dispatch;
}

/**
 * Test/runtime escape hatch — gives F5's verb files (which run
 * outside React) direct access to the store without re-subscribing
 * via a hook. Components should prefer the hooks above.
 */
export function useMeshStoreApi(): MeshStore {
  return useStoreApi();
}
