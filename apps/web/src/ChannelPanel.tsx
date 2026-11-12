// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Channels panel (print version, owner request): bottom channels typed in as numbers.
 *
 * The numbers are the board's channels (`board.channels`, from 'numbers'); the kernel
 * makes the wall and depth curves from them and the board each time
 * (`layoutChannels`), so changing a number, or the outline under channels set to follow
 * it, recuts them. Each change is one undo step. Drawing the walls by hand comes later
 * (docs/design/channels.md); a board whose channels were drawn shows them here as such.
 *
 * Length fields follow the editor's unit selector (`units`).
 */
import {
  MAX_CHANNELS,
  boardChannelProblems,
  defaultChannelParams,
  type ChannelLayout,
  type ChannelParams,
  type ChannelWall,
} from '@openshaper/kernel';
import type { BoardState } from '@openshaper/store';
import { Button } from '@openshaper/ui';
import { useSyncExternalStore } from 'react';
import type { StoreApi } from 'zustand/vanilla';
import { LenField } from './components/fields';
import type { LengthUnit } from './format';
import { Sel } from './view-toolkit';

const LAYOUTS: { value: ChannelLayout; label: string }[] = [
  { value: 'parallel', label: 'Straight' },
  { value: 'outline', label: 'Follow outline' },
];

type WallShape = ChannelWall['shape'];
const WALLS: { value: WallShape; label: string }[] = [
  { value: 'square', label: 'Square' },
  { value: 'bevel', label: 'Bevelled' },
  { value: 'round', label: 'Rounded' },
  { value: 'scoop', label: 'Scooped' },
];

const COUNTS = Array.from({ length: MAX_CHANNELS }, (_, i) => {
  const n = i + 1;
  const label = n === 1 ? '1, on the stringer' : n % 2 ? `${n}, one on the stringer` : `${n}`;
  return { value: String(n), label };
});

/** A wall of `shape`, keeping the size the current one has (or a starting size). */
const wallOf = (shape: WallShape, current: ChannelWall, size: number): ChannelWall =>
  shape === 'bevel'
    ? { shape, width: size }
    : shape === 'round'
      ? { shape, radius: size }
      : shape === current.shape
        ? current
        : { shape };

const wallSize = (w: ChannelWall): number =>
  w.shape === 'bevel' ? w.width : w.shape === 'round' ? w.radius : 1;

function ChannelFields({
  params,
  units,
  onChange,
}: {
  params: ChannelParams;
  units: LengthUnit;
  onChange: (p: ChannelParams) => void;
}) {
  const set = (patch: Partial<ChannelParams>) => onChange({ ...params, ...patch });
  const pos = (v: number) => Math.max(0, v);
  const odd = Math.round(params.count) % 2 === 1;
  return (
    <div className="space-y-1.5">
      <label className="flex items-center gap-2">
        <span className="flex-1 text-muted-foreground">How many</span>
        <Sel
          value={String(Math.round(params.count))}
          onChange={(v) => set({ count: Number(v) })}
          options={COUNTS}
          title="How many channels, across the whole board"
        />
      </label>
      <label className="flex items-center gap-2">
        <span className="flex-1 text-muted-foreground">Layout</span>
        <Sel
          value={params.layout}
          onChange={(layout) => set({ layout })}
          options={LAYOUTS}
          title="Straight, parallel to the stringer, or following the outline"
        />
      </label>
      <LenField
        label="Depth"
        valueCm={params.depth}
        units={units}
        onCommit={(v) => set({ depth: pos(v) })}
      />
      <LenField
        label="Tail end"
        valueCm={params.tailEnd}
        units={units}
        onCommit={(v) => set({ tailEnd: pos(v) })}
      />
      <LenField
        label="Front end"
        valueCm={params.length}
        units={units}
        onCommit={(v) => set({ length: pos(v) })}
      />
      <LenField
        label="Fade in"
        valueCm={params.runIn}
        units={units}
        onCommit={(v) => set({ runIn: pos(v) })}
      />
      <LenField
        label="From stringer"
        valueCm={params.inner}
        units={units}
        disabled={odd}
        onCommit={(v) => set({ inner: pos(v) })}
      />
      <LenField
        label="From rail"
        valueCm={params.railMargin}
        units={units}
        onCommit={(v) => set({ railMargin: pos(v) })}
      />
      <LenField
        label="Land"
        valueCm={params.land}
        units={units}
        onCommit={(v) => set({ land: pos(v) })}
      />
      <label className="flex items-center gap-2">
        <span className="flex-1 text-muted-foreground">Walls</span>
        <Sel
          value={params.wall.shape}
          onChange={(shape) =>
            set({ wall: wallOf(shape, params.wall, Math.max(0.2, wallSize(params.wall))) })
          }
          options={WALLS}
          title="How the bottom steps down into each channel"
        />
      </label>
      {(params.wall.shape === 'bevel' || params.wall.shape === 'round') && (
        <LenField
          label={params.wall.shape === 'bevel' ? 'Bevel width' : 'Radius'}
          valueCm={wallSize(params.wall)}
          units={units}
          onCommit={(v) => set({ wall: wallOf(params.wall.shape, params.wall, Math.max(0.05, v)) })}
        />
      )}
    </div>
  );
}

/** The Channels panel for the sidebar. */
export function ChannelPanel({ store, units }: { store: StoreApi<BoardState>; units: LengthUnit }) {
  const board = useSyncExternalStore(store.subscribe, () => store.getState().board);
  if (!board) return null;
  const channels = board.channels;
  const problems = boardChannelProblems(board);
  const setChannels = store.getState().setChannels;

  return (
    <div className="space-y-2 text-sm">
      {!channels && (
        <>
          <p className="text-xs text-muted-foreground">
            Grooves cut up into the bottom, running out toward the tail.
          </p>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setChannels({ from: 'numbers', params: defaultChannelParams(board) })}
          >
            Add channels
          </Button>
        </>
      )}
      {channels?.from === 'numbers' && (
        <ChannelFields
          params={channels.params}
          units={units}
          onChange={(params) => setChannels({ from: 'numbers', params })}
        />
      )}
      {channels?.from === 'drawn' && (
        <p className="text-xs text-muted-foreground">
          {channels.channels.length} drawn channel{channels.channels.length === 1 ? '' : 's'} each
          side.
        </p>
      )}
      {problems.length > 0 && (
        <ul role="alert" className="space-y-1 text-xs text-destructive">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {channels && (
        <>
          <p className="text-xs text-muted-foreground">
            Tail end and front end are from the tail; from stringer, from rail and land are measured
            at the tail end. Cut into the 3D view and the STL; volume, the cross-section view and
            STEP don&apos;t include them yet.
          </p>
          <Button size="sm" variant="ghost" onClick={() => setChannels(null)}>
            Remove channels
          </Button>
        </>
      )}
    </div>
  );
}
