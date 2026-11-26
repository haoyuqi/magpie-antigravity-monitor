/* Ported from yuhuan-dev/antigravity-usage-monitor (GPL-3.0) with Magpie read-only import paths. */
import {
  closeSync, fstatSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writevSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';

const MAX_TRACKED_CACHE_FILES = 16;
const lastWritesByPath = new Map();

function isSameFile(a, b) {
  return b.ino !== 0n && a.dev === b.dev && a.ino === b.ino &&
    a.size === b.size && a.mtimeNs === b.mtimeNs;
}

function readReusableBytes(filePath, expected) {
  let fd;
  try {
    fd = openSync(filePath, 'r');
    const before = fstatSync(fd, { bigint: true });
    if (!isSameFile(before, expected) || before.ctimeNs !== expected.ctimeNs) return null;
    const bytes = readFileSync(fd);
    const after = fstatSync(fd, { bigint: true });
    return isSameFile(before, after) && before.ctimeNs === after.ctimeNs &&
      BigInt(bytes.length) === after.size ? bytes : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// Only reuse step bytes confirmed written in the last write. The scanner replaces changed steps with a new array and still re-serializes session metadata every time.
export function writeTrajectoryCacheFile(filePath, data) {
  const previous = lastWritesByPath.get(filePath) || null;
  const bytes = previous ? readReusableBytes(filePath, previous.file) : null;
  const ranges = new WeakMap();
  const parts = [];
  let position = 0;
  function append(part) {
    const buffer = typeof part === 'string' ? Buffer.from(part) : part;
    parts.push(buffer);
    position += buffer.length;
  }

  append('{');
  let separator = '';
  for (const [id, entry] of Object.entries(data)) {
    const { steps, ...metadata } = entry;
    const header = JSON.stringify(metadata);
    append(`${separator}${JSON.stringify(id)}:${header.slice(0, -1)}${header === '{}' ? '' : ','}"steps":`);
    const range = bytes && previous.ranges.get(steps);
    const start = position;
    append(range ? bytes.subarray(range.start, range.end) : JSON.stringify(steps));
    ranges.set(steps, { start, end: position });
    append('}');
    separator = ',';
  }
  append('}');

  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  let renamed = false;
  try {
    const fd = openSync(temporaryPath, 'wx');
    try {
      // Write in chunks to avoid copying the entire cache into another contiguous buffer.
      const batchSize = 256;
      for (let i = 0; i < parts.length; i += batchSize) {
        const batch = parts.slice(i, i + batchSize);
        const length = batch.reduce((sum, part) => sum + part.length, 0);
        if (writevSync(fd, batch) !== length) throw new Error('Incomplete cache write');
      }
    } finally {
      closeSync(fd);
    }
    const written = statSync(temporaryPath, { bigint: true });
    renameSync(temporaryPath, filePath);
    renamed = true;
    const file = statSync(filePath, { bigint: true });
    lastWritesByPath.delete(filePath);
    if (isSameFile(written, file)) {
      if (lastWritesByPath.size >= MAX_TRACKED_CACHE_FILES) {
        const oldestPath = lastWritesByPath.keys().next().value;
        if (oldestPath !== undefined) lastWritesByPath.delete(oldestPath);
      }
      lastWritesByPath.set(filePath, { filePath, file, ranges });
    }
  } finally {
    if (!renamed) {
      try { unlinkSync(temporaryPath); } catch {}
    }
  }
}
