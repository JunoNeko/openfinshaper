// SPDX-License-Identifier: GPL-3.0-or-later
import { defaultFinDesign } from '@openshaper/kernel';
import { createFinStore } from '@openshaper/store';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useSettledDesign } from './use-settled-design';

describe('useSettledDesign', () => {
  it('freezes without re-rendering during a drag, and catches up on release', () => {
    const store = createFinStore();
    store.getState().load(defaultFinDesign('side', 'left'));
    let renders = 0;

    const { result } = renderHook(() => {
      renders += 1;
      return useSettledDesign(store);
    });
    const before = result.current;
    const rendersBeforeDrag = renders;

    act(() => {
      store.getState().beginEdit('Drag');
      store.getState().setCant(10);
      store.getState().setCant(12);
    });
    expect(store.getState().design).not.toBe(before);
    expect(result.current).toBe(before);
    expect(renders).toBe(rendersBeforeDrag);

    act(() => store.getState().endEdit());
    expect(result.current).toBe(store.getState().design);
    expect(renders).toBe(rendersBeforeDrag + 1);
  });

  it('updates immediately for non-drag commits', () => {
    const store = createFinStore();
    store.getState().load(defaultFinDesign('side', 'left'));
    const { result } = renderHook(() => useSettledDesign(store));
    const before = result.current;

    act(() => {
      store.getState().setCant(9);
    });
    expect(result.current).not.toBe(before);
    expect(result.current).toBe(store.getState().design);
  });
});
