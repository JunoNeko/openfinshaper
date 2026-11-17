// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The OpenFinShaper round trip (fin integration, phase 2): the board editor hands a fin
 * to the fin designer, which hands it back.
 *
 * 1. The board's fin chooser starts it: the fin (its `.fin.json` text), which of the
 *    board's fins it is for, and its name. Then it goes to /fin.
 * 2. The designer sees a fin is waiting, opens it, and offers Apply to board and
 *    Cancel. Either finishes it; Apply leaves the edited fin as the result.
 * 3. Back on /app, the editor takes the result and puts it on the board.
 *
 * The two pages are one app, so the handoff lives in memory; it is also kept in
 * sessionStorage, so a reload in the middle loses nothing. Fins travel as text, as
 * files and the autosave keep them.
 */
import { readFinJson, writeFinJson } from '@openshaper/io';
import type { FinDesign } from '@openshaper/kernel';

const KEY = 'bs.fin-handoff';

interface Handoff {
  /** Which of the board's fins the fin is for. */
  readonly finIndex: number;
  /** What the board calls the fin, for the designer's banner: "P1 (Port)". */
  readonly label: string;
  /** Its name in My fins, if it has one. */
  readonly name?: string;
  readonly finJson: string;
  /** Set when the designer finishes: the fin to apply, or null for Cancel. */
  readonly result?: string | null;
}

const isHandoff = (v: unknown): v is Handoff =>
  !!v &&
  typeof v === 'object' &&
  typeof (v as Handoff).finIndex === 'number' &&
  typeof (v as Handoff).label === 'string' &&
  typeof (v as Handoff).finJson === 'string';

let current: Handoff | null = null;
let loaded = false;

const session = (): Storage | undefined => {
  try {
    return typeof sessionStorage === 'undefined' ? undefined : sessionStorage;
  } catch {
    return undefined;
  }
};

const read = (): Handoff | null => {
  if (!loaded) {
    loaded = true;
    try {
      const raw = session()?.getItem(KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      current = isHandoff(parsed) ? parsed : null;
    } catch {
      current = null;
    }
  }
  return current;
};

const write = (h: Handoff | null) => {
  current = h;
  loaded = true;
  try {
    if (h) session()?.setItem(KEY, JSON.stringify(h));
    else session()?.removeItem(KEY);
  } catch {
    // Storage refused: the handoff still holds in memory for this visit.
  }
};

/** Hand board fin `finIndex`'s design to the designer. The caller then goes to /fin. */
export const startFinRoundTrip = (
  finIndex: number,
  design: FinDesign,
  label: string,
  name?: string,
): void =>
  // prettier-ignore
  write({ finIndex, label, ...(name ? { name } : {}), finJson: writeFinJson(design) });

/** The fin waiting for the designer, if the round trip is under way (not yet finished). */
export const pendingFinEdit = (): { design: FinDesign; label: string; name?: string } | null => {
  const h = read();
  if (!h || h.result !== undefined) return null;
  try {
    return { design: readFinJson(h.finJson).design, label: h.label, ...(h.name ? { name: h.name } : {}) }; // prettier-ignore
  } catch {
    write(null);
    return null;
  }
};

/** The designer's end of it: the fin to apply (and its name), or null to cancel. */
export const finishFinRoundTrip = (design: FinDesign | null, name?: string): void => {
  const h = read();
  if (h) write({ ...h, ...(name ? { name } : {}), result: design ? writeFinJson(design) : null }); // prettier-ignore
};

/** The editor's end of it: the fin to put on the board, once, or null. */
export const takeFinResult = (): { finIndex: number; design: FinDesign; name?: string } | null => {
  const h = read();
  if (!h || h.result === undefined) return null;
  write(null);
  if (h.result === null) return null;
  try {
    return { finIndex: h.finIndex, design: readFinJson(h.result).design, ...(h.name ? { name: h.name } : {}) }; // prettier-ignore
  } catch {
    return null;
  }
};
