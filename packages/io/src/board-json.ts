import {
  FIN_SETUPS,
  board,
  crossSection,
  defaultFinConfig,
  noFins,
  type BezierBoard,
  type BoardChannels,
  type ChannelParams,
  type ChannelWall,
  type FinConfig,
  type FinSetup,
} from '@openshaper/kernel';
import {
  assertKnots as assertKnotsAs,
  isObject,
  splineFromJson,
  splineToJson,
  type KnotJson,
} from './knot-json';

/**
 * Native OpenShaper document format (`.board.json`) — a clean, versioned,
 * lossless serialization of a kernel BezierBoard. Unlike the legacy `.brd` text
 * format this is schema-stable and round-trips exactly.
 *
 * The `format` marker is written as `'openshaper'`; documents written by the
 * project's former name (`'board-studio'`) are still accepted on read.
 *
 * Version history:
 *   1 — outline/bottom/deck/crossSections + interpolationType + metadata.
 *   2 — adds the parametric `fins` config. Older docs (v1, or any doc carrying a
 *       legacy `metadata.finType`) are migrated on read via `defaultFinConfig`.
 *       Later, still 2: a locked knot carries an optional `l` (its fixed handle
 *       directions). The field is written only for locked knots, so a board without
 *       locks serializes exactly as before, and a reader that predates it ignores it.
 *       Later, still 2 (print version): an optional `channels` block, typed-in numbers or
 *       drawn wall and depth curves. Written only for a board with channels, so a board
 *       without serializes exactly as before; a reader that predates it ignores it.
 */
export const BOARD_JSON_VERSION = 2;

interface CrossSectionJson {
  position: number;
  knots: KnotJson[];
}
export interface BoardJson {
  format: 'openshaper' | 'board-studio';
  version: number;
  interpolationType: BezierBoard['interpolationType'];
  outline: KnotJson[];
  bottom: KnotJson[];
  deck: KnotJson[];
  crossSections: CrossSectionJson[];
  /** Parametric fin configuration (v2+). Omitted when there are no fins. */
  fins?: FinConfig;
  /** Bottom channels. Omitted when there are none. */
  channels?: ChannelsJson;
  metadata?: Record<string, unknown>;
}

/**
 * Resolve the fin config for a parsed document: prefer an explicit v2 `fins` block;
 * otherwise migrate a legacy `metadata.finType` setup name to a default config; else
 * no fins.
 */
const finConfigFromDoc = (doc: BoardJson): FinConfig => {
  if (doc.fins && Array.isArray(doc.fins.fins)) {
    // `symmetrical` was added after the v2 `fins` block; default older docs to true.
    return { ...doc.fins, symmetrical: doc.fins.symmetrical ?? true };
  }
  const legacy = doc.metadata?.finType;
  if (typeof legacy === 'string' && (FIN_SETUPS as readonly string[]).includes(legacy)) {
    return defaultFinConfig(legacy as FinSetup, 'fcs-ii');
  }
  return noFins();
};

interface ChannelJson {
  inner: KnotJson[] | null;
  outer: KnotJson[];
  depth: KnotJson[];
  wall: ChannelWall;
}
type ChannelsJson =
  | { from: 'numbers'; params: ChannelParams }
  | { from: 'drawn'; channels: ChannelJson[]; params?: ChannelParams };

const channelsToJson = (c: BoardChannels): ChannelsJson =>
  c.from === 'numbers'
    ? { from: 'numbers', params: c.params }
    : {
        from: 'drawn',
        channels: c.channels.map((ch) => ({
          inner: ch.inner && splineToJson(ch.inner),
          outer: splineToJson(ch.outer),
          depth: splineToJson(ch.depth),
          wall: ch.wall,
        })),
        ...(c.params ? { params: c.params } : {}),
      };

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

const wallFromJson = (w: unknown, where: string): ChannelWall => {
  if (isObject(w)) {
    if (w.shape === 'square' || w.shape === 'scoop' || w.shape === 'wave')
      return { shape: w.shape };
    if (w.shape === 'step' && finite(w.radius)) {
      // Steps from before the lip was rounded have none: a sharp lip.
      return { shape: 'step', radius: w.radius, lip: finite(w.lip) ? w.lip : 0 };
    }
    if (w.shape === 'bevel' && finite(w.width)) return { shape: 'bevel', width: w.width };
    if (w.shape === 'round' && finite(w.radius)) return { shape: 'round', radius: w.radius };
  }
  throw new BoardJsonError(`Malformed document: ${where} has no valid wall`);
};

const PARAM_NUMBERS = ['count', 'width', 'depth', 'inner', 'follow', 'start', 'end', 'station', 'fullFrom', 'fullTo'] as const; // prettier-ignore

/**
 * Channel numbers from before this layout (laid out from the tail end, or blended from a
 * deepest point). They were only ever in the print version's test builds; such a block
 * reads as no channels rather than a board that won't open.
 */
const isOlderChannelNumbers = (p: unknown): boolean => isObject(p) && !('station' in p);

