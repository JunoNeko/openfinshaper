// SPDX-License-Identifier: GPL-3.0-or-later
import { defaultFinDesign } from '@openshaper/kernel';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LENGTH_UNITS } from '../format';
import { FlexAnalysisDialog } from './FlexAnalysisDialog';
import { finStore } from './fin-store';

const mm = LENGTH_UNITS.find((u) => u.key === 'mm')!;

describe('<FlexAnalysisDialog />', () => {
  it('renders 4-step workflow, kg / 10 mm bend* readouts, reference chart, and flex heatmap', () => {
    const fin = defaultFinDesign('side', 'left');
    act(() => finStore.getState().load(fin));
    render(<FlexAnalysisDialog design={fin} units={mm} onClose={() => {}} />);

    expect(screen.getByText(/Flex \/ stiffness analysis and control/)).toBeTruthy();
    expect(screen.getByText(/kg \/ 10 mm bend\*/)).toBeTruthy();
    expect(screen.getByText(/Lab bench measurement:/)).toBeTruthy();
    expect(screen.getByRole('img', { name: /Fin flex heatmap/ })).toBeTruthy();
    expect(screen.queryByRole('img', { name: /Directional stiffness polar plot/ })).toBeNull();

    // Open surfer weight / power reference chart.
    fireEvent.click(screen.getByRole('button', { name: /Surfer weight \/ power reference chart/ }));
    expect(screen.getByText(/Heavy \(~85–100\+ kg\)/)).toBeTruthy();
  });

  it('shows the conditional optimal weave box only when Recommend is selected and applies it', () => {
    const fin = defaultFinDesign('side', 'left');
    act(() => finStore.getState().load(fin));
    render(<FlexAnalysisDialog design={fin} units={mm} onClose={() => {}} />);

    expect(screen.queryByText(/Optimal weave angle for target stiffness/)).toBeNull();

    fireEvent.click(screen.getByRole('radio', { name: 'Recommend' }));
    expect(screen.getByText(/Optimal weave angle for target stiffness/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(screen.getByRole('status').textContent).toMatch(/Saved .* G10 weave angle/);
  });

  it('switches between Current fin and Tuned preview, and applies tuned taper cleanly', () => {
    const fin = defaultFinDesign('side', 'left');
    act(() => finStore.getState().load(fin));
    const beforeRoot = fin.taper.knots[0]!.end.y;

    render(<FlexAnalysisDialog design={fin} units={mm} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Current fin' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Tuned preview' }));
    fireEvent.click(screen.getByRole('radio', { name: '45°' }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply tuned taper' }));

    const after = finStore.getState().design!;
    expect(Math.abs(after.weaveAngle ?? 0)).toBe(45);
    expect(after.taper.knots[0]!.end.y).not.toBeCloseTo(beforeRoot, 4);
  });

  it('supports 3D-printed CF filaments (PPA-CF, PPS-CF, PET-CF) without weave-angle controls', () => {
    const fin = defaultFinDesign('side', 'left');
    act(() => finStore.getState().load(fin));
    render(<FlexAnalysisDialog design={fin} units={mm} onClose={() => {}} />);

    const select = screen.getByLabelText('Laminate material');
    fireEvent.change(select, { target: { value: 'ppa-cf' } });
    expect(screen.getByText(/Chopped-CF 3D-printed filament is quasi-isotropic/)).toBeTruthy();
    expect(screen.queryByRole('radiogroup', { name: 'Weave angle' })).toBeNull();
  });
});
