// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * A slider with one or more handles on one track, labelled at its two ends (the Channels
 * panel's Align and Blend controls).
 *
 * Values are shares of the track, 0 to 1. Keeping handles in order, or snapping one, is
 * the caller's: `onChange` gets the handle and where it was dragged to, and the caller
 * passes back what it made of that. A drag is bracketed by `onStart` and `onEnd`, so
 * the caller can make it one undo step; so is each arrow-key press.
 */
import { useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { cn } from '@openshaper/ui';

export interface SliderHandle {
  value: number;
  /** Its accessible name ("Start", "Deepest point"). */
  label: string;
  /** What screen readers announce for its value (a length, not a share). */
  valueText?: string;
  /**
   * 'accent' (the default), round; or 'plain': a handle that stands for something else
   * (a cross-section), drawn as a white bar across the track.
   */
  tone?: 'accent' | 'plain';
  /**
   * The only places it can be (ascending): a drag snaps to the nearest, an arrow key goes
   * to the next one along.
   */
  stops?: readonly number[];
}

const nearest = (stops: readonly number[], v: number) =>
  stops.reduce((best, s) => (Math.abs(s - v) < Math.abs(best - v) ? s : best), stops[0]!);

/** Keyboard step, as a share of the track; Shift moves ten times as far. */
const KEY_STEP = 0.005;

export function MultiSlider({
  handles,
  ends,
  onChange,
  onStart,
  onEnd,
  className,
}: {
  handles: readonly SliderHandle[];
  /** The words at the track's left and right ends, if any. */
  ends?: readonly [string, string];
  onChange: (index: number, value: number) => void;
  onStart?: () => void;
  onEnd?: () => void;
  className?: string;
}) {
  const track = useRef<HTMLDivElement>(null);
  const dragging = useRef<number | null>(null);

  const shareAt = (clientX: number) => {
    const r = track.current?.getBoundingClientRect();
    if (!r || r.width <= 0) return null;
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  };

  const down = (i: number) => (e: PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dragging.current = i;
    onStart?.();
  };
  const move = (i: number) => (e: PointerEvent<HTMLButtonElement>) => {
    if (dragging.current !== i) return;
    const v = shareAt(e.clientX);
    if (v === null) return;
    const stops = handles[i]!.stops;
    onChange(i, stops?.length ? nearest(stops, v) : v);
  };
  const up = (i: number) => () => {
    if (dragging.current !== i) return;
    dragging.current = null;
    onEnd?.();
  };
  const key = (i: number) => (e: KeyboardEvent<HTMLButtonElement>) => {
    const dir =
      e.key === 'ArrowRight' || e.key === 'ArrowUp'
        ? 1
        : e.key === 'ArrowLeft' || e.key === 'ArrowDown'
          ? -1
          : 0;
    if (!dir) return;
    e.preventDefault();
    const h = handles[i]!;
    let next: number | undefined;
    if (h.stops?.length) {
      next = dir > 0 ? h.stops.find((s) => s > h.value + 1e-9) : [...h.stops].reverse().find((s) => s < h.value - 1e-9); // prettier-ignore
      if (next === undefined) return;
    } else {
      next = Math.min(1, Math.max(0, h.value + dir * KEY_STEP * (e.shiftKey ? 10 : 1)));
    }
    onStart?.();
    onChange(i, next);
    onEnd?.();
  };

  return (
    <div className={cn('space-y-1', className)}>
      {ends && (
        <div className="flex justify-between text-[11px] text-muted-foreground">
          <span>{ends[0]}</span>
          <span>{ends[1]}</span>
        </div>
      )}
      <div ref={track} className="relative mx-2 h-5">
        <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-muted-foreground/50" />
        {handles.map((h, i) => (
          <button
            key={h.label}
            type="button"
            role="slider"
            aria-label={h.label}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(h.value * 100)}
            aria-valuetext={h.valueText}
            title={h.valueText ? `${h.label}: ${h.valueText}` : h.label}
            onPointerDown={down(i)}
            onPointerMove={move(i)}
            onPointerUp={up(i)}
            onPointerCancel={up(i)}
            onKeyDown={key(i)}
            className={cn(
              'absolute top-1/2 -translate-x-1/2 -translate-y-1/2 touch-none',
              'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
              // A plain handle is a bar across the track, under the round ones: where one
              // sits on it, the round one takes the middle and the bar's ends stay to grab.
              h.tone === 'plain'
                ? 'z-0 h-5 w-1.5 rounded-sm bg-foreground'
                : 'z-10 h-3 w-3 rounded-full bg-primary',
            )}
            style={{ left: `${h.value * 100}%` }}
          />
        ))}
      </div>
    </div>
  );
}
