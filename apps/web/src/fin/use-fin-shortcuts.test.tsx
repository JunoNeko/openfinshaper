// SPDX-License-Identifier: GPL-3.0-or-later
import { defaultFinDesign } from '@openshaper/kernel';
import { createFinStore } from '@openshaper/store';
import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useFinShortcuts } from './use-fin-shortcuts';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('useFinShortcuts', () => {
  it('stays quiet while a [data-modal] dialog is open', () => {
    const store = createFinStore();
    store.getState().load(defaultFinDesign('side', 'left'));
    store.getState().setCant(10);
    const onSave = vi.fn();
    renderHook(() => useFinShortcuts(store, { onSave }));

    const modal = document.createElement('div');
    modal.dataset.modal = 'fin-settings';
    document.body.appendChild(modal);

    const before = store.getState().design;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true }));

    expect(store.getState().design).toBe(before);
    expect(onSave).not.toHaveBeenCalled();

    // Closing the modal restores shortcuts.
    modal.remove();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true }));
    expect(onSave).toHaveBeenCalledOnce();
  });
});
