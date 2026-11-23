// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Browser blob download helper, kept in a leaf module with no heavy imports so
 * callers (e.g. save-files.ts) don't pull the board exporters into the fin bundle.
 */

/**
 * How long an object URL outlives its click. Safari and Firefox start the
 * download asynchronously, so revoking straight after `click()` can cancel it;
 * a minute is far longer than any browser takes to pick the blob up.
 */
const REVOKE_AFTER_MS = 60_000;

/**
 * Gap between the files of a multi-file export. Safari keeps only one download
 * per task, and other browsers are more likely to ask once ("allow multiple
 * downloads?") than to drop files when they do not land in the same tick.
 */
export const MULTI_DOWNLOAD_GAP_MS = 400;

export function download(data: BlobPart, filename: string, type: string): void {
  const blob = new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  // Attached for the click: older Firefox ignores clicks on a detached anchor.
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
}
