// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { boardChannels } from '@openshaper/kernel';
import { parseBrd } from '@openshaper/io';
import { createBoardStore } from '@openshaper/store';
import { ChannelPanel } from './ChannelPanel';
import { LENGTH_UNITS } from './format';
import { longitudinalFor } from './longitudinal';

const golden = resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/specs/golden');
const shortboard = () => parseBrd(readFileSync(resolve(golden, 'shortboard.brd'), 'utf8')).board;
const mm = LENGTH_UNITS.find((u) => u.key === 'mm')!;

const setup = (index = 2) => {
  const store = createBoardStore();
  act(() => store.getState().load(shortboard()));
  const picked: number[] = [];
  const longitudinal = longitudinalFor(null, 'x-axis');
  const view = render(
    <ChannelPanel
      store={store}
      units={mm}
      longitudinal={longitudinal}
      section={{ index, onSelect: (i) => picked.push(i) }}
    />,
  );
  return { store, picked, view, longitudinal };
};
const params = (store: ReturnType<typeof createBoardStore>) => {
  const c = store.getState().board!.channels;
  if (c?.from !== 'numbers') throw new Error('no typed-in channels');
  return c.params;
};
const typeInto = (label: RegExp, text: string) => {
  const field = screen.getByLabelText(label);
  fireEvent.change(field, { target: { value: text } });
  fireEvent.blur(field);
};
const add = () => fireEvent.click(screen.getByRole('button', { name: 'Add channels' }));

describe('<ChannelPanel />', () => {
  it('adds four channels deepest at the selected cross-section, one undo step', () => {
    const { store } = setup();
    add();
    const b = store.getState().board!;
    expect(params(store).count).toBe(4);
    expect(params(store).deepest).toBe(b.crossSections[2]!.position);
    expect(boardChannels(b)).toHaveLength(2);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(store.getState().past.map((h) => h.label)).toEqual(['Add channels']);
  });

  it('takes lengths in the chosen unit and recuts the channels', () => {
    const { store } = setup();
    add();
    typeInto(/^Depth/, '3');
    expect(params(store).depth).toBeCloseTo(0.3, 9);
    typeInto(/^Width/, '40');
    expect(params(store).width).toBeCloseTo(4, 9);
    fireEvent.change(screen.getByTitle('How many channels, across the whole board'), {
      target: { value: '5' },
    });
    expect(boardChannels(store.getState().board!)).toHaveLength(3);
    // An odd count starts on the stringer: no offset to set.
    expect((screen.getByLabelText(/^Stringer offset/) as HTMLInputElement).disabled).toBe(true);
  });

  it("sets a step's two radii, and has none for a wave", () => {
    const { store } = setup();
    add();
    typeInto(/^Radius top/, '2');
    typeInto(/^Radius bottom/, '1');
    expect(params(store).wall).toEqual({ shape: 'step', radius: 0.2, lip: 0.1 });
    fireEvent.click(screen.getByRole('radio', { name: 'Wave' }));
    expect(params(store).wall).toEqual({ shape: 'wave' });
    expect((screen.getByLabelText(/^Radius top/) as HTMLInputElement).disabled).toBe(true);
    // Back to a step: a wave had no radii to keep, so a fresh one.
    fireEvent.click(screen.getByRole('radio', { name: 'Step' }));
    expect(params(store).wall).toEqual({ shape: 'step', radius: 0, lip: 0.5 });
  });

  it('moves the ends and the blend with the keyboard, one undo step a press', () => {
    const { store } = setup();
    add();
    const before = params(store);
    fireEvent.keyDown(screen.getByRole('slider', { name: 'End' }), { key: 'ArrowLeft' });
    expect(params(store).end).toBeLessThan(before.end);
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Follow the rail' }), { key: 'ArrowLeft', shiftKey: true }); // prettier-ignore
    expect(params(store).follow).toBeCloseTo(Math.max(0, before.follow - 0.05), 9);
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Tail blend' }), { key: 'ArrowLeft' });
    expect(params(store).fadeTail).toBeLessThan(before.fadeTail);
    expect(store.getState().past.map((h) => h.label)).toEqual([
      'Add channels',
      'Edit channels',
      'Edit channels',
      'Edit channels',
    ]);
  });

  it('snaps the deepest point to a cross-section and selects it', () => {
    const { store, picked } = setup();
    add();
    const b = store.getState().board!;
    const deepest = screen.getByRole('slider', { name: 'Deepest point' });
    // Far toward the nose: the last real cross-section.
    for (let i = 0; i < 40; i++) fireEvent.keyDown(deepest, { key: 'ArrowRight' });
    const last = b.crossSections.length - 2;
    expect(params(store).deepest).toBe(b.crossSections[last]!.position);
    expect(picked.at(-1)).toBe(last);
    // Past where they ended: the end moved out to keep it inside them.
    expect(params(store).end).toBeGreaterThanOrEqual(params(store).deepest);
  });

  it('offers to move the deepest point to the cross-section on show', () => {
    const { store, view, longitudinal } = setup();
    add();
    view.rerender(
      <ChannelPanel
        store={store}
        units={mm}
        longitudinal={longitudinal}
        section={{ index: 1, onSelect: () => {} }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Deepest at cross-section 1' }));
    expect(params(store).deepest).toBe(store.getState().board!.crossSections[1]!.position);
  });

  it('says what is wrong, and removes them', () => {
    const { store } = setup();
    add();
    typeInto(/^Width/, '200');
    expect(screen.getByRole('alert').textContent).toMatch(/runs off the bottom/);
    fireEvent.click(screen.getByRole('button', { name: 'Remove channels' }));
    expect(store.getState().board!.channels).toBeUndefined();
    expect(screen.getByRole('button', { name: 'Add channels' })).toBeTruthy();
  });
});
