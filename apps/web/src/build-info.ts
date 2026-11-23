// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Which build is running (owner request: to be sure the latest is the one being looked
 * at). Set by vite.config.ts at build time; "dev" where it isn't (tests).
 */
declare const __BUILD_COMMIT__: string | undefined;
declare const __BUILD_TIME__: string | undefined;

/** The commit the build was made from, short. */
export const BUILD_COMMIT: string = typeof __BUILD_COMMIT__ === 'string' ? __BUILD_COMMIT__ : 'dev';

/** When it was built (ISO), or empty. */
export const BUILD_TIME: string = typeof __BUILD_TIME__ === 'string' ? __BUILD_TIME__ : '';

/** "b4350b6 · 23 Nov 2026": the commit and the day it was built. */
export const buildLabel = (commit = BUILD_COMMIT, time = BUILD_TIME): string => {
  const when = time ? new Date(time) : null;
  const day =
    when && !Number.isNaN(when.getTime())
      ? when.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
      : '';
  return day ? `${commit} · ${day}` : commit;
};
