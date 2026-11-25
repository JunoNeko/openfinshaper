# Repository Guidelines

## Project Structure & Module Organization

OpenFinShaper is a pnpm/Turborepo monorepo for surf fin CAD/CAM. `apps/web` contains the React/Vite product (`openfinshaper.com`); `apps/desktop` is its Tauri shell. Shared code lives under `packages/`: `kernel` for pure fin geometry and CNC panel nesting, `io` for `.fin.json` and `.finpanel.json` file formats, `store` for fin state and undo, `render2d`/`render3d` for 2D/3D views, `export` for STEP and binary STL exporters, `units` for measurements, and `ui` for components. The root `worker/` is the Cloudflare static-assets + analytics proxy. Tests are colocated as `*.test.ts` or `*.test.tsx`; browser flows are in `apps/web/e2e/`. Design notes live in `docs/design/`.

## Build, Test, and Development Commands

Use Node 22+ and pnpm 9.

- `pnpm install` installs all workspace dependencies.
- `pnpm dev` serves the web app at `http://localhost:5173/fin`.
- `pnpm dev:desktop` starts the Tauri desktop shell.
- `pnpm typecheck` runs strict TypeScript checks.
- `pnpm test` runs workspace Vitest suites.
- `pnpm --filter @openshaper/web e2e` runs Playwright browser tests.
- `pnpm build` creates the static web build in `apps/web/dist`.
- `pnpm format` applies Prettier to supported files.

Before opening a PR, run `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build`, matching CI.

## Coding Style & Naming Conventions

Code is strict TypeScript and ESM. Use two spaces, single quotes, semicolons, trailing commas, and a 100-column limit. Use `import type` for type-only imports. Prefer pure functions and immutable data in `packages/kernel`; it, `io`, and `units` must not depend on React, DOM APIs, or Three.js. PascalCase for components and types, camelCase for functions and variables, and kebab-case for non-component filenames.

## Testing Guidelines

Vitest covers unit/integration tests, Testing Library covers React, and Playwright covers end-to-end flows. Add colocated regression tests for behavior changes, state tolerances, and never loosen a tolerance merely to pass.

## Commit & Pull Request Guidelines

Follow Conventional Commits with scopes, for example `feat(fin): add CNC fin panel setup` or `fix(kernel,export): split fin blade STEP into four C2 open patches`. Keep commits focused and use imperative subjects. Contributions are GPL-3.0-or-later.
