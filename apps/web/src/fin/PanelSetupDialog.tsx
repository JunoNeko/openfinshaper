// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * "Set up fins in panel" dialog: CNC operator workflow for laying out a collection of
 * fins on a G10 panel in optimal 3D pose + interlocking 2D polygon nesting.
 *
 * Two modes:
 * - **Calculate panel size from fin collection**: nests the chosen fins and computes
 *   the smallest panel (length × width × thickness), flagging any fin thicker than an
 *   optional target panel thickness.
 * - **Recommend fin collection to fill panel**: packs matched L+R pairs and centre fins
 *   from the selected folder into fixed panel dimensions, excluding and warning on fins
 *   too thick for the panel.
 *
 * After Apply, renders a crisp 2D SVG layout visualisation and offers Save (`.finpanel.json`)
 * and Export STEP (`.step`, multi-solid positioned fins).
 */
import { exportFinPanelStep } from '@openshaper/export';
import { readFinJson, readFinPanelJson, writeFinPanelJson } from '@openshaper/io';
import {
  bestPanelPose,
  calculatePanelSize,
  finPanelPoints,
  panelOutward,
  recommendPanelFins,
  type FinDesign,
  type PanelLayoutResult,
  type PanelPairingMode,
  type PanelPlacement,
  type PanelSetupMode,
  type Vec2,
} from '@openshaper/kernel';
import { Button, Panel, PanelBody, PanelHeader, PanelTitle } from '@openshaper/ui';
import { AlertTriangle, FolderOpen, Layers, Plus, Trash2, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { LenField } from '../components/fields';
import { Modal } from '../components/modal';
import { fmtLen, type LengthUnit } from '../format';
import { canChooseFolder, writeFiles } from '../save-files';
import { SaveDialog } from './SaveDialog';

interface LoadedFin {
  readonly id: string;
  readonly name: string;
  readonly design: FinDesign;
  readonly requiredThickness: number;
  readonly count: number;
}

type PanelSaveKind = 'json' | 'step';

const PALETTE = [
  { fill: 'rgba(56, 189, 248, 0.28)', stroke: '#38bdf8' },
  { fill: 'rgba(244, 114, 182, 0.28)', stroke: '#f472b6' },
  { fill: 'rgba(74, 222, 128, 0.28)', stroke: '#4ade80' },
  { fill: 'rgba(251, 191, 36, 0.28)', stroke: '#fbbf24' },
  { fill: 'rgba(167, 139, 250, 0.28)', stroke: '#a78bfa' },
  { fill: 'rgba(251, 146, 60, 0.28)', stroke: '#fb923c' },
] as const;

const stripExt = (name: string): string =>
  name.replace(/\.fin\.json$/i, '').replace(/\.json$/i, '');

const handTag = (d: FinDesign): string =>
  d.hand === 'left' ? 'L' : d.hand === 'right' ? 'R' : 'Centre';

const measureRequiredThickness = (design: FinDesign, minThickness: number): number => {
  const pts = finPanelPoints(design, minThickness);
  return bestPanelPose(pts, panelOutward(design)).width;
};

/** Read all `.fin.json` files from a File System Access directory handle (Chrome/Edge). */
async function readFinFilesFromDirectory(): Promise<{
  folderName: string;
  files: { name: string; text: string }[];
} | null> {
  const pick = (
    window as unknown as {
      showDirectoryPicker?: (o: {
        id?: string;
        mode?: 'read';
      }) => Promise<FileSystemDirectoryHandle>;
    }
  ).showDirectoryPicker;
  if (!pick) return null;
  let dir: FileSystemDirectoryHandle;
  try {
    dir = await pick.call(window, { id: 'openfinshaper-panel-fins', mode: 'read' });
  } catch (e) {
    if ((e as Error).name === 'AbortError') return null;
    throw e;
  }
  const files: { name: string; text: string }[] = [];
  const entries = (dir as unknown as { values(): AsyncIterable<FileSystemHandle> }).values();
  for await (const entry of entries) {
    if (entry.kind !== 'file' || !entry.name.toLowerCase().endsWith('.fin.json')) continue;
    const f = await (entry as FileSystemFileHandle).getFile();
    files.push({ name: f.name, text: await f.text() });
  }
  files.sort((a, b) => a.name.localeCompare(b.name));
  return { folderName: dir.name, files };
}

const polyPoints = (pts: readonly Vec2[], panelW: number): string =>
  pts.map((p) => `${p.x.toFixed(3)},${(panelW - p.y).toFixed(3)}`).join(' ');

function PanelPreviewSvg({
  layout,
  units,
  hovered,
  onHover,
}: {
  layout: PanelLayoutResult;
  units: LengthUnit;
  hovered: number | null;
  onHover: (idx: number | null) => void;
}) {
  const { length: L, width: W } = layout.panel;
  if (L <= 0 || W <= 0) return null;

  const pad = Math.max(L, W) * 0.08;
  const vb = `${-pad} ${-pad} ${L + pad * 2} ${W + pad * 2}`;
  const colorMap = new Map<string, (typeof PALETTE)[number]>();
  for (const pl of layout.placements) {
    const baseKey = pl.finId.replace(/~(?:left|right)$/, '');
    if (!colorMap.has(baseKey)) {
      colorMap.set(baseKey, PALETTE[colorMap.size % PALETTE.length]!);
    }
  }
  const margin = layout.toolWidth;
  const fontSize = Math.max(0.8, Math.min(2.2, Math.min(L, W) * 0.045));
  const strokeW = Math.max(0.08, Math.max(L, W) * 0.0025);

  return (
    <svg
      viewBox={vb}
      className="h-full max-h-[420px] w-full rounded-md border border-border bg-muted/30"
      role="img"
      aria-label={`Panel layout ${fmtLen(L, units)} by ${fmtLen(W, units)} with ${layout.placements.length} fins`}
    >
      {/* G10 panel boundary */}
      <rect
        x={0}
        y={0}
        width={L}
        height={W}
        fill="rgba(148, 163, 184, 0.12)"
        stroke="currentColor"
        strokeOpacity={0.75}
        strokeWidth={strokeW * 1.4}
      />
      {/* Tool-clearance inner margin */}
      {margin > 0 && L > 2 * margin && W > 2 * margin && (
        <rect
          x={margin}
          y={margin}
          width={L - 2 * margin}
          height={W - 2 * margin}
          fill="none"
          stroke="currentColor"
          strokeOpacity={0.25}
          strokeWidth={strokeW * 0.8}
          strokeDasharray={`${strokeW * 5} ${strokeW * 4}`}
        />
      )}
      {/* Placed fins */}
      {layout.placements.map((pl, idx) => {
        const baseKey = pl.finId.replace(/~(?:left|right)$/, '');
        const col = colorMap.get(baseKey) ?? PALETTE[0];
        const active = hovered === idx;
        const cx = pl.x + pl.boxW / 2;
        const cy = W - (pl.y + pl.boxH / 2);
        return (
          <g
            key={`${pl.finId}-${idx}`}
            onMouseEnter={() => onHover(idx)}
            onMouseLeave={() => onHover(null)}
            className="cursor-pointer"
          >
            {pl.tabOutlines.map((tab, ti) => (
              <polygon
                key={ti}
                points={polyPoints(tab, W)}
                fill={col.fill}
                stroke={col.stroke}
                strokeWidth={active ? strokeW * 1.8 : strokeW}
                strokeLinejoin="round"
              />
            ))}
            <polygon
              points={polyPoints(pl.outline, W)}
              fill={col.fill}
              stroke={col.stroke}
              strokeWidth={active ? strokeW * 2 : strokeW * 1.1}
              strokeLinejoin="round"
            />
            <text
              x={cx}
              y={cy}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={fontSize}
              fill="currentColor"
              opacity={active ? 1 : 0.85}
              style={{ pointerEvents: 'none', userSelect: 'none' }}
            >
              {idx + 1}
            </text>
          </g>
        );
      })}
      {/* Dimension labels */}
      <text
        x={L / 2}
        y={-pad * 0.35}
        textAnchor="middle"
        fontSize={fontSize * 1.05}
        fill="currentColor"
        opacity={0.75}
      >
        Length {fmtLen(L, units)}
      </text>
      <text
        x={-pad * 0.35}
        y={W / 2}
        textAnchor="middle"
        fontSize={fontSize * 1.05}
        fill="currentColor"
        opacity={0.75}
        transform={`rotate(-90 ${-pad * 0.35} ${W / 2})`}
      >
        Width {fmtLen(W, units)}
      </text>
    </svg>
  );
}

/** Summarise placed fins by name + hand for the CNC operator. */
const summarisePlacements = (
  placements: readonly PanelPlacement[],
): { label: string; count: number }[] => {
  const counts = new Map<string, number>();
  for (const pl of placements) {
    const label = `${pl.name} (${handTag(pl.design)})`;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()].map(([label, count]) => ({ label, count }));
};

export function PanelSetupDialog({
  units,
  minThickness,
  currentDesign,
  onClose,
}: {
  units: LengthUnit;
  minThickness: number;
  currentDesign: FinDesign | null;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<PanelSetupMode>('recommend-fill');
  const [pairing, setPairing] = useState<PanelPairingMode>('pairs-only');
  // Defaults (cm): 600 × 300 × 12 mm G10 panel, 6 mm cutter.
  const [panelLength, setPanelLength] = useState(60);
  const [panelWidth, setPanelWidth] = useState(30);
  const [panelThickness, setPanelThickness] = useState(1.2);
  const [toolWidth, setToolWidth] = useState(0.6);

  const [folderLabel, setFolderLabel] = useState<string | null>(null);
  const [fins, setFins] = useState<LoadedFin[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [layout, setLayout] = useState<PanelLayoutResult | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  const [saving, setSaving] = useState<PanelSaveKind | null>(null);
  const [busy, setBusy] = useState(false);

  const folderInputRef = useRef<HTMLInputElement>(null);
  const panelInputRef = useRef<HTMLInputElement>(null);

  const loadRawFinFiles = (label: string, rawFiles: { name: string; text: string }[]) => {
    const loaded: LoadedFin[] = [];
    const bad: string[] = [];
    rawFiles.forEach((f, idx) => {
      try {
        const { design } = readFinJson(f.text);
        loaded.push({
          id: `${stripExt(f.name)}-${idx}`,
          name: stripExt(f.name),
          design,
          requiredThickness: measureRequiredThickness(design, minThickness),
          count: 1,
        });
      } catch {
        bad.push(f.name);
      }
    });
    setFolderLabel(label);
    setFins(loaded);
    setLayout(null);
    if (loaded.length === 0) {
      setLoadError('No valid .fin.json files were found in that folder.');
    } else if (bad.length > 0) {
      setLoadError(`Skipped ${bad.length} unreadable file(s): ${bad.slice(0, 3).join(', ')}`);
    } else {
      setLoadError(null);
    }
  };

  const handleSelectFolder = async () => {
    if (canChooseFolder()) {
      try {
        const picked = await readFinFilesFromDirectory();
        if (picked) loadRawFinFiles(picked.folderName, picked.files);
        return;
      } catch {
        // Fall through to <input webkitdirectory> if picker fails.
      }
    }
    folderInputRef.current?.click();
  };

  const handleFolderInput = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = e.target.files;
    if (!list || list.length === 0) return;
    const finFiles = Array.from(list)
      .filter((f) => f.name.toLowerCase().endsWith('.fin.json'))
      .sort((a, b) => a.name.localeCompare(b.name));
    const firstPath = (list[0] as File & { webkitRelativePath?: string }).webkitRelativePath ?? '';
    const folderName = firstPath.split('/')[0] || `${finFiles.length} file(s)`;
    const raw = await Promise.all(
      finFiles.map(async (f) => ({ name: f.name, text: await f.text() })),
    );
    loadRawFinFiles(folderName, raw);
    e.target.value = '';
  };

  const handleAddCurrent = () => {
    if (!currentDesign) return;
    const id = `current-${Date.now()}`;
    const name = `Current ${currentDesign.position}${currentDesign.hand ? ` (${currentDesign.hand})` : ''}`;
    setFins((prev) => [
      ...prev,
      {
        id,
        name,
        design: currentDesign,
        requiredThickness: measureRequiredThickness(currentDesign, minThickness),
        count: 1,
      },
    ]);
    setLoadError(null);
    setLayout(null);
  };

  const handleOpenPanelFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    try {
      const doc = readFinPanelJson(await file.text());
      setMode(doc.mode);
      if (doc.pairing) setPairing(doc.pairing);
      setPanelLength(doc.panel.length);
      setPanelWidth(doc.panel.width);
      setPanelThickness(doc.panel.thickness);
      setToolWidth(doc.toolWidth);
      const unique = new Map<string, LoadedFin>();
      for (const pl of doc.placements) {
        const ex = unique.get(pl.finId);
        if (ex) {
          unique.set(pl.finId, { ...ex, count: ex.count + 1 });
        } else {
          unique.set(pl.finId, {
            id: pl.finId,
            name: pl.name,
            design: pl.design,
            requiredThickness: pl.requiredThickness,
            count: 1,
          });
        }
      }
      setFins([...unique.values()]);
      setFolderLabel(file.name);
      const maxReq = doc.placements.reduce((m, p) => Math.max(m, p.requiredThickness), 0);
      const warnings = [...unique.values()]
        .filter((f) => f.requiredThickness > doc.panel.thickness + 1e-6)
        .map((f) => ({
          code: 'too-thick' as const,
          finId: f.id,
          finName: f.name,
          requiredThickness: f.requiredThickness,
          panelThickness: doc.panel.thickness,
          message: `${f.name} needs ${(f.requiredThickness * 10).toFixed(1)} mm thickness (panel is ${(doc.panel.thickness * 10).toFixed(1)} mm).`,
        }));
      setLayout({
        mode: doc.mode,
        ...(doc.pairing ? { pairing: doc.pairing } : {}),
        panel: doc.panel,
        toolWidth: doc.toolWidth,
        placements: doc.placements,
        warnings,
        utilisation: 0,
        maxRequiredThickness: maxReq,
      });
      setLoadError(null);
    } catch (err) {
      setLoadError((err as Error).message || 'Could not read panel file.');
    }
  };

  const updateCount = (id: string, delta: number) => {
    setFins((prev) =>
      prev.map((f) => (f.id === id ? { ...f, count: Math.max(0, f.count + delta) } : f)),
    );
    setLayout(null);
  };

  const removeFin = (id: string) => {
    setFins((prev) => prev.filter((f) => f.id !== id));
    setLayout(null);
  };

  const handleApply = async () => {
    if (fins.length === 0) return;
    setBusy(true);
    await new Promise((r) => setTimeout(r, 0));
    try {
      const inputs = fins.map((f) => ({
        id: f.id,
        name: f.name,
        design: f.design,
        count: f.count,
      }));
      const res =
        mode === 'calculate-size'
          ? calculatePanelSize(inputs, {
              toolWidth,
              panelThickness: panelThickness > 0 ? panelThickness : undefined,
              minThickness,
            })
          : recommendPanelFins(inputs, {
              panel: { length: panelLength, width: panelWidth, thickness: panelThickness },
              toolWidth,
              pairing,
              minThickness,
            });
      setLayout(res);
      setHovered(null);
      if (mode === 'calculate-size' && res.panel.length > 0) {
        setPanelLength(res.panel.length);
        setPanelWidth(res.panel.width);
      }
    } finally {
      setBusy(false);
    }
  };

  const activePlacement = hovered !== null && layout ? (layout.placements[hovered] ?? null) : null;
  const tooThickInList = fins.filter((f) => f.requiredThickness > panelThickness + 1e-6);

  return (
    <>
      <Modal
        name="fin-panel-setup"
        label="Set up fins in panel"
        onClose={saving ? () => {} : onClose}
        className="grid place-items-center p-4"
      >
        <Panel
          className="flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          <PanelHeader className="flex items-center justify-between">
            <PanelTitle className="flex items-center gap-2">
              <Layers className="h-4 w-4" />
              Set up fins in panel
            </PanelTitle>
            <Button variant="ghost" size="sm" onClick={onClose}>
              Close
            </Button>
          </PanelHeader>

          <PanelBody className="grid min-h-0 flex-1 gap-4 overflow-y-auto text-sm md:grid-cols-[330px_1fr]">
            {/* Controls column */}
            <div className="flex flex-col gap-4">
              <fieldset className="space-y-2 rounded-md border border-border p-3">
                <legend className="px-1 text-xs font-medium text-muted-foreground">Mode</legend>
                <label className="flex cursor-pointer items-start gap-2">
                  <input
                    type="radio"
                    name="panel-mode"
                    checked={mode === 'calculate-size'}
                    onChange={() => {
                      setMode('calculate-size');
                      setLayout(null);
                    }}
                    className="mt-0.5"
                  />
                  <span>Calculate panel size from fin collection</span>
                </label>
                <label className="flex cursor-pointer items-start gap-2">
                  <input
                    type="radio"
                    name="panel-mode"
                    checked={mode === 'recommend-fill'}
                    onChange={() => {
                      setMode('recommend-fill');
                      setLayout(null);
                    }}
                    className="mt-0.5"
                  />
                  <span>Recommend fin collection to fill panel</span>
                </label>
                {mode === 'recommend-fill' && (
                  <div className="space-y-1.5 border-t border-border/70 pt-2">
                    <div className="text-xs font-medium text-muted-foreground">Fin pairing</div>
                    <div className="flex flex-wrap gap-3">
                      <label className="flex cursor-pointer items-center gap-1.5">
                        <input
                          type="radio"
                          name="panel-pairing"
                          checked={pairing === 'pairs-only'}
                          onChange={() => {
                            setPairing('pairs-only');
                            setLayout(null);
                          }}
                        />
                        <span>All pairs</span>
                      </label>
                      <label className="flex cursor-pointer items-center gap-1.5">
                        <input
                          type="radio"
                          name="panel-pairing"
                          checked={pairing === 'pairs-plus-odd'}
                          onChange={() => {
                            setPairing('pairs-plus-odd');
                            setLayout(null);
                          }}
                        />
                        <span>Pairs + odd fins</span>
                      </label>
                    </div>
                  </div>
                )}
              </fieldset>

              <fieldset className="space-y-2 rounded-md border border-border p-3">
                <legend className="px-1 text-xs font-medium text-muted-foreground">
                  Panel dimensions
                </legend>
                <LenField
                  label="Length"
                  valueCm={panelLength}
                  units={units}
                  disabled={mode === 'calculate-size'}
                  onCommit={(cm) => {
                    setPanelLength(Math.max(1, cm));
                    setLayout(null);
                  }}
                />
                <LenField
                  label="Width"
                  valueCm={panelWidth}
                  units={units}
                  disabled={mode === 'calculate-size'}
                  onCommit={(cm) => {
                    setPanelWidth(Math.max(1, cm));
                    setLayout(null);
                  }}
                />
                <LenField
                  label="Depth (thickness)"
                  valueCm={panelThickness}
                  units={units}
                  onCommit={(cm) => {
                    setPanelThickness(Math.max(0.1, cm));
                    setLayout(null);
                  }}
                />
                <LenField
                  label="2D tool cut width"
                  valueCm={toolWidth}
                  units={units}
                  onCommit={(cm) => {
                    setToolWidth(Math.max(0, cm));
                    setLayout(null);
                  }}
                />
              </fieldset>

              <div className="space-y-2 rounded-md border border-border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => void handleSelectFolder()}
                  >
                    <FolderOpen className="mr-1.5 h-3.5 w-3.5" />
                    Select folder with fin files
                  </Button>
                  {currentDesign && (
                    <Button type="button" size="sm" variant="ghost" onClick={handleAddCurrent}>
                      <Plus className="mr-1 h-3.5 w-3.5" />
                      Current fin
                    </Button>
                  )}
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => panelInputRef.current?.click()}
                  >
                    <Upload className="mr-1 h-3.5 w-3.5" />
                    Open panel
                  </Button>
                  <input
                    ref={folderInputRef}
                    type="file"
                    aria-label="Fin files folder"
                    // Non-standard directory picker attribute supported by Safari/Firefox/Chrome.
                    {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
                    multiple
                    accept=".json"
                    className="hidden"
                    onChange={(e) => void handleFolderInput(e)}
                  />
                  <input
                    ref={panelInputRef}
                    type="file"
                    aria-label="Open panel file"
                    accept=".json,.finpanel.json"
                    className="hidden"
                    onChange={(e) => void handleOpenPanelFile(e)}
                  />
                </div>

                {folderLabel && (
                  <p className="text-xs text-muted-foreground">
                    Source: <span className="font-medium text-foreground">{folderLabel}</span> (
                    {fins.length} fin{fins.length === 1 ? '' : 's'})
                  </p>
                )}

                {loadError && (
                  <p className="text-xs text-destructive" role="alert">
                    {loadError}
                  </p>
                )}

                {fins.length > 0 && (
                  <ul className="max-h-44 space-y-1.5 overflow-y-auto pt-1">
                    {fins.map((f) => {
                      const tooThick = f.requiredThickness > panelThickness + 1e-6;
                      return (
                        <li
                          key={f.id}
                          className="flex items-center justify-between gap-2 rounded border border-border/70 px-2 py-1 text-xs"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="truncate font-medium">
                              {f.name}{' '}
                              <span className="font-normal text-muted-foreground">
                                ({handTag(f.design)})
                              </span>
                            </div>
                            <div
                              className={
                                tooThick ? 'font-medium text-amber-500' : 'text-muted-foreground'
                              }
                            >
                              Needs {fmtLen(f.requiredThickness, units)}
                              {tooThick ? ' — too thick for panel' : ''}
                            </div>
                          </div>
                          {mode === 'calculate-size' && (
                            <div className="flex items-center gap-1">
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                aria-label={`Decrease ${f.name} count`}
                                onClick={() => updateCount(f.id, -1)}
                              >
                                −
                              </Button>
                              <span className="w-4 text-center tabular-nums">{f.count}</span>
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                aria-label={`Increase ${f.name} count`}
                                onClick={() => updateCount(f.id, 1)}
                              >
                                +
                              </Button>
                            </div>
                          )}
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            aria-label={`Remove ${f.name}`}
                            onClick={() => removeFin(f.id)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </li>
                      );
                    })}
                  </ul>
                )}

                {tooThickInList.length > 0 && !layout && (
                  <p className="flex items-start gap-1.5 text-xs text-amber-500" role="status">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>
                      {tooThickInList.length} fin{tooThickInList.length === 1 ? '' : 's'} deeper
                      than the {fmtLen(panelThickness, units)} panel thickness.
                    </span>
                  </p>
                )}
              </div>

              <Button
                type="button"
                disabled={busy || fins.length === 0}
                onClick={() => void handleApply()}
              >
                {busy ? 'Calculating layout…' : 'Apply'}
              </Button>
            </div>

            {/* Visualisation & actions column */}
            <div className="flex min-h-[320px] flex-col gap-3">
              {!layout ? (
                <div className="flex flex-1 flex-col items-center justify-center rounded-md border border-dashed border-border p-6 text-center text-muted-foreground">
                  <Layers className="mb-2 h-8 w-8 opacity-40" />
                  <p className="font-medium text-foreground">No panel layout yet</p>
                  <p className="mt-1 max-w-sm text-xs">
                    Select a folder of <code>.fin.json</code> files (or add the current fin), check
                    the panel dimensions and tool cut width, then click <strong>Apply</strong>.
                  </p>
                </div>
              ) : (
                <>
                  {layout.warnings.length > 0 && (
                    <div
                      role="alert"
                      className="space-y-1 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200"
                    >
                      <div className="flex items-center gap-1.5 font-medium text-amber-400">
                        <AlertTriangle className="h-4 w-4 shrink-0" />
                        <span>
                          {layout.warnings.length} warning{layout.warnings.length === 1 ? '' : 's'}
                        </span>
                      </div>
                      <ul className="list-disc space-y-0.5 pl-5">
                        {layout.warnings.map((w, i) => (
                          <li key={`${w.code}-${w.finId}-${i}`}>{w.message}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <dl className="flex flex-wrap gap-x-5 gap-y-1 rounded-md border border-border bg-muted/20 px-3 py-2 text-xs">
                    <div>
                      <dt className="inline text-muted-foreground">Panel </dt>
                      <dd className="inline font-medium tabular-nums">
                        {fmtLen(layout.panel.length, units)} × {fmtLen(layout.panel.width, units)} ×{' '}
                        {fmtLen(layout.panel.thickness, units)}
                      </dd>
                    </div>
                    <div>
                      <dt className="inline text-muted-foreground">Fins </dt>
                      <dd className="inline font-medium tabular-nums">
                        {layout.placements.length}
                      </dd>
                    </div>
                    {layout.utilisation > 0 && (
                      <div>
                        <dt className="inline text-muted-foreground">Utilisation </dt>
                        <dd className="inline font-medium tabular-nums">
                          {(layout.utilisation * 100).toFixed(0)}%
                        </dd>
                      </div>
                    )}
                    <div>
                      <dt className="inline text-muted-foreground">Max thickness needed </dt>
                      <dd className="inline font-medium tabular-nums">
                        {fmtLen(layout.maxRequiredThickness, units)}
                      </dd>
                    </div>
                  </dl>

                  <div className="flex-1">
                    <PanelPreviewSvg
                      layout={layout}
                      units={units}
                      hovered={hovered}
                      onHover={setHovered}
                    />
                  </div>

                  <div className="min-h-5 text-xs text-muted-foreground">
                    {activePlacement ? (
                      <span>
                        <strong className="text-foreground">
                          #{(hovered ?? 0) + 1} {activePlacement.name} (
                          {handTag(activePlacement.design)})
                        </strong>{' '}
                        — rot {activePlacement.rotation}°, pose angle{' '}
                        {activePlacement.pose.angle.toFixed(1)}° / tilt{' '}
                        {activePlacement.pose.tilt.toFixed(1)}°, needs{' '}
                        {fmtLen(activePlacement.requiredThickness, units)}
                      </span>
                    ) : (
                      <span>
                        {summarisePlacements(layout.placements)
                          .map((s) => `${s.count}× ${s.label}`)
                          .join(' · ')}
                      </span>
                    )}
                  </div>

                  <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-3">
                    <Button
                      type="button"
                      variant="outline"
                      disabled={layout.placements.length === 0}
                      onClick={() => setSaving('json')}
                    >
                      Save panel (.finpanel.json)
                    </Button>
                    <Button
                      type="button"
                      disabled={layout.placements.length === 0}
                      onClick={() => setSaving('step')}
                    >
                      Export STEP
                    </Button>
                  </div>
                </>
              )}
            </div>
          </PanelBody>
        </Panel>
      </Modal>

      {saving && layout && (
        <SaveDialog
          title={saving === 'json' ? 'Save panel layout' : 'Export panel STEP'}
          action={saving === 'json' ? 'Save' : 'Export'}
          busyLabel={saving === 'json' ? 'Saving…' : 'Exporting…'}
          items={[{ label: 'File name', stem: 'fin-panel' }]}
          ext={saving === 'json' ? '.finpanel.json' : '.step'}
          note={
            saving === 'step'
              ? `${layout.placements.length} positioned fin(s) in ${fmtLen(layout.panel.length, units)} × ${fmtLen(layout.panel.width, units)} × ${fmtLen(layout.panel.thickness, units)} panel (Z = 0 to thickness).`
              : 'Self-contained panel layout with embedded fin designs.'
          }
          onSave={async ([stem], folder) => {
            if (saving === 'json') {
              const data = writeFinPanelJson({
                mode: layout.mode,
                ...(layout.pairing ? { pairing: layout.pairing } : {}),
                panel: layout.panel,
                toolWidth: layout.toolWidth,
                placements: layout.placements,
              });
              await writeFiles(
                [{ name: `${stem}.finpanel.json`, data, type: 'application/json' }],
                folder,
              );
            } else {
              const step = exportFinPanelStep(layout, {
                unit: units.key === 'in' ? 'in' : 'mm',
                name: stem,
                minThickness,
              });
              await writeFiles(
                [{ name: `${stem}.step`, data: step, type: 'application/step' }],
                folder,
              );
            }
          }}
          onClose={() => setSaving(null)}
        />
      )}
    </>
  );
}
