// SPDX-License-Identifier: GPL-3.0-or-later
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useSyncedText } from './use-numeric-field';

describe('useSyncedText', () => {
  it('keeps typed text until the value behind it changes, then resets in the same render', () => {
    let renders = 0;
    const { result, rerender } = renderHook(
      ({ shown, key }: { shown: string; key?: unknown }) => {
        renders++;
        return useSyncedText(shown, key);
      },
      { initialProps: { shown: '1.00' } },
    );
    act(() => result.current[1]('1.5'));
    rerender({ shown: '1.00' });
    expect(result.current[0]).toBe('1.5');

    const before = renders;
    rerender({ shown: '2.00' });
    expect(result.current[0]).toBe('2.00');
    // The reset is a render-phase update: React re-runs the component once more
    // before committing, with no second commit from an effect.
    expect(renders - before).toBe(2);
  });

  it('resets on a sync-key change even when the display text is the same', () => {
    const { result, rerender } = renderHook(
      ({ shown, key }: { shown: string; key?: unknown }) => useSyncedText(shown, key),
      { initialProps: { shown: '1.00', key: 1.001 } },
    );
    act(() => result.current[1]('typed'));
    rerender({ shown: '1.00', key: 1.002 });
    expect(result.current[0]).toBe('1.00');
  });
});
