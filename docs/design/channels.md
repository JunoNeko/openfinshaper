# Bottom channels (print version, owner request 2026-11)

Channels are grooves cut up into the bottom, usually running out through the tail. The
owner wants them for printed boards, typed in as numbers for straight ones and drawn for
curved ones (the reference board: one wide channel centred on the stringer, its walls
bowing out mid-board and flaring to the swallow tips).

## Model (`packages/kernel/src/channels.ts`)

A channel is two walls drawn in plan, a depth along the board and a wall shape:

| Field   | What it is                                                                        |
| ------- | --------------------------------------------------------------------------------- |
| `outer` | Spline in the outline's frame: x from the tail (cm), y out from the stringer (cm) |
| `inner` | The same, or `null` for one channel centred on the stringer                       |
| `depth` | Spline of x against cut depth (cm); the channel is as long as this curve          |
| `wall`  | `square` (vertical step), `bevel` (width), `round` (radius) or `scoop`            |

Each channel is cut on both sides.

## Typed-in or drawn (`channel-layout.ts`)

`BezierBoard.channels` is one of two kinds:

- **Typed in:** `{ from: 'numbers', params }`. The curves are generated from the numbers
  and the board each time (`layoutChannels`, memoised per board). Channels that follow
  the outline therefore follow it as the outline is edited.
- **Drawn:** `{ from: 'drawn', channels, params? }`. This is for walls reshaped by hand
  (step 4). It keeps the numbers the channels started from.

`boardChannels(b)` turns either kind into curves for the loft. Straight channels are
just straight walls, so there is one shape everywhere downstream.

The numbers (`ChannelParams`) are laid out from one cross-section, where the channels
are deepest (see "Laid out from a cross-section" below):

| Number     | Meaning                                                                     |
| ---------- | --------------------------------------------------------------------------- |
| `count`    | Channels across the whole board; an odd count puts one on the stringer      |
| `wall`     | Section: step (with `radius` top and `lip` bottom), scoop or wave           |
| `width`    | Each channel's width, side by side, where they are deepest                  |
| `depth`    | How deep they are cut there                                                 |
| `inner`    | From the stringer to the first wall, there                                  |
| `follow`   | 0 walls parallel to the stringer, 1 each keeps its share of the half-width  |
| `start`    | Where they start toward the tail; 0 runs them out through it                |
| `end`      | Where they end toward the nose                                              |
| `deepest`  | Where they are deepest: the cross-section they are laid out from            |
| `fadeTail` | Where the depth has faded to nothing toward the tail; at `deepest`, no fade |
| `fadeNose` | Where the depth has faded to nothing toward the nose; at `deepest`, no fade |

Where a number leaves nothing to cut, `boardChannelProblems` says why.
`defaultChannelParams(b, x)` starts four 5 cm steps 5 cm off the stringer, deepest at `x`,
at full depth back through the tail and fading out over the next third of the board.

The panel is in the sidebar's Shape tab (`ChannelPanel.tsx`), and every change is one
undo step (`setChannels`). Channels are saved in the `.board` file (`board-json.ts`, an
optional `channels` block, still version 2), autosave and share links. Legacy `.brd`
has no place for them.

The print version routes the board editor at `/app` again; the public OpenShaper site
serves only the fin designer. The precache guard no longer rejects the editor's code,
but its page still stays out of the precache.
`BezierBoard.channels` is absent on a board without channels, which is therefore exactly
what it was before: `tessellateBoard`, the STL and every characterization snapshot are
unchanged, byte for byte.

## How the hull is cut (`loft.ts`)

Not through the cross-sections. They are sparse stations blended in between, which would
smear a channel's fade, and could keep its walls sharp only if every station had
matching points on them. Instead:

1. **The bottom is lifted.** A point before the station's widest point (`bottomEnd`) is
   raised by `channelDepthAt(x, y)`. The lift is vertical, not along the normal: channels
   sit on the flat middle of the bottom, within a few degrees of level, and a vertical
   lift can't fold the surface.
2. **Points go on the walls.** `channelAnchors` lists where each ring needs a point:
   - both sides of a square wall, 1 µm apart;
   - across a bevel or round;
   - six spread over each floor.

   Their number never depends on x, because the mesh joins rings point by point.

3. **Walls stay one edge.** `stationRing` takes the board's ladder (`ringFractions`) and
   the anchors at a reference station, and fixes the order of all of them once per board.
   Each other station moves the anchors to its own walls; every other point keeps its
   share of the gap it sits in. So anchor j is the same point index in every ring, and a
   wall is an unbroken edge of the mesh rather than a zigzag.
4. **Anchors that don't fit the bottom are moved onto it.** This happens toward a pointed
   tail, where the walls are held past the channel's end, and in a swallow's notch. The
   anchors are scaled in or shifted out, continuously, instead of being clamped: clamping
   piles them onto one point, which a welded mesh turns into edges shared by four faces.
   Where a channel fits, nothing moves.

Both loft paths do this: `loftRing` (ordinary tails, the 3D view) and `tessellateCutout`
(swallow and fish). So does the STL writer's own ring sampler (`export/src/stl.ts`).

Measured on the golden shortboard, exporting STL at the default 0.5 cm face size:

| Board                           | Time   | File size |
| ------------------------------- | ------ | --------- |
| Plain                           | 59 ms  | 7.6 MB    |
| Four square channels            | 108 ms | 9.1 MB    |
| The swallow, one curved channel | 131 ms | 8.4 MB    |

## Checks (`channelProblems`)

- Each wall runs along the board, one point across it at each station.
- The walls don't cross.
- The outer wall stays inside the outline wherever the channel has depth.
- The depth stays under half the thickness.