const paramsFromJson = (p: unknown): ChannelParams => {
  if (!isObject(p) || !PARAM_NUMBERS.every((k) => finite(p[k]))) {
    throw new BoardJsonError('Malformed document: the channel numbers are incomplete');
  }
  const n = (k: (typeof PARAM_NUMBERS)[number]) => p[k] as number;
  return {
    count: n('count'),
    wall: wallFromJson(p.wall, 'the channel numbers'),
    width: n('width'),
    depth: n('depth'),
    inner: n('inner'),
    follow: n('follow'),
    start: n('start'),
    end: n('end'),
    station: n('station'),
    fullFrom: n('fullFrom'),
    fullTo: n('fullTo'),
  };
};

const channelsFromJson = (c: unknown): BoardChannels | undefined => {
  if (c === undefined) return undefined;
  if (isObject(c) && c.from === 'numbers') {
    if (isOlderChannelNumbers(c.params)) return undefined;
    return { from: 'numbers', params: paramsFromJson(c.params) };
  }
  if (isObject(c) && c.from === 'drawn' && Array.isArray(c.channels)) {
    const channels = c.channels.map((ch: unknown, i) => {
      const where = `channel ${i + 1}`;
      if (!isObject(ch)) throw new BoardJsonError(`Malformed document: ${where} is not a channel`);
      if (ch.inner !== null) assertKnots(ch.inner, `${where}'s inner wall`);
      assertKnots(ch.outer, `${where}'s outer wall`);
      assertKnots(ch.depth, `${where}'s depth`);
      return {
        inner: ch.inner === null ? null : splineFromJson(ch.inner as KnotJson[]),
        outer: splineFromJson(ch.outer as KnotJson[]),
        depth: splineFromJson(ch.depth as KnotJson[]),
        wall: wallFromJson(ch.wall, where),
      };
    });
    return {
      from: 'drawn',
      channels,
      ...(c.params !== undefined && !isOlderChannelNumbers(c.params)
        ? { params: paramsFromJson(c.params) }
        : {}),
    };
  }
  throw new BoardJsonError('Malformed document: the channels are not typed in or drawn');
};

/** Serialize a board to a `.board.json` string. */
export const writeBoardJson = (b: BezierBoard, metadata?: Record<string, unknown>): string => {
  const doc: BoardJson = {
    format: 'openshaper',
    version: BOARD_JSON_VERSION,
    interpolationType: b.interpolationType,
    outline: splineToJson(b.outline),
    bottom: splineToJson(b.bottom),
    deck: splineToJson(b.deck),
    crossSections: b.crossSections.map((cs) => ({
      position: cs.position,
      knots: splineToJson(cs.spline),
    })),
    ...(b.fins.setup !== 'none' ? { fins: b.fins } : {}),
    ...(b.channels ? { channels: channelsToJson(b.channels) } : {}),
    ...(metadata ? { metadata } : {}),
  };
  return JSON.stringify(doc, null, 2);
};

export class BoardJsonError extends Error {}

const assertKnots = (v: unknown, where: string): void => assertKnotsAs(v, where, BoardJsonError);

const assertStructure = (doc: Record<string, unknown>): void => {
  for (const curve of ['outline', 'bottom', 'deck'] as const) assertKnots(doc[curve], curve);
  if (!Array.isArray(doc.crossSections)) {
    throw new BoardJsonError('Malformed document: crossSections is missing');
  }
  doc.crossSections.forEach((cs: unknown, i) => {
    const where = `cross-section ${i + 1}`;
    if (!isObject(cs) || typeof cs.position !== 'number' || !Number.isFinite(cs.position)) {
      throw new BoardJsonError(`Malformed document: ${where} has no valid position`);
    }
    assertKnots(cs.knots, where);
  });
};

/** Parse a `.board.json` string back into a board (+ any metadata). */
export const readBoardJson = (
  text: string,
): { board: BezierBoard; metadata?: Record<string, unknown> } => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new BoardJsonError(`Not valid JSON: ${(e as Error).message}`);
  }
  if (!isObject(parsed)) {
    throw new BoardJsonError('Not an OpenShaper document (missing format marker)');
  }
  const doc = parsed as unknown as BoardJson;
  if (doc.format !== 'openshaper' && doc.format !== 'board-studio') {
    throw new BoardJsonError('Not an OpenShaper document (missing format marker)');
  }
  if (doc.version > BOARD_JSON_VERSION) {
    throw new BoardJsonError(
      `Document version ${doc.version} is newer than supported (${BOARD_JSON_VERSION})`,
    );
  }
  assertStructure(parsed);
  const b = board(
    splineFromJson(doc.outline),
    splineFromJson(doc.bottom),
    splineFromJson(doc.deck),
    doc.crossSections.map((cs) => crossSection(cs.position, splineFromJson(cs.knots))),
    doc.interpolationType ?? 'controlPoint',
    finConfigFromDoc(doc),
    channelsFromJson(doc.channels),
  );
  return doc.metadata ? { board: b, metadata: doc.metadata } : { board: b };
};
