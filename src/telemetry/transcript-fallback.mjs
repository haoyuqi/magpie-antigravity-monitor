/* Ported from yuhuan-dev/antigravity-usage-monitor (GPL-3.0) with Magpie read-only import paths. */
/**
 * @fileoverview Shared safe parser for `transcript.jsonl` / `transcript_full.jsonl` and offline model step synthesizer.
 *
 * Shared by `local-scanner.mjs` and `cli-statusline.mjs` to avoid duplicating status normalization, token field mapping,
 * and size-guard logic for oversized `transcript_full.jsonl` files.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const TRANSCRIPT_COMPACT_MAX_BYTES = 24 * 1024 * 1024;
export const TRANSCRIPT_FULL_MAX_BYTES = 12 * 1024 * 1024;

/**
 * Prefer resolving `transcript.jsonl` inside a single logs directory, safely falling back to `transcript_full.jsonl` within the size limit if absent.
 *
 * @param {string} logsDir
 * @param {{ maxFullBytes?: number }} [opts={}]
 * @returns {string}
 */
export function resolveTranscriptPathInLogsDir(
  logsDir,
  { maxFullBytes = TRANSCRIPT_FULL_MAX_BYTES } = {}
) {
  if (!logsDir || typeof logsDir !== 'string') return '';
  const primary = join(logsDir, 'transcript.jsonl');
  if (existsSync(primary)) return primary;
  const full = join(logsDir, 'transcript_full.jsonl');
  if (!existsSync(full)) return '';
  if (Number.isFinite(maxFullBytes) && maxFullBytes > 0) {
    try {
      const st = statSync(full, { throwIfNoEntry: false });
      if (st && Number(st.size || 0) > maxFullBytes) return '';
    } catch {
      return '';
    }
  }
  return full;
}

/**
 * Safely read and parse a JSONL transcript file, applying file-type-based size limits and skipping corrupted lines.
 *
 * @param {string} transcriptPath
 * @param {{ maxBytes?: number }} [opts={}]
 * @returns {object[]}
 */
export function readTranscriptJsonlLines(transcriptPath, { maxBytes } = {}) {
  if (!transcriptPath || !existsSync(transcriptPath)) return [];
  const isFullFile = /transcript_full\.jsonl$/i.test(transcriptPath);
  const limitBytes =
    Number.isFinite(maxBytes) && maxBytes > 0
      ? maxBytes
      : isFullFile
        ? TRANSCRIPT_FULL_MAX_BYTES
        : TRANSCRIPT_COMPACT_MAX_BYTES;
  try {
    const st = statSync(transcriptPath, { throwIfNoEntry: false });
    if (st && Number(st.size || 0) > limitBytes) {
      return [];
    }
  } catch {
    return [];
  }

  let raw = '';
  try {
    raw = readFileSync(transcriptPath, 'utf8');
  } catch {
    return [];
  }
  if (typeof raw !== 'string' || !raw.trim()) return [];

  const lines = [];
  for (const rawLine of raw.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') {
        lines.push(parsed);
      }
    } catch {
      // Ignore trailing partial or malformed JSON lines
    }
  }
  return lines;
}

/**
 * Synthesize a single transcript JSONL record containing token statistics into a standard trajectory model step object.
 *
 * @param {object} line
 * @param {{ stepIndex?: number, deepStep?: object | null }} [opts={}]
 * @returns {object}
 */
