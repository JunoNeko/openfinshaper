// SPDX-License-Identifier: GPL-3.0-or-later
import { writeFinJson } from '@openshaper/io';
import { defaultFinDesign, defaultKeel } from '@openshaper/kernel';
import { describe, expect, it } from 'vitest';
import {
  finishFinRoundTrip,
  pendingFinEdit,
  startFinRoundTrip,
  takeFinResult,
} from './fin-handoff';

describe('the OpenFinShaper round trip', () => {
  it('hands a board fin to the designer, and its edit back once', () => {
    startFinRoundTrip(2, defaultKeel('left'), 'fin P3', 'My keel');
    const pending = pendingFinEdit()!;
    expect(pending.label).toBe('fin P3');
    expect(writeFinJson(pending.design)).toBe(writeFinJson(defaultKeel('left')));
    // Nothing for the board until the designer finishes.
    expect(takeFinResult()).toBeNull();
    startFinRoundTrip(2, defaultKeel('left'), 'fin P3', 'My keel');
    const edited = defaultFinDesign('side', 'left');
    finishFinRoundTrip(edited, 'My keel');
    expect(pendingFinEdit()).toBeNull();
    const back = takeFinResult()!;
    expect(back.finIndex).toBe(2);
    expect(back.name).toBe('My keel');
    expect(writeFinJson(back.design)).toBe(writeFinJson(edited));
    expect(takeFinResult()).toBeNull(); // once
  });

  it('cancel brings nothing back', () => {
    startFinRoundTrip(0, defaultKeel('left'), 'fin P1');
    finishFinRoundTrip(null);
    expect(takeFinResult()).toBeNull();
    expect(pendingFinEdit()).toBeNull();
  });

  it('survives a reload in the middle (kept in sessionStorage)', () => {
    startFinRoundTrip(1, defaultKeel('right'), 'fin S2');
    expect(JSON.parse(sessionStorage.getItem('bs.fin-handoff')!).finIndex).toBe(1);
    finishFinRoundTrip(null);
    takeFinResult();
    expect(sessionStorage.getItem('bs.fin-handoff')).toBeNull();
  });
});
