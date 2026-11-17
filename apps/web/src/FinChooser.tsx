// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Choosing fins (fin integration, phase 1; owner design newfinUI / finchooser).
 *
 * Two ways, for the two kinds of people:
 * - **A set:** every fin of the board's setup at once (Thruster, Quad, Twin, Keel, …) in
 *   S, M or L. Most people want this.
 * - **One fin:** the selected fin alone, any library fin its place can take, mixing and
 *   matching; its mirror partner follows while the pair is kept matched (Symmetrical).
 *
 * And a person's own (phase 2): **My fins**, kept in this browser (my-fins.ts), for the
 * selected fin; **Import .fin.json** into My fins; and **Edit in OpenFinShaper** or
 * **Design a new fin**, the round trip (fin-handoff.ts): the fin opens in the designer,
 * and Apply brings it back onto this fin, and its mirror partner.
 *
 * Fins are drawn from their own designs (OpenFinShaper's), so what is picked is what the
 * 3D view and exports show.
 */
import {
  FIN_SIZES,
  LIBRARY_FINS,
  finGroups,
  finLabel,
  finSetOf,
  finSetsFor,
  makeLibraryFin,
  positionFor,
  type BezierBoard,
  type FinDesign,
  type FinSize,
} from '@openshaper/kernel';
import type { BoardState } from '@openshaper/store';
import { Button, Panel, PanelBody, PanelHeader, PanelTitle, cn } from '@openshaper/ui';
import { readFinJson } from '@openshaper/io';
import { useRef, useState } from 'react';
import type { StoreApi } from 'zustand/vanilla';
import { Modal } from './components/modal';
import { startFinRoundTrip } from './fin-handoff';
import { addMyFin, defaultFinName, removeMyFin, useMyFins } from './my-fins';
import { useGo } from './use-go';

/** A fin's side profile, filled: its front on the left, as OpenFinShaper's Profile view. */
export function FinThumb({ design, className }: { design: FinDesign; className?: string }) {
  const k = design.outline.knots;
  const pts = k.flatMap((n) => [n.end, n.tangentToPrev, n.tangentToNext]);
  const maxX = Math.max(...pts.map((p) => p.x));
  const minX = Math.min(...pts.map((p) => p.x));
  const maxY = Math.max(...pts.map((p) => p.y));
  const at = (p: { x: number; y: number }) => `${(maxX - p.x).toFixed(3)} ${(maxY - p.y).toFixed(3)}`; // prettier-ignore
  let d = `M${at(k[0]!.end)}`;
  for (let i = 1; i < k.length; i++) {
    d += ` C${at(k[i - 1]!.tangentToNext)} ${at(k[i]!.tangentToPrev)} ${at(k[i]!.end)}`;
  }
  return (
    <svg
      viewBox={`-0.5 -0.5 ${(maxX - minX + 1).toFixed(3)} ${(maxY + 1).toFixed(3)}`}
      className={cn('h-12 w-16', className)}
      aria-hidden="true"
    >
      <path
        d={`${d} Z`}
        className="fill-muted-foreground/60 stroke-foreground"
        strokeWidth={0.15}
      />
    </svg>
  );
}

function SizeButtons({
  current,
  onPick,
  label,
}: {
  current: FinSize | null;
  onPick: (s: FinSize) => void;
  label: string;
}) {
  return (
    <div className="flex gap-1" role="group" aria-label={`${label} size`}>
      {FIN_SIZES.map((s) => (
        <button
          key={s}
          type="button"
          aria-label={`${label} ${s}`}
          aria-pressed={current === s}
          onClick={() => onPick(s)}
          className={cn(
            'min-w-8 rounded-md border px-2 py-0.5 text-xs pointer-coarse:min-h-11',
            current === s ? 'border-primary bg-primary/10' : 'border-border hover:bg-muted',
          )}
        >
          {s}
        </button>
      ))}
    </div>
  );
}

export function FinChooser({
  store,
  board,
  finIndex,
  onClose,
}: {
  store: StoreApi<BoardState>;
  board: BezierBoard;
  /** The fin to change alone, or null for sets only. */
  finIndex: number | null;
  onClose: () => void;
}) {
  const cfg = board.fins;
  const sets = finSetsFor(cfg.setup);
  const current = finSetOf(cfg);
  const roles = finGroups(cfg.setup);
  const spec = finIndex === null ? null : cfg.fins[finIndex];
  const role = finIndex === null ? null : roles[finIndex];
  const forThisFin = role ? LIBRARY_FINS.filter((f) => f.roles.includes(role)) : [];
  // What each set looks like: its first fin, at M, on this board's system.
  const preview = (id: string) =>
    makeLibraryFin(id, 'M', spec?.side ?? -1, cfg.system, role ?? 'side');

  return (
    <Modal
      name="fin-chooser"
      label="Choose fins"
      onClose={onClose}
      className="grid place-items-center p-4"
    >
      <Panel
        className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <PanelHeader className="flex items-center justify-between">
          <PanelTitle>Choose fins</PanelTitle>
          <Button size="sm" variant="ghost" title="Close" onClick={onClose}>
            ✕
          </Button>
        </PanelHeader>
        <PanelBody className="space-y-4 text-sm">
          <section className="space-y-2">
            <h3 className="font-medium">A set for every fin</h3>
            {sets.map((set) => {
              const first = Object.values(set.fins)[0];
              const d = first ? makeLibraryFin(first, 'M', -1, cfg.system, Object.keys(set.fins)[0] as 'side') : null; // prettier-ignore
              return (
                <div
                  key={set.id}
                  className="flex items-center gap-3 rounded-md border border-border p-2"
                >
                  {d && <FinThumb design={d} />}
                  <span className="flex-1">{set.label}</span>
                  <SizeButtons
                    label={set.label}
                    current={current?.set.id === set.id ? current.size : null}
                    onPick={(size) => store.getState().setFinSet(set.id, size)}
                  />
                </div>
              );
            })}
          </section>

          {spec && finIndex !== null && (
            <section className="space-y-2">
              <h3 className="font-medium">This fin only</h3>
              <p className="text-xs text-muted-foreground">
                Fin {finIndex + 1}
                {cfg.symmetrical && spec.side !== 0 ? ' and its mirror partner' : ''}: mix and
                match.
              </p>
              {forThisFin.map((lib) => {
                const d = preview(lib.id);
                const mine = spec.library?.fin === lib.id ? spec.library.size : null;
                return (
                  <div
                    key={lib.id}
                    className="flex items-center gap-3 rounded-md border border-border p-2"
                  >
                    {d && <FinThumb design={d} />}
                    <span className="flex-1">{lib.label}</span>
                    <SizeButtons
                      label={lib.label}
                      current={mine}
                      onPick={(size) => store.getState().setLibraryFin(finIndex, lib.id, size)}
                    />
                  </div>
                );
              })}
            </section>
          )}

          <MyFinsSection store={store} board={board} finIndex={finIndex} onLeave={onClose} />

          <p className="text-xs text-muted-foreground">
            Fins are OpenFinShaper designs, set on the tab your fin system takes.
          </p>
        </PanelBody>
        <div className="flex justify-end border-t border-border px-4 py-3">
          <Button size="sm" onClick={onClose}>
            Done
          </Button>
        </div>
      </Panel>
    </Modal>
  );
}

const sideName = (side: -1 | 0 | 1): string =>
  side === 0 ? 'Centre' : side < 0 ? 'Port' : 'Starboard';

/**
 * My fins, import, and the OpenFinShaper round trip, for the selected fin. Without one
 * selected, it says how to get to them.
 */
function MyFinsSection({
  store,
  board,
  finIndex,
  onLeave,
}: {
  store: StoreApi<BoardState>;
  board: BezierBoard;
  finIndex: number | null;
  onLeave: () => void;
}) {
  const { fins } = useMyFins();
  const go = useGo();
  const input = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const cfg = board.fins;
  const spec = finIndex === null ? null : cfg.fins[finIndex];
  const role = finIndex === null ? 'side' : (finGroups(cfg.setup)[finIndex] ?? 'side');

  const importFiles = async (files: FileList | null) => {
    if (!files) return;
    const wrong: string[] = [];
    for (const file of Array.from(files)) {
      try {
        const design = readFinJson(await file.text()).design;
        const name = file.name.replace(/\.fin\.json$|\.json$/i, '') || defaultFinName(design);
        if (!(await addMyFin(name, design))) wrong.push(`${file.name}: this browser isn't keeping data`); // prettier-ignore
      } catch (e) {
        wrong.push(`${file.name}: ${(e as Error).message}`);
      }
    }
    setProblem(wrong.length ? wrong.join(' ') : null);
  };

  const roundTrip = (fresh: boolean) => {
    if (finIndex === null || !spec) return;
    const design = fresh
      ? makeLibraryFin(role === 'centre' ? 'thruster-centre' : role === 'rear' ? 'quad-rear' : 'thruster-side', 'M', spec.side, cfg.system, role) // prettier-ignore
      : spec.design;
    if (!design) return;
    const label = `fin ${sideName(spec.side)[0]}${finIndex + 1} (${sideName(spec.side).toLowerCase()} ${positionFor(role) === 'quad-rear' ? 'rear' : role})`; // prettier-ignore
    // Named after where it came from: its own name, or the library fin it was ("Thruster
    // side M (edited)"); a new one is named when it is applied.
    const name = fresh ? undefined : (spec.name ?? (spec.library ? `${finLabel(spec)} (edited)` : undefined)); // prettier-ignore
    startFinRoundTrip(finIndex, design, label, name);
    onLeave();
    go('/fin');
  };

  return (
    <section className="space-y-2">
      <h3 className="font-medium">My fins</h3>
      {finIndex === null || !spec ? (
        <p className="text-xs text-muted-foreground">
          Select a fin (P1, S2, …) and Change it to use one of your own, or design one in
          OpenFinShaper.
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => roundTrip(false)}
            disabled={!spec.design}
          >
            Edit in OpenFinShaper
          </Button>
          <Button size="sm" variant="secondary" onClick={() => roundTrip(true)}>
            Design a new fin
          </Button>
        </div>
      )}
      {fins.map((f) => (
        <div key={f.id} className="flex items-center gap-3 rounded-md border border-border p-2">
          <FinThumb design={f.design} />
          <span className="flex-1">{f.name}</span>
          {finIndex !== null && spec && (
            <Button
              size="sm"
              variant="secondary"
              aria-label={`Use ${f.name}`}
              onClick={() => store.getState().setOwnFin(finIndex, f.design, f.name)}
            >
              Use
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Delete ${f.name}`}
            title="Delete from My fins"
            onClick={() => void removeMyFin(f.id)}
          >
            ✕
          </Button>
        </div>
      ))}
      <div>
        <Button size="sm" variant="ghost" onClick={() => input.current?.click()}>
          Import .fin.json…
        </Button>
        <input
          ref={input}
          type="file"
          accept=".json,.fin.json,application/json"
          multiple
          className="hidden"
          aria-label="Import fin files"
          onChange={(e) => {
            void importFiles(e.target.files);
            e.target.value = '';
          }}
        />
      </div>
      {problem && (
        <p role="alert" className="text-xs text-destructive">
          {problem}
        </p>
      )}
    </section>
  );
}
