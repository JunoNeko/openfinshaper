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

const golden = resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/specs/golden');
const shortboard = () => parseBrd(readFileSync(resolve(golden, 'shortboard.brd'), 'utf8')).board;
const mm = LENGTH_UNITS.find((u) => u.key === 'mm')!;

const setup = () => {
  const store = createBoardStore();
  act(() => store.getState().load(shortboard()));
  render(<ChannelPanel store={store} units={mm} />);
  return store;
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

describe('<ChannelPanel />', () => {
  it('adds four channels that fit the board, one undo step', () => {
    const store = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Add channels' }));
    expect(params(store).count).toBe(4);
    expect(boardChannels(store.getState().board!)).toHaveLength(2);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(store.getState().past.map((h) => h.label)).toEqual(['Add channels']);
  });

  it('takes lengths in the chosen unit and recuts the channels', () => {
    const store = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Add channels' }));
    typeInto(/^Depth/, '3');
    expect(params(store).depth).toBeCloseTo(0.3, 9);
    fireEvent.change(screen.getByTitle('How many channels, across the whole board'), {
      target: { value: '5' },
    });
    expect(boardChannels(store.getState().board!)).toHaveLength(3);
    // An odd count starts on the stringer: no inner offset to set.
    expect((screen.getByLabelText(/^From stringer/) as HTMLInputElement).disabled).toBe(true);
  });

  it('asks for a size for bevelled and rounded walls', () => {
    const store = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Add channels' }));
    expect(screen.queryByLabelText(/^Radius/)).toBeNull();
    fireEvent.change(screen.getByTitle('How the bottom steps down into each channel'), {
      target: { value: 'round' },
    });
    typeInto(/^Radius/, '8');
    expect(params(store).wall).toEqual({ shape: 'round', radius: 0.8 });
  });

  it('says when they do not fit, and removes them', () => {
    const store = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Add channels' }));
    typeInto(/^Land/, '80');
    expect(screen.getByRole('alert').textContent).toMatch(/don't fit across the bottom/);
    fireEvent.click(screen.getByRole('button', { name: 'Remove channels' }));
    expect(store.getState().board!.channels).toBeUndefined();
    expect(screen.getByRole('button', { name: 'Add channels' })).toBeTruthy();
  });
});
