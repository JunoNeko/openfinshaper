// SPDX-License-Identifier: GPL-3.0-or-later
import { writeFinJson } from '@openshaper/io';
import { defaultCanard, defaultFinDesign, defaultKeel } from '@openshaper/kernel';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { lengthUnitByKey } from '../format';
import { PanelSetupDialog } from './PanelSetupDialog';

const mm = lengthUnitByKey('mm');

const makeFinFile = (name: string, design: ReturnType<typeof defaultFinDesign>): File => {
  const text = writeFinJson(design);
  const file = new File([text], name, { type: 'application/json' });
  // jsdom's File.text() helper polyfill if absent.
  if (!file.text) {
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(text) });
  }
  return file;
};

describe('PanelSetupDialog', () => {
  it('loads a folder of fin files, recommends a layout, warns on thick fins, and shows Save/Export', async () => {
    const onClose = vi.fn();
    render(
      <PanelSetupDialog
        units={mm}
        minThickness={0.05}
        currentDesign={defaultFinDesign('side', 'left')}
        onClose={onClose}
      />,
    );

    // Default mode is recommend-fill; set panel thickness to 9 mm so a canted keel is too thick.
    const thickness = screen.getByLabelText(/^Depth \(thickness\)/);
    fireEvent.change(thickness, { target: { value: '9' } });
    fireEvent.keyDown(thickness, { key: 'Enter' });

    const folderInput = screen.getByLabelText('Fin files folder') as HTMLInputElement;
    const thickKeel = makeFinFile('thick-keel.fin.json', { ...defaultKeel('left'), cant: 12 });
    const canard = makeFinFile('canard.fin.json', defaultCanard('left'));
    fireEvent.change(folderInput, { target: { files: [thickKeel, canard] } });

    await waitFor(() => {
      expect(screen.getByText(/thick-keel/)).toBeTruthy();
      expect(screen.getByText(/canard/)).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() => {
      expect(screen.getByRole('img', { name: /Panel layout/ })).toBeTruthy();
    });
    // Thick keel warning is shown; Save panel and Export STEP buttons are active.
    expect(screen.getByRole('alert').textContent).toMatch(/thick-keel.*needs/i);
    expect(
      (screen.getByRole('button', { name: 'Save panel (.finpanel.json)' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(
      (screen.getByRole('button', { name: 'Export STEP' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('calculates minimum panel size from a fin collection', async () => {
    render(
      <PanelSetupDialog
        units={mm}
        minThickness={0.05}
        currentDesign={defaultFinDesign('centre')}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByLabelText('Calculate panel size from fin collection'));
    fireEvent.click(screen.getByRole('button', { name: /Current fin/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() => {
      expect(screen.getByRole('img', { name: /Panel layout.*1 fins/ })).toBeTruthy();
    });
  });

  it('offers All pairs and Pairs + odd fins options in recommend mode', async () => {
    render(
      <PanelSetupDialog
        units={mm}
        minThickness={0.05}
        currentDesign={defaultFinDesign('side', 'left')}
        onClose={vi.fn()}
      />,
    );

    const allPairsRadio = screen.getByLabelText('All pairs') as HTMLInputElement;
    const pairsOddRadio = screen.getByLabelText('Pairs + odd fins') as HTMLInputElement;
    expect(allPairsRadio.checked).toBe(true);
    expect(pairsOddRadio.checked).toBe(false);

    fireEvent.click(pairsOddRadio);
    expect(pairsOddRadio.checked).toBe(true);

    // 320 × 200 mm panel fits a pair plus an odd fin.
    const length = screen.getByLabelText(/^Length/);
    fireEvent.change(length, { target: { value: '320' } });
    fireEvent.keyDown(length, { key: 'Enter' });
    const width = screen.getByLabelText(/^Width/);
    fireEvent.change(width, { target: { value: '200' } });
    fireEvent.keyDown(width, { key: 'Enter' });

    fireEvent.click(screen.getByRole('button', { name: /Current fin/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() => {
      expect(screen.getByRole('img', { name: /Panel layout/ })).toBeTruthy();
    });
  });
});
