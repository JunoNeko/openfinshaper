// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The design as of the last finished edit: during a drag it holds the design from
 * before the drag, and catches up on release without re-rendering consumers mid-drag.
 * The 3D preview and panel fit read this, so a drag rebuilds the mesh once, not on
 * every pointer move.
 */
import type { FinDesign } from '@openshaper/kernel';
import type { FinState } from '@openshaper/store';
import { useCallback, useRef, useSyncExternalStore } from 'react';
import type { StoreApi } from 'zustand/vanilla';

export function useSettledDesign(store: StoreApi<FinState>): FinDesign | null {
  const storeRef = useRef(store);
  const settled = useRef<FinDesign | null>(store.getState().design);
  if (storeRef.current !== store) {
    storeRef.current = store;
    settled.current = store.getState().design;
  }
  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      store.subscribe((s) => {
        if (s.editing) return;
        if (s.design !== settled.current) {
          settled.current = s.design;
          onStoreChange();
        }
      }),
    [store],
  );
  const getSnapshot = () => {
    const s = store.getState();
    if (!s.editing) settled.current = s.design;
    return settled.current;
  };
  return useSyncExternalStore(subscribe, getSnapshot, () => store.getState().design);
}
