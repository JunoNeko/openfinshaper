// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The designer's side of the OpenFinShaper round trip (fin integration, phase 2;
 * fin-handoff.ts): a fin from a board is open, and this banner says which, with
 * **Apply to board** and **Cancel**. Either finishes the trip, puts back the fin the
 * designer had open before (its own autosave was paused meanwhile) and returns to the
 * board, which takes the applied fin.
 *
 * Also **Add to My fins**, for anyone: the fin open now, into the library the board's
 * fin chooser lists (my-fins.ts).
 */
import type { FinDesign } from '@openshaper/kernel';
import type { FinState } from '@openshaper/store';
import { Button } from '@openshaper/ui';
import { useEffect, useRef, useState } from 'react';
import type { StoreApi } from 'zustand/vanilla';
import { finishFinRoundTrip, pendingFinEdit } from '../fin-handoff';
import { addMyFin, defaultFinName } from '../my-fins';
import { useGo } from '../use-go';

/**
 * The round trip, if one is under way: opens its fin once, and gives back what the
 * banner needs. `onOpened` re-fits the views to the fin.
 */
export function useBoardTrip(
  store: StoreApi<FinState>,
  onOpened: () => void,
): { label: string; finish: (apply: boolean) => void } | null {
  const [trip] = useState(pendingFinEdit);
  const previous = useRef<FinDesign | null>(null);
  const go = useGo();
  const opened = useRef(false);
  useEffect(() => {
    if (!trip || opened.current) return;
    opened.current = true;
    previous.current = store.getState().design;
    store.getState().load(trip.design);
    onOpened();
  }, [trip, store, onOpened]);
  if (!trip) return null;
  return {
    label: trip.label,
    finish: (apply) => {
      const design = store.getState().design;
      const name = design ? (trip.name ?? defaultFinName(design)) : undefined;
      finishFinRoundTrip(apply ? design : null, name);
      if (apply && design && name) void addMyFin(name, design);
      // The designer's own fin back; with none, its autosave restores it next time.
      if (previous.current) store.getState().load(previous.current);
      else store.setState({ design: null, past: [], future: [], selection: null });
      go('/app');
    },
  };
}

export function BoardTripBanner({
  label,
  onFinish,
}: {
  label: string;
  onFinish: (apply: boolean) => void;
}) {
  return (
    <div
      role="region"
      aria-label="Fin for your board"
      className="flex flex-wrap items-center gap-2 border-b border-primary/40 bg-primary/10 px-3 py-2 text-sm"
    >
      <span className="flex-1">
        Designing <strong>{label}</strong> for your board. Apply puts it on the board (and its
        mirror partner) and keeps it in My fins.
      </span>
      <Button size="sm" variant="ghost" onClick={() => onFinish(false)}>
        Cancel
      </Button>
      <Button size="sm" onClick={() => onFinish(true)}>
        Apply to board
      </Button>
    </div>
  );
}

/** Keep the fin open now in My fins, for any board's fin chooser. */
export function AddToMyFins({ store }: { store: StoreApi<FinState> }) {
  const [said, setSaid] = useState<string | null>(null);
  const add = async () => {
    const d = store.getState().design;
    if (!d) return;
    const id = await addMyFin(defaultFinName(d), d);
    setSaid(id ? 'Added to My fins' : "Couldn't add: this browser isn't keeping data");
    window.setTimeout(() => setSaid(null), 2500);
  };
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => void add()}
        title="Keep this fin for your boards"
      >
        Add to My fins
      </Button>
      {said && (
        <span role="status" className="text-xs text-muted-foreground">
          {said}
        </span>
      )}
    </>
  );
}
