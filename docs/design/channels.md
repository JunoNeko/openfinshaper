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

Each channel is cut on both sides. Typed-in channels will only generate these curves
(step 2), so straight and curved channels are one shape everywhere downstream.
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

They are not wired into the app's status bar yet.

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

| Gap                       | Why it matters                                                                                            |
| ------------------------- | --------------------------------------------------------------------------------------------------------- |
| Volume and specs          | They integrate the cross-sections, so they leave channels out: a few tenths of a litre on the test boards |
| 2D cross-section view     | Uses `loftCrossSection`, so it doesn't show channels                                                      |
| Rail bands                | Use `loftCrossSection` too                                                                                |
| STEP (`board-surface.ts`) | Fits through the ladder without channels; needs patches split at the walls (step 5)                       |
| Native file format and UI | Steps 2–4                                                                                                 |
