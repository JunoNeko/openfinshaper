// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The shortcut table drives the live key handler, the docs page and the tooltips,
 * so a mistake here is a mistake in all three. These pin the chord-matching rules
 * that are easy to get subtly wrong.
 */
import { describe, expect, it } from 'vitest';
import { matches, SHORTCUTS, shortcutKeys, type Shortcut } from './shortcuts';

const byId = (id: string): Shortcut => {
  const s = SHORTCUTS.find((x) => x.id === id);
  if (!s) throw new Error(`missing shortcut ${id}`);
  return s;
};

/** Minimal stand-in for the fields `matches` reads. */
const key = (k: string, mods: { mod?: boolean; shift?: boolean } = {}) =>
  ({
    key: k,
    ctrlKey: mods.mod ?? false,
    metaKey: false,
    shiftKey: mods.shift ?? false,
  }) as KeyboardEvent;

describe('matches', () => {
  it('matches a modifier chord', () => {
    expect(matches(byId('undo'), key('z', { mod: true }), false)).toBe(true);
  });

  it('does not fire a modifier chord without the modifier', () => {
    expect(matches(byId('undo'), key('z'), false)).toBe(false);
  });

  // The one that bites: ⌘Z and ⇧⌘Z must not both fire.
  it('separates undo from redo by Shift', () => {
    const withShift = key('z', { mod: true, shift: true });
    expect(matches(byId('undo'), withShift, false)).toBe(false);
    expect(matches(byId('redo'), withShift, false)).toBe(true);

    const noShift = key('z', { mod: true });
    expect(matches(byId('undo'), noShift, false)).toBe(true);
    expect(matches(byId('redo'), noShift, false)).toBe(false);
  });

  it('accepts either key of an either/or binding', () => {
    expect(matches(byId('delete-point'), key('Delete'), false)).toBe(true);
    expect(matches(byId('delete-point'), key('Backspace'), false)).toBe(true);
  });

  // Pressing Delete in a text field must not delete the selected control point.
  it('suppresses unmodified bindings while a field has focus', () => {
    expect(matches(byId('delete-point'), key('Delete'), false)).toBe(true);
    expect(matches(byId('delete-point'), key('Delete'), true)).toBe(false);
  });

  // ...but Save should still work from inside a text field.
  it('allows modifier chords while a field has focus', () => {
    expect(matches(byId('save'), key('s', { mod: true }), true)).toBe(true);
  });

  it('is case-insensitive on letter keys', () => {
    expect(matches(byId('save'), key('S', { mod: true }), false)).toBe(true);
  });

  // Exactly one shortcut may claim a given event, or `find` picks arbitrarily.
  it('has no two shortcuts matching the same event', () => {
    const events = [
      key('z', { mod: true }),
      key('z', { mod: true, shift: true }),
      key('y', { mod: true }),
      key('s', { mod: true }),
      key('k', { mod: true }),
      key('['),
      key(']'),
      key('1'),
      key('Delete'),
      key('l'),
    ];
    for (const e of events) {
      const hits = SHORTCUTS.filter((s) => matches(s, e, false));
      expect(hits.length, `"${e.key}" matched ${hits.map((h) => h.id).join(', ')}`).toBeLessThan(2);
    }
  });
});

describe('the table itself', () => {
  it('has unique ids', () => {
    const ids = SHORTCUTS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('exposes display chords by id, and rejects unknown ids', () => {
    expect(shortcutKeys('save')).toBe('⌘S');
    expect(() => shortcutKeys('nope')).toThrow(/Unknown shortcut/);
  });
});