export function synthesizeTranscriptModelStep(line, { stepIndex = 0, deepStep = null } = {}) {
  const rawType = String(line?.type || '').trim();
  const upperType = rawType.toUpperCase();
  const isCheckpoint =
    upperType === 'CHECKPOINT' || upperType === 'CORTEX_STEP_TYPE_CHECKPOINT';
  const rawStatus = String(line?.status || '').trim().toUpperCase();
  const mappedStatus = /CANCEL/.test(rawStatus)
    ? 'CORTEX_STEP_STATUS_CANCELED'
    : /ERROR/.test(rawStatus)
      ? 'CORTEX_STEP_STATUS_ERROR'
      : /INTERRUPT/.test(rawStatus)
        ? 'CORTEX_STEP_STATUS_INTERRUPTED'
        : 'CORTEX_STEP_STATUS_DONE';
  const finishedAt = String(
    line?.finished_generating_at ||
      line?.finishedGeneratingAt ||
      line?.completed_at ||
      line?.completedAt ||
      ''
  ).trim();
  const modelKey =
    String(line?.model || line?.generator_model || deepStep?.modelKey || 'unknown').trim() ||
    'unknown';
  const responseModel = String(line?.response_model || deepStep?.responseModel || '').trim();
  const apiProvider = String(line?.api_provider || deepStep?.apiProvider || '').trim();
  const modelDisplayName = String(
    line?.model_display_name || deepStep?.modelDisplayName || ''
  ).trim();
  const thinkingTokens = Number(line?.thinking_tokens ?? deepStep?.thinkingTokens ?? 0) || 0;
  const responseTokens = line?.response_tokens ?? deepStep?.responseTokens;
  const resolvedStepIndex = Number.isFinite(Number(line?.step_index))
    ? Number(line.step_index)
    : stepIndex;

  return {
    type: isCheckpoint ? 'CORTEX_STEP_TYPE_CHECKPOINT' : rawType || 'PLANNER_RESPONSE',
    status: mappedStatus,
    plannerResponse: {
      response: typeof line?.content === 'string' ? line.content : '',
      thinking: typeof line?.thinking === 'string' ? line.thinking : '',
      toolCalls: Array.isArray(line?.tool_calls) ? line.tool_calls : [],
      ...(thinkingTokens > 0 ? { thinkingTokens } : {}),
      ...(responseTokens !== undefined ? { responseTokens } : {}),
    },
    metadata: {
      createdAt: String(line?.created_at || line?.createdAt || deepStep?.createdAt || ''),
      ...(finishedAt ? { finishedGeneratingAt: finishedAt } : {}),
      sourceTrajectoryStepInfo: { stepIndex: resolvedStepIndex },
      modelUsage: {
        model: modelKey,
        ...(responseModel ? { responseModel } : {}),
        ...(apiProvider ? { apiProvider } : {}),
        inputTokens: line?.input_tokens ?? deepStep?.inputTokens ?? 0,
        cacheReadTokens: line?.cache_read_tokens ?? deepStep?.cacheReadTokens ?? 0,
        outputTokens: line?.output_tokens ?? deepStep?.outputTokens ?? 0,
        ...(thinkingTokens > 0 ? { thinkingOutputTokens: thinkingTokens } : {}),
        ...(responseTokens !== undefined ? { responseOutputTokens: responseTokens } : {}),
      },
      ...(modelDisplayName
        ? { generatorMetadata: [{ chatModel: { modelDisplayName } }] }
        : {}),
    },
  };
}

/**
 * Build a CLI statusline-compatible trajectory payload from `transcript.jsonl` (or size-guarded `transcript_full.jsonl`).
 *
 * @param {string} transcriptPath
 * @param {string} cascadeId
 * @param {{ maxBytes?: number }} [opts={}]
 * @returns {{ cascadeId: string, steps: object[], generatorMetadata: object[] } | null}
 */
export function buildTranscriptFallbackTrajectory(transcriptPath, cascadeId, opts = {}) {
  const lines = readTranscriptJsonlLines(transcriptPath, opts);
  if (lines.length === 0) return null;
  const rawSteps = [];
  for (let idx = 0; idx < lines.length; idx++) {
    const parsed = lines[idx];
    const hasTokens =
      parsed.input_tokens !== undefined ||
      parsed.cache_read_tokens !== undefined ||
      parsed.output_tokens !== undefined;
    if (!hasTokens) {
      rawSteps.push(parsed);
      continue;
    }
    rawSteps.push(synthesizeTranscriptModelStep(parsed, { stepIndex: idx }));
  }
  return rawSteps.length > 0 ? { cascadeId, steps: rawSteps, generatorMetadata: [] } : null;
}
