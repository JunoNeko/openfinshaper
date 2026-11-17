// SPDX-License-Identifier: GPL-3.0-or-later
import { writeFinJson } from '@openshaper/io';
import { defaultFinDesign, defaultKeel } from '@openshaper/kernel';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { startFinRoundTrip, takeFinResult } from '../fin-handoff';
import { FinApp } from './FinApp';

vi.mock('@openshaper/render3d', () => ({ FinPreview3D: () => null }));
import { finStore } from './fin-store';

const own = defaultFinDesign('quad-rear', 'left');
beforeEach(() => {
  act(() => finStore.getState().load(own));
});

const open = () =>
  render(
    <MemoryRouter initialEntries={['/fin']}>
      <Routes>
        <Route path="/fin" element={<FinApp />} />
        <Route path="/app" element={<p>The board</p>} />
      </Routes>
    </MemoryRouter>,
  );

describe('OpenFinShaper, designing a fin for a board', () => {
  it("opens the board's fin, and Apply takes the edit back; the designer's own fin returns", () => {
    startFinRoundTrip(1, defaultKeel('right'), 'fin S2 (starboard side)', 'Keel');
    open();
    expect(screen.getByRole('region', { name: 'Fin for your board' }).textContent).toMatch(
      /fin S2/,
    );
    expect(writeFinJson(finStore.getState().design!)).toBe(writeFinJson(defaultKeel('right')));
    act(() => finStore.getState().setCant(3));
    const edited = finStore.getState().design!;
    fireEvent.click(screen.getByRole('button', { name: 'Apply to board' }));
    expect(screen.getByText('The board')).toBeTruthy();
    const back = takeFinResult()!;
    expect(back.finIndex).toBe(1);
    expect(writeFinJson(back.design)).toBe(writeFinJson(edited));
    // The fin the designer had open before is back.
    expect(writeFinJson(finStore.getState().design!)).toBe(writeFinJson(own));
  });

  it('Cancel brings nothing back', () => {
    startFinRoundTrip(0, defaultKeel('left'), 'fin P1');
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('The board')).toBeTruthy();
    expect(takeFinResult()).toBeNull();
  });

  it('opened on its own, it has no banner, and offers Add to My fins', () => {
    open();
    expect(screen.queryByRole('region', { name: 'Fin for your board' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Add to My fins' })).toBeTruthy();
  });
});
