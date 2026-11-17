// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { parseBrd } from '@openshaper/io';
import { createBoardStore } from '@openshaper/store';
import { FinPanel } from './FinPanel';
import { LENGTH_UNITS } from './format';

const golden = resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/specs/golden');
const shortboard = parseBrd(readFileSync(resolve(golden, 'shortboard.brd'), 'utf8')).board;
const mm = LENGTH_UNITS.find((u) => u.key === 'mm')!;

const open = (setup: 'thruster' | 'quad' = 'thruster') => {
  const store = createBoardStore();
  act(() => {
    store.getState().load(shortboard);
    store.getState().setFinSetup(setup);
  });
  render(<FinPanel store={store} units={mm} />);
  return store;
};

describe('<FinPanel /> fins from the library', () => {
  it('starts a setup with its first set at M, and applies a set at a size', () => {
    const store = open();
    expect(screen.getByText('Thruster M')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Choose fins' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Thruster L' }));
    expect(store.getState().board!.fins.fins.every((f) => f.library?.size === 'L')).toBe(true);
    expect(screen.getByText('Thruster L')).toBeTruthy();
  });

  it('changes one fin and its mirror: mix and match', () => {
    const store = open('quad');
    act(() => store.getState().selectFin(2));
    expect(screen.getByText('Quad rear M')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/its mirror partner/)).toBeTruthy();
    // Rears take rear fins only.
    expect(within(dialog).queryByRole('button', { name: 'Keel S' })).toBeNull();
    act(() => store.getState().selectFin(0));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Keel S' }));
    expect(store.getState().board!.fins.fins.map((f) => f.library?.fin)).toEqual(['keel', 'keel', 'quad-rear', 'quad-rear']); // prettier-ignore
    expect(screen.getByText('Mixed')).toBeTruthy();
  });

  it('asks FCS plug cants: front and rear on a quad, the centre fixed on a thruster', () => {
    const store = open('quad');
    act(() => store.getState().setFinSystem('futures'));
    expect(screen.queryByTitle('Front plugs')).toBeNull(); // Futures: no plugs
    act(() => store.getState().setFinSystem('fcs-ii'));
    fireEvent.change(screen.getByTitle('Rear plugs'), { target: { value: '9' } });
    expect(store.getState().board!.fins.plugCant).toEqual({ front: 5, rear: 9 });
    act(() => store.getState().setFinSetup('thruster'));
    expect(screen.getByTitle('Side plugs')).toBeTruthy();
    expect(screen.getByText('Centre plug 0°.')).toBeTruthy();
  });

  it('places the selected fin: from the tail, inset, toe; no shape fields', () => {
    const store = open();
    act(() => store.getState().selectFin(0));
    expect(screen.getByLabelText(/^Fin dot from tail/)).toBeTruthy();
    expect(screen.getByLabelText(/^Fin dot from rail/)).toBeTruthy();
    expect(screen.getByLabelText(/^Toe-in/)).toBeTruthy();
    expect(screen.queryByLabelText(/^Cant/)).toBeNull();
    expect(screen.queryByLabelText(/^Depth/)).toBeNull();
  });

  it('warns when a box comes near the rail', () => {
    const store = open();
    act(() => store.getState().selectFin(0));
    act(() => store.getState().updateFin(0, { insetFromRail: 0.5 }));
    expect(screen.getByRole('alert').textContent).toMatch(/mm (of|past) the rail/);
  });
});
