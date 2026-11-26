/* Ported from yuhuan-dev/antigravity-usage-monitor (GPL-3.0) with Magpie read-only import paths. */
/**
 * @fileoverview Shared user prompt wrapper-tag stripping and short session title extraction.
 */

const PROMPT_CLEAN_CONTEXT_SUMMARY_RE = /<CONTEXT_SUMMARY>[\s\S]*?<\/CONTEXT_SUMMARY>/gi;
const PROMPT_CLEAN_SYSTEM_MSG_RE = /<SYSTEM_MESSAGE>[\s\S]*$/i;
const PROMPT_CLEAN_METADATA_RE = /<ADDITIONAL_METADATA>[\s\S]*$/i;
const PROMPT_CLEAN_USER_REQ_RE = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/gi;

/**
 * Strips `<CONTEXT_SUMMARY>`, `<SYSTEM_MESSAGE>`, and `<ADDITIONAL_METADATA>` wrapper blocks
 * and returns the innermost `<USER_REQUEST>` body when present.
 *
 * @param {unknown} rawText
 * @returns {string}
 */
export function extractCleanUserRequestBody(rawText) {
  if (typeof rawText !== 'string' || !rawText.trim()) return '';
  const withoutSummary = rawText
    .replace(PROMPT_CLEAN_CONTEXT_SUMMARY_RE, '')
    .replace(PROMPT_CLEAN_SYSTEM_MSG_RE, '');
  const reqMatches = [...withoutSummary.matchAll(PROMPT_CLEAN_USER_REQ_RE)];
  const target =
    reqMatches.length > 0
      ? reqMatches[reqMatches.length - 1][1]
      : withoutSummary.replace(PROMPT_CLEAN_METADATA_RE, '');
  return String(target || '').replace(PROMPT_CLEAN_METADATA_RE, '');
}

/**
 * Extracts a compact single-line title from raw user prompt text.
 *
 * @param {unknown} rawText
 * @param {number} [maxChars=80]
 * @param {{ firstLineOnly?: boolean }} [options={}]
 * @returns {string}
 */
export function extractShortPromptTitle(rawText, maxChars = 80, { firstLineOnly = false } = {}) {
  const body = extractCleanUserRequestBody(rawText);
  if (!body) return '';
  const candidate = firstLineOnly
    ? body
        .split(/\r?\n/)
        .map((line) => line.replace(/\s+/g, ' ').trim())
        .find(Boolean) || ''
    : body.replace(/\s+/g, ' ').trim();
  if (!candidate) return '';
  return candidate.length <= maxChars ? candidate : `${candidate.slice(0, maxChars - 1).trimEnd()}…`;
}
