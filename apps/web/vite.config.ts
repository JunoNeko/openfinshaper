import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { addCspToHeaders, buildCsp, inlineScripts, scriptHash } from './tools/csp';
import { assertEditorPrecache, rewriteAppShellUrl } from './tools/precache-guard';

const SITE_URL = (process.env.VITE_SITE_URL ?? 'https://openfinshaper.com').replace(/\/+$/, '');

// The Tauri desktop shell loads bundled files over a custom protocol with a
// relative base and has no service-worker support.
const IS_TAURI = !!process.env.TAURI_ENV_PLATFORM;

const OUT_DIR = join(import.meta.dirname, 'dist');

/**
 * Which build this is (owner request: to be sure the latest is the one being looked at),
 * shown beside the fin designer's title: the commit it was built from, from the host's
 * build variables (Cloudflare Pages, Workers Builds) or git, and when.
 */
const gitCommit = (): string => {
  try {
    return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return '';
  }
};
const BUILD_COMMIT = (
  process.env.CF_PAGES_COMMIT_SHA ||
  process.env.WORKERS_CI_COMMIT_SHA ||
  gitCommit() ||
  'dev'
).slice(0, 7);
const BUILD_TIME = new Date().toISOString();

// Kept in sync with SITE_TAGLINE in src/seo/site.ts by hand: that module reads
// import.meta.env, which isn't available in the config's Node context.
const SITE_TAGLINE = 'Free, open-source surf fin design software';

// Routes worth advertising to crawlers: every page the site has (`/` redirects to /fin).
const SITEMAP_ROUTES: { path: string; priority: string; changefreq: string }[] = [
  { path: '/fin', priority: '1.0', changefreq: 'weekly' },
  { path: '/docs/fin-designer', priority: '0.8', changefreq: 'weekly' },
  { path: '/privacy', priority: '0.3', changefreq: 'yearly' },
];

function writeSitemap(outDir: string) {
  const today = new Date().toISOString().slice(0, 10);
  const urls = SITEMAP_ROUTES.map(
    (r) =>
      `  <url>\n    <loc>${SITE_URL}${r.path}</loc>\n    <lastmod>${today}</lastmod>\n` +
      `    <changefreq>${r.changefreq}</changefreq>\n    <priority>${r.priority}</priority>\n  </url>`,
  ).join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
  writeFileSync(join(outDir, 'sitemap.xml'), xml, 'utf8');
}

/** Every .html file under `dir`. */
function htmlFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.html'))
    .map((f) => join(dir, f));
}

/** Add a Content-Security-Policy allowing exactly this build's inline scripts. See tools/csp.ts. */
function writeCsp(outDir: string) {
  const hashes = htmlFiles(outDir).flatMap((f) =>
    inlineScripts(readFileSync(f, 'utf8')).map(scriptHash),
  );
  const headersPath = join(outDir, '_headers');
  const headers = readFileSync(headersPath, 'utf8');
  writeFileSync(headersPath, addCspToHeaders(headers, buildCsp(hashes)), 'utf8');
}

export default defineConfig({
  define: {
    __BUILD_COMMIT__: JSON.stringify(BUILD_COMMIT),
    __BUILD_TIME__: JSON.stringify(BUILD_TIME),
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      disable: IS_TAURI,
      // A hand-written worker: the offline-fallback behaviour this app needs
      // cannot be expressed by a generated one. See src/sw.ts for why.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'prompt',
      injectRegister: null, // registered from the designer only — see UpdatePrompt
      devOptions: { enabled: false }, // keep the dev server (and its e2e run) worker-free
      // Registration scope is the origin root so the worker can serve the
      // offline fallback for other navigations. Manifest `scope` is separate.
      scope: '/',
      manifest: {
        id: '/fin',
        name: 'OpenFinShaper — Surf Fin Design',
        short_name: 'OpenFinShaper',
        description: SITE_TAGLINE,
        // Installing launches straight into the designer, but scope stays '/' so
        // the manifest linked from every prerendered page is in-scope for that
        // page — a narrower scope makes Chrome log a warning on the others.
        start_url: '/fin',
        scope: '/',
        display: 'standalone',
        background_color: '#0A1424',
        theme_color: '#0A1424',
        lang: 'en',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          {
            src: '/icons/maskable-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'maskable',
          },
          {
            src: '/icons/maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      injectManifest: {
        // An allowlist: nothing is precached unless it is named here (the
        // privacy page, for one, is excluded by omission).
        globPatterns: [
          // .wasm: the print-blank export's solid modeller, so blanks export offline.
          'assets/**/*.{js,css,woff2,wasm}',
          // The fin designer's shell: the offline island.
          'fin/index.html',
          // Its help rides along: a few KB of HTML, and being unable to read how
          // a feature works is worst precisely when there's no signal.
          'docs/**/index.html',
          'offline.html',
          'static-loader-data-manifest-*.json',
          'manifest.webmanifest',
          'favicon.svg',
          'icons/*.png',
        ],
        globIgnores: ['**/*.map', 'og-cover.*', 'sitemap.xml', 'robots.txt'],
        // The three.js chunk exceeds the 2 MiB default, and an over-size entry is
        // dropped with only a warning — which would silently break the editor offline.
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        manifestTransforms: [
          (entries) => {
            const manifest = rewriteAppShellUrl(entries);
            // vite-plugin-pwa runs once at closeBundle, before prerendering, when
            // dist/fin/index.html does not exist yet; vite-react-ssg then re-runs
            // it afterwards. Only assert on that second, complete pass.
            if (existsSync(join(OUT_DIR, 'fin/index.html'))) {
              assertEditorPrecache(manifest);
            }
            return { manifest, warnings: [] };
          },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
    strictPort: false,
  },
  preview: {
    port: 4173,
    strictPort: true,
  },
  // Web is served from a domain root (Cloudflare → openfinshaper.com); the
  // Tauri desktop shell loads bundled files over a custom protocol and needs a
  // relative base. Tauri v2 sets TAURI_ENV_PLATFORM during its build command.
  base: process.env.TAURI_ENV_PLATFORM ? './' : '/',
  ssgOptions: {
    dirStyle: 'nested',
    // Keep the default 'sync' (deferred module). Do NOT use 'async': it lets the
    // app module execute before vite-react-ssg's inline __VITE_REACT_SSG_HASH__
    // script runs, so the static-loader-data manifest URL becomes
    // `...-undefined.json` (404) behind a fast CDN — a race that passes locally
    // but crashes in production.
    formatting: 'none',
    onFinished: (outDir: string) => {
      writeSitemap(outDir);
      writeCsp(outDir);
    },
  },
});
