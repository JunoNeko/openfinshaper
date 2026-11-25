# OpenFinShaper

Free, open-source surf fin CAD/CAM for CNC milling and 3D printing — runs entirely in the browser with offline PWA support.

Design surf fins across four live views (Profile, Foil, Thickness, and 3D), configure Futures, FCS 1/II, US Box, Gbox, and Modii bases, check panel fit, nest multiple fins onto CNC G10 sheets, and export watertight AP214 STEP, binary STL, laminated cores, and 1:1 profile SVGs.

## Development

Requires Node 22+ and pnpm 9.

```bash
pnpm install
pnpm dev          # Start web app at http://localhost:5173/fin
pnpm typecheck    # Strict TypeScript checks across all packages
pnpm test         # Run workspace Vitest suites
pnpm lint         # ESLint + Prettier check
pnpm build        # Build static SSG + PWA bundle in apps/web/dist
```

## Workspace Structure

- `apps/web` — React / Vite / vite-react-ssg web application (`openfinshaper.com`)
- `apps/desktop` — Tauri desktop shell
- `packages/kernel` — Pure geometry, Bezier/B-spline surfaces, fin blade/tab modeling, and CNC panel nesting
- `packages/io` — `.fin.json` and `.finpanel.json` readers and writers
- `packages/store` — Fin state and undo/redo history
- `packages/render2d` — 2D canvas spline editor
- `packages/render3d` — Three.js 3D fin preview and section analysis
- `packages/export` — Single-fin and multi-fin panel STEP + binary STL exporters
- `packages/units` — Length/thickness/area measurement formatting and parsing
- `packages/ui` — Shared UI components
- `worker/` — Cloudflare Worker serving static assets and `/edge` analytics proxy

## License

GPL-3.0-or-later. See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md).
