/* Ported from yuhuan-dev/antigravity-usage-monitor (GPL-3.0) with Magpie read-only import paths. */
/**
 * @fileoverview Shared synchronous atomic text & JSON file writer (`.tmp-${pid}` + `renameSync` with safe cleanup/fallback).
 */

import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Atomically writes UTF-8 text to `filePath` via a sibling `.tmp-${pid}` file and `renameSync`,
 * falling back to direct overwrite if cross-device or Windows lock contention blocks rename.
 *
 * @param {string} filePath
 * @param {string} content
 * @param {{
 *   mkdirFn?: typeof mkdirSync,
 *   writeFn?: typeof writeFileSync,
 *   renameFn?: typeof renameSync,
 *   unlinkFn?: typeof unlinkSync,
 * }|null} [fsOps=null]
 */
export function writeTextFileAtomicSync(filePath, content, fsOps = null) {
  const mkdirFn = fsOps?.mkdirFn || mkdirSync;
  const writeFn = fsOps?.writeFn || writeFileSync;
  const renameFn = fsOps?.renameFn || renameSync;
  const unlinkFn = fsOps?.unlinkFn || unlinkSync;
  mkdirFn(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  let renamed = false;
  try {
    writeFn(tmpPath, content, 'utf8');
    renameFn(tmpPath, filePath);
    renamed = true;
  } catch {
    if (!renamed) {
      try {
        unlinkFn(tmpPath);
      } catch {
        // Ignore missing or locked temporary file cleanup error
      }
    }
    writeFn(filePath, content, 'utf8');
  }
}

/**
 * Atomically serializes and writes a JSON value to `filePath`.
 *
 * @param {string} filePath
 * @param {unknown} data
 * @param {{
 *   indent?: number,
 *   eol?: string,
 *   trailingNewline?: boolean,
 *   fsOps?: Parameters<typeof writeTextFileAtomicSync>[2],
 * }} [options={}]
 */
export function writeJsonAtomicSync(
  filePath,
  data,
  { indent = 2, eol = '\n', trailingNewline = false, fsOps = null } = {}
) {
  let serialized = JSON.stringify(data, null, indent);
  if (eol !== '\n') {
    serialized = serialized.replace(/\n/g, eol);
  }
  if (trailingNewline) {
    serialized += eol;
  }
  writeTextFileAtomicSync(filePath, serialized, fsOps);
}
