/* Ported from yuhuan-dev/antigravity-usage-monitor (GPL-3.0) with Magpie read-only import paths. */
/**
 * @fileoverview Shared `file://` workspace URI decoding, encoding, and SQLite column parsing helpers.
 */

/**
 * Parses a SQLite `workspace_uris` column value (either a JSON string array or a single URI string).
 *
 * @param {unknown} rawVal
 * @returns {string[]}
 */
export function parseWorkspaceUrisColumn(rawVal) {
  const str = String(rawVal || '').trim();
  if (!str) return [];
  if (str.startsWith('[')) {
    try {
      const parsed = JSON.parse(str);
      if (Array.isArray(parsed)) {
        return parsed.map((item) => String(item || '').trim()).filter(Boolean);
      }
    } catch {
      // Fall back to single URI string
    }
  }
  return [str];
}

/**
 * Decodes a `file://` URI or raw filesystem path into a clean slash-normalized path string.
 * Strips the leading slash before Windows drive letters (`/F:/...` -> `F:/...`) while keeping POSIX leading `/`.
 *
 * @param {unknown} rawUri
 * @returns {string}
 */
export function decodeWorkspaceFileUriToPath(rawUri) {
  const raw = String(rawUri || '').trim();
  if (!raw) return '';
  let decoded = raw;
  if (/^file:\/\//i.test(decoded)) {
    decoded = decoded.replace(/^file:\/\//i, '');
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      decoded = decoded.replace(/%3A/gi, ':');
    }
    if (/^\/[A-Za-z]:/.test(decoded)) {
      decoded = decoded.slice(1);
    }
  } else {
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      // Keep original text when percent sequences are literal path chars
    }
  }
  return decoded.replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * Normalizes a workspace URI or local path for cross-platform equality comparison.
 *
 * @param {unknown} rawPath
 * @param {string} [platform=process.platform]
 * @returns {string}
 */
export function normalizePathForWorkspaceMatch(rawPath, platform = process.platform) {
  const clean = decodeWorkspaceFileUriToPath(rawPath).replace(/^\/+(?=[A-Za-z]:)/, '');
  return platform === 'win32' ? clean.toLowerCase() : clean;
}

/**
 * Converts a `file://` URI or local path into a clean unencoded `file://` URI (`ag-cli` style).
 *
 * @param {unknown} rawInput
 * @returns {string}
 */
export function toRawWorkspaceFileUri(rawInput) {
  const raw = String(rawInput || '').trim();
  if (!raw) return '';
  if (/^file:\/\//i.test(raw)) {
    let body = raw.replace(/^file:\/\/\/?/i, '');
    try {
      body = decodeURIComponent(body);
    } catch {
      body = body.replace(/%3A/gi, ':');
    }
    body = body.replace(/\\/g, '/').replace(/^\/+/, '');
    return `file:///${body}`;
  }
  const normalized = raw.replace(/\\/g, '/');
  if (/^[a-zA-Z]:\//.test(normalized)) {
    return `file:///${normalized}`;
  }
  if (normalized.startsWith('/')) {
    return `file://${normalized}`;
  }
  return `file:///${normalized}`;
}

/**
 * Converts a `file://` URI or local path into Antigravity Desktop encoded URI form
 * (lowercase Windows drive letter + `%3A`).
 *
 * @param {unknown} rawInput
 * @returns {string}
 */
export function toDesktopEncodedWorkspaceUri(rawInput) {
  const raw = String(rawInput || '').trim();
  if (!raw) return '';
  if (/^file:\/\/\/[a-z]%3A\//i.test(raw)) {
    return raw.replace(/^file:\/\/\/([a-zA-Z])%3A\//i, (_, d) => `file:///${d.toLowerCase()}%3A/`);
  }
  const unencoded = toRawWorkspaceFileUri(raw);
  const body = unencoded.replace(/^file:\/\/\//i, '');
  const winMatch = body.match(/^([a-zA-Z]):(.*)$/);
  if (winMatch) {
    const drive = winMatch[1].toLowerCase();
    const rest = winMatch[2]
      .split('/')
      .map((seg) => (seg ? encodeURIComponent(seg) : ''))
      .join('/');
    return `file:///${drive}%3A${rest}`;
  }
  const encodedPath = body
    .split('/')
    .map((seg) => (seg ? encodeURIComponent(seg) : ''))
    .join('/');
  return `file:///${encodedPath}`;
}

/**
 * Extracts a short project name and readable display path from a `file:///` URI.
 *
 * @param {unknown} rawUri
 * @returns {{ name: string, displayPath: string }}
 */
export function parseWorkspaceDisplayLabel(rawUri) {
  const raw = String(rawUri || '').trim();
  if (!raw) return { name: '', displayPath: '' };
  let decoded = raw.replace(/^file:\/\/\/?/i, '');
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    decoded = decoded.replace(/%3A/gi, ':');
  }
  decoded = decoded.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!decoded) return { name: '', displayPath: '' };
  const parts = decoded.split('/').filter(Boolean);
  const name = parts.length > 0 ? parts[parts.length - 1] : decoded;
  return { name, displayPath: decoded };
}
