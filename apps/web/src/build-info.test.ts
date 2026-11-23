// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { BUILD_COMMIT, buildLabel } from './build-info';

describe('the build version', () => {
  it('reads "dev" where the build set none (tests)', () => {
    expect(BUILD_COMMIT).toBe('dev');
    expect(buildLabel()).toBe('dev');
  });

  it('shows the commit and the day it was built', () => {
    const label = buildLabel('b4350b6', '2026-11-23T10:57:00.000Z');
    expect(label.startsWith('b4350b6 · ')).toBe(true);
    expect(label).toMatch(/2026/);
  });
});