The Channels panel shows them.

## Tests (`channels.test.ts`)

- Depth for each wall shape.
- Anchor counts that don't change along the board.
- A board without channels gives a bit-identical mesh.
- The wall at a fixed ring index.
- Square walls vertical, with the floor lifted by the depth against `bottomZAt`.
- The deck untouched.
- Watertight on an ordinary tail. On a swallow, closed everywhere except that path's
  existing seam at the nose tip, which is there with or without channels.
- The checks, and scaling with the board.

## Not yet

| Gap                       | Why it matters                                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Volume and specs          | They integrate the cross-sections, so they leave channels out: a few tenths of a litre on the test boards                      |
| 2D cross-section view     | Draws the cut over the section (`channelCut`); the scrubbed section between stations, from `loftCrossSection`, doesn't show it |
| Rail bands                | Use `loftCrossSection` too                                                                                                     |
| STEP (`board-surface.ts`) | Fits through the ladder without channels; needs patches split at the walls (step 5)                                            |

## Sections as built (owner review, 2026-11)

The first version cut flat-floored channels with lands, parallel or following the
outline, and its default usually stopped short of the tail. The owner's reference
drawing (four sections, two channels a side, side by side from the stringer to the rail)
and photos showed what shapers build:

| Section      | What it is                                                                                                            |
| ------------ | --------------------------------------------------------------------------------------------------------------------- |
| Step         | Deepest at a steep wall on the rail side; the floor ramps straight back up to nothing toward the stringer. A sawtooth |
| Rounded step | The same, with a radius where the floor meets the wall                                                                |
| Scoop        | Concave arcs meeting in sharp ridges; the stringer is a ridge                                                         |
| Wave         | Smooth flutes with rounded crests                                                                                     |

The photos add placement: channels exit through the tail, start as points well up the
board, and fan out toward the tail.

So `ChannelWall` gained `step` (with a corner `radius`, 0 sharp) and `wave`, beside the
existing `scoop` and the flat-floored `square`, `bevel` and `round`. Depth is now worked
from each wall separately (`profileShare(dIn, dOut, u)`), so a section can be one-sided:

- **step** is u × a quarter round within `radius` of the outer wall, a vertical drop
  there;
- **wave** is (1 − cos 2πu) / 2;
- a channel centred on the stringer with a step section is a V.

Anchors follow each section:

- a step gets a vertical pair at its wall, points round its corner and a crease at its
  inner edge;
- scoops and waves get twelve floor points;
- no anchor lands on the stringer itself (`OFF_STRINGER`), so channels that start there
  don't put a second point on the ring's own.

`frontSpread` and `frontWidth` move each channel's centre line and width linearly from
the tail end to the front end, so walls stay straight in the straight layout. Files from
before have neither and read as 1 (unchanged).

`defaultChannelParams` is now that common build:

- four steps side by side from the stringer to 3 cm inside the rail;
- starting as points about two fifths of the way up, with a 70 % spread;
- running out through the tail wherever it is wide enough for 3 cm channels and thick
  enough for the 5 mm depth to stay under half of it.

## Laid out from a cross-section (owner design, 2026-11)

The owner's design for the panel replaced the tail-end layout above it:

- **Where they are deepest.** The person selects or adds the cross-section where the
  channels are deepest, then adds them there. Width, stringer offset and the follow
  share are all measured at that station.
- **The panel.** Number; Type, picked from icons (step, scoop, wave); Width; Depth;
  Radius top and Radius bottom, for a step; Stringer offset.
- **Align.** Centre–Rail is `follow`, a blend between parallel walls and walls that keep
  their share of the half-width. Tail–Nose is `start` and `end`.
- **Blend.** The white handle is `deepest`: it snaps to a cross-section and selects it,
  and the fades move with it. The green handles are the fade ends. The depth eases
  (3t² − 2t³) from full at the white handle to nothing at each green one, and the
  channels are clipped to start and end, so a start at the tail with a tail fade still
  reaching past it runs them out through the tail at whatever depth they have there.
- **The step's two radii.** The wall stands `lip` in from the outer edge. A quarter round
  of radius `lip` climbs from the uncut bottom to it; it rises straight; a quarter round of
  radius `radius` turns it into the floor. Each radius is held to the depth at the
  station, so a fading step's lip becomes the whole wall.
- **The cross-section view.** It draws the cut over the section on show
  (`channelCut`): the lifted bottom in green, with the mesh's points on it.

Files saved with the first numbers (tail end, run-in, rail margin, lands) only ever
came from the print version's test builds. They open without their channels.

### Next: Apply and Reset (owner request, not built)

The owner asked for two buttons:

- **Apply** turns the typed-in channels into editable ones. It puts their points onto the
  other cross-sections, following the blend and position settings. It unlocks the
  channel curves, so they can be dragged, and the panel's numbers change as they are
  dragged.
- **Reset** clears those edits.

The proposed model keeps the cut in the kernel rather than writing points into the
cross-section curves. Written into those curves, the loft would blend each wall
between stations by arc fraction and smear it, and the walls could only stay parallel
to the stringer with a station at every few centimetres. Instead:

- Apply turns `{from: 'numbers'}` into `{from: 'drawn', params}` and adds a channel
  profile key (width, depth, offset and radii) at each cross-section the channels pass.
- The kernel interpolates those keys along the board, the way it already moves walls,
  so walls stay one crisp edge between stations.
- The cross-section view draws each key's points as handles. Dragging one changes that
  station's key, and the panel shows the key of the section on show.
- The outline view draws the wall curves, and the rocker view the depth, as editable
  splines: the curved channels.
- Reset goes back to the numbers kept in `params`.
