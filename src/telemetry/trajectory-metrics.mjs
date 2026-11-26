/* Ported from yuhuan-dev/antigravity-usage-monitor (GPL-3.0) with Magpie read-only import paths. */
/**
 * Client-observed request-level throughput (TPS), time to first token (TTFT),
 * context breakdown, and model identity attribution calculation module.
 *
 * Core design principles:
 * 1. Use end-to-end client-observed request duration (including queue wait, thinking, and tool call generation), applying a unified formula for both plain text generation and tool calls.
 * 2. Never clip outliers based on rate caps or dynamically alter the denominator (such as subtracting thinking time or using only streaming segment duration), ensuring objective and consistent metrics.
 */

import { extractCleanUserRequestBody } from './prompt-clean.mjs';

/** Speed measurement methodology version; increment when duration or sample filtering changes to invalidate cached legacy measurements */
export const MEASUREMENT_VERSION = 4;

/** Model identity attribution version; increment when model recognition priority or placeholder cleanup rules change */
export const MODEL_IDENTITY_VERSION = 1;

/** Minimum total request duration threshold (0.5s) for valid speed measurement, filtering out rate distortion from clock jitter on ultra-short requests */
export const MIN_SPEED_DURATION_SECONDS = 0.5;

/** Minimum output token threshold (50 tokens) for Mean TPS stats, preventing short replies from being dominated by TTFT */
export const MIN_MEAN_OUTPUT_TOKENS = 50;

/**
 * Parse an ISO-8601 timestamp string into a floating-point millisecond timestamp with sub-millisecond precision.
 * Standard `Date.parse` truncates to integer milliseconds; this function extracts the fractional part to preserve sub-millisecond precision.
 *
 * @param {unknown} value ISO-8601 timestamp string
 * @returns {number} Millisecond timestamp (with fractional part), or 0 on parse failure
 */
export function parseIsoMs(value) {
  if (typeof value !== 'string' || !value) {
    return 0;
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    return 0;
  }
  const fraction = value.match(/\.(\d+)(?:Z|[+-]\d{2}:?\d{2})$/i);
  if (!fraction) {
    return ms;
  }
  return Math.floor(ms / 1000) * 1000 + Number(`0.${fraction[1]}`) * 1000;
}

/**
 * Parse a Protobuf Duration string (e.g., `"0.85s"`) into non-negative seconds.
 *
 * @param {unknown} value Raw duration string
 * @returns {number | null} Non-negative seconds (float), or null if invalid
 */
function duration(value) {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?s$/.test(value)) {
    return null;
  }
  const n = Number(value.slice(0, -1));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Validate whether the input value is a valid non-negative safe integer count (supports numbers or digit-only strings).
 *
 * @param {unknown} value Token count value to validate
 * @returns {boolean} Whether it is a valid non-negative safe integer
 */
function validCount(value) {
  const isNumericType =
    typeof value === 'number' ||
    (typeof value === 'string' && /^\d+$/.test(value));
  if (!isNumericType) {
    return false;
  }
  const num = Number(value);
  return Number.isSafeInteger(num) && num >= 0;
}

/**
 * Safely normalize a raw token count to a non-negative integer; falls back to 0 for negatives, NaN, Infinity, empty arrays/objects, or invalid strings.
 *
 * @param {unknown} value
 * @returns {number}
 */
function safeTokenCount(value) {
  if (validCount(value)) {
    return Number(value);
  }
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  if (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim())) {
    const num = Number(value.trim());
    if (Number.isFinite(num) && num >= 0) {
      return Math.floor(num);
    }
  }
  return 0;
}

/**
 * Parse an ISO-8601 timestamp into a nanosecond-precision `BigInt` timestamp.
 *
 * Why `BigInt` nanoseconds are required instead of `Number` floats:
 * Unix epoch nanosecond timestamps are on the order of `1.7e18`, exceeding IEEE-754 double-precision `Number.MAX_SAFE_INTEGER` (`9e15`).
 * Converting directly to `Number` or rounding at the millisecond level would round a `499,999,999 ns` (499.999999ms) request to `0.500s`,
 * falsely crossing the `MIN_SPEED_DURATION_SECONDS` (0.5s) validity threshold. Subtracting in exact `BigInt` nanoseconds first and then converting the small delta to `Number` eliminates precision loss.
 *
 * @param {unknown} value ISO-8601 timestamp string
 * @returns {bigint | null} Nanosecond BigInt timestamp, or null if malformed
 */
function timestampNs(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const match = value.match(
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/
  );
  if (!match) {
    return null;
  }
  const ms = Date.parse(match[1] + match[3]);
  if (!Number.isFinite(ms)) {
    return null;
  }
  const nanosPart = BigInt((match[2] || '').padEnd(9, '0'));
  return BigInt(ms) * 1_000_000n + nanosPart;
}

/**
 * Compute exact duration in seconds between request start and end timestamps.
 * Subtracts in the `BigInt` nanosecond domain (`end - start`) first, then divides by `1e9` to convert to float seconds,
 * preventing millisecond rounding from misclassifying a 499.999ms request as >= 0.5s.
 *
 * @param {unknown} startValue Request start time (`createdAt`)
 * @param {unknown} endValue Request end time (`finishedGeneratingAt` or `completedAt`)
 * @returns {number | null} Nanosecond-accurate request duration in seconds, or null if timestamps are missing or inverted
 */
function requestDuration(startValue, endValue) {
  const start = timestampNs(startValue);
  const end = timestampNs(endValue);
  if (start === null || end === null || start <= 0n || end < start) {
    return null;
  }
  return Number(end - start) / 1e9;
}

/**
 * Compute elapsed seconds between two millisecond timestamps.
 *
 * @param {number} start Start millisecond timestamp
 * @param {number} end End millisecond timestamp
 * @returns {number | null} Elapsed seconds, or null if invalid
 */
function elapsed(start, end) {
  return start > 0 && end >= start ? (end - start) / 1000 : null;
}

/**
 * Estimate token count of text from its UTF-8 byte length (empirical ratio: ~3 UTF-8 bytes per token, rounded up).
 *
 * @param {unknown} text Raw text to estimate
 * @returns {number} Estimated token count
 */
function estimateUtf8Tokens(text) {
  if (typeof text !== 'string' || !text) {
    return 0;
  }
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 3);
}

/**
 * Classify a system prompt section into a specific context sub-bucket by its name or title.
 *
 * @param {unknown} name Section name or title
 * @returns {'skills' | 'userRules' | 'mcpTools' | 'systemPrompt'} Context category key
 */
function classifyPromptSection(name, type = '') {
  const key = String(name || type || '')
    .trim()
    .toLowerCase()
    .replace(/^token_type_/, '')
    .replace(/[\s-]+/g, '_');
  if (key === 'skills' || key === 'skill') {
    return 'skills';
  }
  if (
    key === 'user_rules' ||
    key === 'user_rule' ||
    key === 'rules' ||
    key === 'rule'
  ) {
    return 'userRules';
  }
  if (
    key === 'mcp_servers' ||
    key === 'mcp_tools' ||
    key === 'mcp' ||
    key.startsWith('mcp_')
  ) {
    return 'mcpTools';
  }
  return 'systemPrompt';
}

/**
 * Determine whether a tool item belongs to MCP (Model Context Protocol) extension tools or resource-call tools.
 *
 * @param {unknown} name Tool name
 * @param {unknown} [source=''] Tool source identifier
 * @param {unknown} [type=''] Tool type identifier
 * @returns {boolean} Whether it belongs to the MCP tools category
 */
function isMcpToolItem(name, source = '', type = '') {
  const n = String(name || '').trim().toLowerCase();
  const src = String(source || '').toUpperCase();
  const t = String(type || '').toUpperCase();
  return (
    src.includes('MCP') ||
    t.includes('MCP') ||
    n.startsWith('mcp_') ||
    n.startsWith('mcp-') ||
    n === 'call_mcp_tool' ||
    n === 'list_mcp_resources' ||
    n === 'read_mcp_resource'
  );
}

/**
 * Identify the conversation sub-category of a `TOKEN_TYPE_CHAT_MESSAGES` child item (e.g., `"391: CHECKPOINT"`, `"404: GENERIC"`).
 *
 * @param {object} child
 * @returns {'checkpoint'|'assistant'|'subagent'|'userInput'|'toolResults'}
 */
function classifyChatMessageChild(child) {
  const rawName = String(child?.name || child?.type || '').trim().toUpperCase();
  const stepType = rawName.replace(/^\d+:\s*/, '');
  if (stepType.includes('CHECKPOINT') || stepType.includes('SUMMARY')) {
    return 'checkpoint';
  }
  if (
    stepType.includes('PLANNER_RESPONSE') ||
    stepType.includes('ASSISTANT') ||
    stepType.includes('MODEL')
  ) {
    return 'assistant';
  }
  if (stepType.includes('SYSTEM_MESSAGE') || stepType.includes('SUBAGENT')) {
    return 'subagent';
  }
  if (stepType.includes('USER_INPUT') || stepType === 'USER') {
    return 'userInput';
  }
  // GENERIC, VIEW_FILE, RUN_COMMAND, CODE_ACTION, etc. are all tool call return results
  return 'toolResults';
}

/**
 * Classify a `messagePrompts` entry into one of the 5 conversation context sub-channels by its source and content features.
 *
 * @param {object} m
 * @returns {'toolResults'|'checkpoint'|'subagent'|'assistant'|'userInput'}
 */
function classifyMessagePrompt(m) {
  const text = String(m?.prompt ?? m?.content ?? '');
  const src = String(m?.source || '').toUpperCase();
  if (src.includes('TOOL')) {
    return 'toolResults';
  }
  if (text.startsWith('<CONTEXT_SUMMARY>')) {
    return 'checkpoint';
  }
  if (text.includes('<SYSTEM_MESSAGE>')) {
    return 'subagent';
  }
  if (src.includes('SYSTEM') || src.includes('ASSISTANT') || src.includes('MODEL')) {
    return 'assistant';
  }
  return 'userInput';
}

/**
 * Extract and decompose the 10 context token composition categories from `chatModel` metadata:
 * - `systemPromptTokens`: core system prompt
 * - `userRulesTokens`: user-defined global/workspace rules
 * - `skillsTokens`: injected Skills instructions
 * - `systemToolsTokens`: built-in system tool definitions
 * - `mcpToolsTokens`: external MCP server tool and resource definitions
 * - `checkpointTokens`: context compaction summary (Checkpoint)
 * - `userInputTokens`: user input messages
 * - `assistantTokens`: main agent responses and thinking
 * - `subagentTokens`: subagent report messages
 * - `toolResultsTokens`: tool execution return results
 *
 * @param {object} chat `generatorMetadata.chatModel` object
 * @returns {object | null} Context token composition breakdown, or null when no metadata is available
 */
export function extractContextBreakdown(chat) {
  if (!chat || typeof chat !== 'object') {
    return null;
  }
  const tb = chat?.chatStartMetadata?.contextWindowMetadata?.tokenBreakdown;
  const groups = Array.isArray(tb?.groups) ? tb.groups : [];
  const promptSections = Array.isArray(chat?.promptSections)
    ? chat.promptSections
    : [];
  const tools = Array.isArray(chat?.tools) ? chat.tools : [];
  const messagePrompts = Array.isArray(chat?.messagePrompts)
    ? chat.messagePrompts
    : [];

  if (
    !groups.length &&
    !promptSections.length &&
    !tools.length &&
    !messagePrompts.length
  ) {
    return null;
  }

  let userInputTokens = 0;
  let assistantTokens = 0;
  let toolResultsTokens = 0;
  let subagentTokens = 0;
  let checkpointTokens = 0;
  let systemToolsTokens = 0;
  let mcpToolsTokens = 0;
  let skillsTokens = 0;
  let systemPromptTokens = 0;
  let userRulesTokens = 0;

  let hasPromptGroup = false;
  let hasToolsGroup = false;
  let hasMessagesGroup = false;

  // Phase 1: Extract and split the 10 context categories from the native tokenBreakdown.groups tree
  for (const g of groups) {
    const gType = String(g?.type || '').toUpperCase();
    const gName = String(g?.name || '').trim().toLowerCase();
    const gSource = String(g?.source || '').toUpperCase();
    const gTokens = Math.max(0, Number(g?.numTokens || 0));
    const children = Array.isArray(g?.children) ? g.children : [];

    if (gType === 'TOKEN_TYPE_SYSTEM_PROMPT' || gName === 'system prompt') {
      hasPromptGroup = true;
      if (children.length > 0) {
        let childSum = 0;
        for (const c of children) {
          const tok = Math.max(0, Number(c?.numTokens || 0));
          childSum += tok;
          const bucket = classifyPromptSection(c?.name ?? c?.title, c?.type);
          if (bucket === 'skills') {
            skillsTokens += tok;
          } else if (bucket === 'userRules') {
            userRulesTokens += tok;
          } else if (bucket === 'mcpTools') {
            mcpToolsTokens += tok;
          } else {
            systemPromptTokens += tok;
          }
        }
        if (gTokens > childSum) {
          systemPromptTokens += gTokens - childSum;
        }
      } else {
        systemPromptTokens += gTokens;
      }
    } else if (
      gType === 'TOKEN_TYPE_SKILLS' ||
      gName === 'skills' ||
      gName === 'skill'
    ) {
      hasPromptGroup = true;
      skillsTokens += gTokens;
    } else if (
      gType === 'TOKEN_TYPE_RULES' ||
      gType === 'TOKEN_TYPE_USER_RULES' ||
      gName === 'rules' ||
      gName === 'user rules' ||
      gName === 'user_rules'
    ) {
      hasPromptGroup = true;
      userRulesTokens += gTokens;
    } else if (
      gType === 'TOKEN_TYPE_SUBAGENTS' ||
      gType === 'TOKEN_TYPE_PLUGINS' ||
      gName === 'subagents' ||
      gName === 'plugins' ||
      gName === 'featured plugins' ||
      gName === 'featured_plugins'
    ) {
      hasPromptGroup = true;
      systemPromptTokens += gTokens;
    } else if (
      gType === 'TOKEN_TYPE_TOOLS' ||
      gName === 'tools' ||
      gType.includes('MCP') ||
      gSource.includes('MCP')
    ) {
      hasToolsGroup = true;
      if (children.length > 0) {
        let childSum = 0;
        for (const c of children) {
          const tok = Math.max(0, Number(c?.numTokens || 0));
          childSum += tok;
          if (
            isMcpToolItem(c?.name, c?.source || g?.source, c?.type || g?.type)
          ) {
            mcpToolsTokens += tok;
          } else {
            systemToolsTokens += tok;
          }
        }
        if (gTokens > childSum) {
          if (isMcpToolItem(g?.name, g?.source, g?.type)) {
            mcpToolsTokens += gTokens - childSum;
          } else {
            systemToolsTokens += gTokens - childSum;
          }
        }
      } else if (isMcpToolItem(g?.name, g?.source, g?.type)) {
        mcpToolsTokens += gTokens;
      } else {
        systemToolsTokens += gTokens;
      }
    } else if (
      gType === 'TOKEN_TYPE_CHAT_MESSAGES' ||
      gName === 'chat messages' ||
      gName === 'messages'
    ) {
      hasMessagesGroup = true;
      if (children.length > 0) {
        let childSum = 0;
        for (const c of children) {
          const tok = Math.max(0, Number(c?.numTokens || 0));
          childSum += tok;
          const msgBucket = classifyChatMessageChild(c);
          if (msgBucket === 'checkpoint') {
            checkpointTokens += tok;
          } else if (msgBucket === 'assistant') {
            assistantTokens += tok;
          } else if (msgBucket === 'subagent') {
            subagentTokens += tok;
          } else if (msgBucket === 'userInput') {
            userInputTokens += tok;
          } else {
            toolResultsTokens += tok;
          }
        }
        if (gTokens > childSum) {
          userInputTokens += gTokens - childSum;
        }
      } else if (messagePrompts.length > 0) {
        const mpBuckets = {
          userInput: 0,
          assistant: 0,
          toolResults: 0,
          subagent: 0,
          checkpoint: 0,
        };
        let mpSum = 0;
        for (const m of messagePrompts) {
          const text = String(m?.prompt ?? m?.content ?? '');
          const tok =
            Number.isFinite(Number(m?.numTokens)) && Number(m?.numTokens) >= 0
              ? Number(m.numTokens)
              : estimateUtf8Tokens(text);
          const bucketKey = classifyMessagePrompt(m);
          mpBuckets[bucketKey] += tok;
          mpSum += tok;
        }
        if (gTokens > 0 && mpSum > 0) {
          const keys = ['userInput', 'assistant', 'toolResults', 'subagent', 'checkpoint'];
          const scaled = {};
          let assigned = 0;
          let largestKey = 'userInput';
          for (const k of keys) {
            if (mpBuckets[k] > mpBuckets[largestKey]) largestKey = k;
            scaled[k] = mpBuckets[k] > 0 ? Math.floor((mpBuckets[k] * gTokens) / mpSum) : 0;
            assigned += scaled[k];
          }
          scaled[largestKey] += Math.max(0, gTokens - assigned);
          userInputTokens += scaled.userInput;
          assistantTokens += scaled.assistant;
          toolResultsTokens += scaled.toolResults;
          subagentTokens += scaled.subagent;
          checkpointTokens += scaled.checkpoint;
        } else if (mpSum > 0) {
          userInputTokens += mpBuckets.userInput;
          assistantTokens += mpBuckets.assistant;
          toolResultsTokens += mpBuckets.toolResults;
          subagentTokens += mpBuckets.subagent;
          checkpointTokens += mpBuckets.checkpoint;
        } else if (gTokens > 0) {
          userInputTokens += gTokens;
        }
      } else if (gTokens > 0) {
        userInputTokens += gTokens;
      }
    } else if (gTokens > 0) {
      // Fallback to catch future top-level prompt groups so tokenBreakdown.groups never drops any group
      hasPromptGroup = true;
      const fallbackBucket = classifyPromptSection(g?.name, g?.type);
      if (fallbackBucket === 'skills') {
        skillsTokens += gTokens;
      } else if (fallbackBucket === 'userRules') {
        userRulesTokens += gTokens;
      } else if (fallbackBucket === 'mcpTools') {
        mcpToolsTokens += gTokens;
      } else {
        systemPromptTokens += gTokens;
      }
    }
  }

  // Phase 2 (A): When groups lack a system prompt group, fall back to promptSections using explicit tokens or UTF-8 byte length (byteLength / 3)
  if (!hasPromptGroup && promptSections.length > 0) {
    for (const s of promptSections) {
      const tok =
        Number.isFinite(Number(s?.numTokens)) && Number(s?.numTokens) >= 0
          ? Number(s.numTokens)
          : estimateUtf8Tokens(s?.content ?? s?.text ?? '');
      const bucket = classifyPromptSection(s?.title ?? s?.name);
      if (bucket === 'skills') {
        skillsTokens += tok;
      } else if (bucket === 'userRules') {
        userRulesTokens += tok;
      } else if (bucket === 'mcpTools') {
        mcpToolsTokens += tok;
      } else {
        systemPromptTokens += tok;
      }
    }
  }

  // Phase 2 (B): When groups lack a tools group, fall back to estimating from concatenated name, description, and JSON Schema in tools list
  if (!hasToolsGroup && tools.length > 0) {
    for (const t of tools) {
      const rawText = `${t?.name || ''}${t?.description || ''}${t?.jsonSchemaString || ''}`;
      const tok =
        Number.isFinite(Number(t?.numTokens)) && Number(t?.numTokens) >= 0
          ? Number(t.numTokens)
          : estimateUtf8Tokens(rawText);
      if (isMcpToolItem(t?.name, t?.source, t?.type)) {
        mcpToolsTokens += tok;
      } else {
        systemToolsTokens += tok;
      }
    }
  }

  // Phase 2 (C): When groups lack a chat messages group, fall back to messagePrompts classified by source and content features
  if (!hasMessagesGroup && messagePrompts.length > 0) {
    for (const m of messagePrompts) {
      const text = String(m?.prompt ?? m?.content ?? '');
      const tok =
        Number.isFinite(Number(m?.numTokens)) && Number(m?.numTokens) >= 0
          ? Number(m.numTokens)
          : estimateUtf8Tokens(text);
      const bucketKey = classifyMessagePrompt(m);
      if (bucketKey === 'toolResults') {
        toolResultsTokens += tok;
      } else if (bucketKey === 'checkpoint') {
        checkpointTokens += tok;
      } else if (bucketKey === 'subagent') {
        subagentTokens += tok;
      } else if (bucketKey === 'assistant') {
        assistantTokens += tok;
      } else {
        userInputTokens += tok;
      }
    }
  }

  const messagesTokens =
    userInputTokens +
    assistantTokens +
    toolResultsTokens +
    subagentTokens +
    checkpointTokens;

  const totalTokens =
    messagesTokens +
    systemToolsTokens +
    mcpToolsTokens +
    skillsTokens +
    systemPromptTokens +
    userRulesTokens;

  return {
    messagesTokens,
    userInputTokens,
    assistantTokens,
    toolResultsTokens,
    subagentTokens,
    checkpointTokens,
    systemToolsTokens,
    mcpToolsTokens,
    skillsTokens,
    systemPromptTokens,
    userRulesTokens,
    totalTokens,
  };
}

const ANOMALY_SEVERITY_PRIORITY = Object.freeze({
  rate_limit: 9,
  auth_or_model: 8,
  timeout: 7,
  capacity: 6,
  disconnect: 5,
  upstream: 4,
  model_output: 3,
  safety: 2,
  error: 1,
  canceled: 0,
});

/**
 * Classify model call retry, timeout, or error text into a standardized anomaly type.
 *
 * @param {string} [rawError='']
 * @param {{ reasonCode?: number, errorCode?: number, isCanceled?: boolean }} [opts]
 * @returns {'timeout'|'rate_limit'|'capacity'|'disconnect'|'upstream'|'model_output'|'safety'|'auth_or_model'|'canceled'|'error'}
 */
export function classifyStepAnomalyError(
  rawError = '',
  { reasonCode = 0, errorCode = 0, isCanceled = false } = {}
) {
  const s = String(rawError || '').trim();
  if (isCanceled || /context canceled by user|stream reading error:\s*context canceled/i.test(s)) {
    return 'canceled';
  }
  if (reasonCode === 2 || /model output error|model produced invalid output|invalid tool call/i.test(s)) {
    return 'model_output';
  }
  if (
    errorCode === 429 ||
    /\b429\b|RESOURCE_EXHAUSTED|quota reached|rate.?limit/i.test(s)
  ) {
    return 'rate_limit';
  }
  if (
    /stream idle timeout|TLS handshake timeout|i\/o timeout|context deadline exceeded|\btimeout\b/i.test(
      s
    )
  ) {
    return 'timeout';
  }
  if (
    errorCode === 503 ||
    /\b503\b|UNAVAILABLE|No capacity available|overloaded|high demand/i.test(s)
  ) {
    return 'capacity';
  }
  if (
    /wsarecv|wsasend|forcibly closed|connection reset|broken pipe|ECONNRESET|unexpected EOF|:\s*EOF\b|The stream was interrupted|no such host|dial tcp|tls:|bad record MAC/i.test(
      s
    )
  ) {
    return 'disconnect';
  }
  if (/safety filter|content safety|sensitive words/i.test(s)) {
    return 'safety';
  }
  if (
    errorCode === 500 ||
    errorCode === 502 ||
    errorCode === 504 ||
    /\b(?:500|502|504)\b|\bINTERNAL\b|BAD_GATEWAY/i.test(s)
  ) {
    return 'upstream';
  }
  if (
    errorCode === 400 ||
    errorCode === 401 ||
    errorCode === 403 ||
    errorCode === 404 ||
    /\b(?:400|401|403|404)\b|PERMISSION_DENIED|UNAUTHENTICATED|FAILED_PRECONDITION|NOT_FOUND|unknown model|unsupported mime/i.test(
      s
    )
  ) {
    return 'auth_or_model';
  }
  return 'error';
}

function cleanAnomalyErrorExcerpt(rawText) {
  let s = String(rawText || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return '';
  s = s.replace(/^API error \(attempt \d+\):\s*/i, '');
  s = s.replace(/^agent executor error:\s*generating and executing:\s*/i, '');
  s = s.replace(/^request failed:\s*/i, '');
  return s.length > 180 ? `${s.slice(0, 179)}…` : s;
}

function extractErrorStepPayload(step) {
  if (!step || typeof step !== 'object') return null;
  const em = step.errorMessage;
  const errObj = em?.error && typeof em.error === 'object' ? em.error : em;
  const shortErr = String(
    errObj?.shortError ||
      errObj?.message ||
      step.error ||
      ''
  ).trim();
  const userMsg = String(errObj?.userErrorMessage || '').trim();
  const fallbackContent =
    !shortErr && !userMsg && typeof step.content === 'string'
      ? step.content.replace(/^Error:\s*/i, '').trim()
      : '';
  const message = shortErr || userMsg || fallbackContent;
  if (!message) return null;
  const errorCode = Number(errObj?.errorCode || 0) || 0;
  const terminal = Boolean(em?.shouldShowUser);
  return { message, userMsg, errorCode, terminal };
}

function buildStepAnomalyRecord(step, meta, chat, pendingErrorSteps = []) {
  const retryInfosRaw = [
    ...(Array.isArray(chat?.retryInfos) ? chat.retryInfos : []),
    ...(Array.isArray(meta?.retryInfos) ? meta.retryInfos : []),
  ];
  const retryErrorEntries = [];
  for (let i = 0; i < retryInfosRaw.length; i += 1) {
    const ri = retryInfosRaw[i];
    if (!ri || typeof ri !== 'object') continue;
    const errText = String(ri.error || ri.errorMessage || '').trim();
    const reasonCode = Number(ri.reasonCode || 0) || 0;
    const delaySec = duration(ri.retryDelay);
    if (!errText && !(reasonCode > 0 && reasonCode !== 3)) continue;
    const kind = classifyStepAnomalyError(errText, { reasonCode });
    // Do not add duplicate warning badges for pure user cancellations without other retries (the speed column already shows 'Canceled')
    if (kind === 'canceled') continue;
    retryErrorEntries.push({
      attempt: retryErrorEntries.length + 1,
      kind,
      delaySec: delaySec != null && delaySec > 0 ? +delaySec.toFixed(1) : 0,
      message: cleanAnomalyErrorExcerpt(errText),
      terminal: reasonCode === 3,
      source: 'retry',
    });
  }

  const events = [...retryErrorEntries];
  const declaredRetryCount = Math.max(0, Math.floor(Number(chat?.retryCount || 0)));

  // Merge preceding ERROR_MESSAGE steps in the same turn (deduplicating same-source retries already recorded by retryInfos while preserving stream-resume/safety-filter/offline log supplements)
  const usedRetryKinds = new Map();
  for (const ev of retryErrorEntries) {
    usedRetryKinds.set(ev.kind, (usedRetryKinds.get(ev.kind) || 0) + 1);
  }
  const matchedKindBudget = new Map(usedRetryKinds);

  for (const errStep of pendingErrorSteps || []) {
    const info = extractErrorStepPayload(errStep);
    if (!info) continue;
    const kind = classifyStepAnomalyError(info.message, { errorCode: info.errorCode });
    if (kind === 'canceled') continue;
    const isInterruptOrSafety =
      kind === 'safety' ||
      /The stream was interrupted/i.test(info.message) ||
      info.terminal;
    if (!isInterruptOrSafety) {
      const rem = matchedKindBudget.get(kind) || 0;
      if (rem > 0) {
        matchedKindBudget.set(kind, rem - 1);
        continue;
      }
    }
    events.push({
      attempt: events.length + 1,
      kind,
      delaySec: 0,
      message: cleanAnomalyErrorExcerpt(info.message),
      terminal: Boolean(info.terminal),
      source: 'error_step',
    });
  }

  const isStatusError = step?.status === 'CORTEX_STEP_STATUS_ERROR';
  const isStatusInterrupted = step?.status === 'CORTEX_STEP_STATUS_INTERRUPTED';
  if (events.length === 0 && (isStatusError || isStatusInterrupted)) {
    events.push({
      attempt: 1,
      kind: isStatusInterrupted ? 'disconnect' : 'error',
      delaySec: 0,
      message: '',
      terminal: isStatusError,
      source: 'status',
    });
  }

  const count = Math.max(events.length, declaredRetryCount);
  if (count <= 0) return null;

  if (events.length === 0 && declaredRetryCount > 0) {
    events.push({
      attempt: 1,
      kind: 'error',
      delaySec: 0,
      message: '',
      terminal: false,
      source: 'retry_count',
    });
  }

  const kinds = {};
  let totalDelaySec = 0;
  let hasDanger = isStatusError;
  for (const ev of events) {
    kinds[ev.kind] = (kinds[ev.kind] || 0) + 1;
    if (ev.delaySec > 0) totalDelaySec += ev.delaySec;
    if (ev.terminal || ev.kind === 'rate_limit' || ev.kind === 'auth_or_model') {
      hasDanger = true;
    }
  }
  // Determine primary category: sort by occurrence count descending, breaking ties by severity priority
  let primaryKind = events[0].kind;
  let bestCount = -1;
  let bestPrio = -1;
  for (const [k, c] of Object.entries(kinds)) {
    const prio = ANOMALY_SEVERITY_PRIORITY[k] ?? 1;
    if (c > bestCount || (c === bestCount && prio > bestPrio)) {
      primaryKind = k;
      bestCount = c;
      bestPrio = prio;
    }
  }

  const roundedDelay = totalDelaySec > 0 ? +totalDelaySec.toFixed(1) : 0;
  const severity = hasDanger ? 'danger' : 'warn';
  const compactEvents = events.slice(0, 6).map((ev, idx) => ({
    attempt: idx + 1,
    kind: ev.kind,
    ...(ev.delaySec > 0 ? { delaySec: ev.delaySec } : {}),
    ...(ev.message ? { message: ev.message } : {}),
    ...(ev.terminal ? { terminal: true } : {}),
  }));
  const kindSig = Object.entries(kinds)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, v]) => `${k}=${v}`)
    .join(',');
  const sig = `${primaryKind}:${count}:${severity}:${roundedDelay}:${kindSig}`;
  return {
    anomaly: {
      count,
      primaryKind,
      severity,
      totalDelaySec: roundedDelay,
      kinds,
      events: compactEvents,
    },
    anomalySig: sig,
  };
}

/**
 * Extract standardized model step metrics from raw trajectory steps and generator metadata.
 *
 * Core processing flow:
 * 1. **5-tier model identity evidence chain (highest to lowest priority)**:
 *    Inspect the 5 sources on the request itself in order, taking the first non-empty, non-placeholder value (excluding `0`, `unknown`, `MODEL_UNSPECIFIED`, `MODEL_UNKNOWN`):
 *    - Priority 1: `usage.model` (model identifier recorded in step `modelUsage` or `retryInfos[0].usage`)
 *    - Priority 2: `chat.usage.model` (model identifier recorded in associated `generatorMetadata.chatModel.usage`)
 *    - Priority 3: `chat.model` (`chatModel` request-level model identifier)
 *    - Priority 4: `metadata.generatorModel` (generator model recorded at top level of step `metadata`)
 *    - Priority 5: `chat.responseModel` (specific upstream response model name)
 * 2. **Speed filtering & exclusion reasons (`timingReason` / `speedReason`)**:
 *    - `'canceled'`: generation was canceled; keep usage but exclude from speed measurement;
 *    - `'incomplete_or_invalid_timing'`: no evidence of completed generation, or `totalDurationSec` is missing/non-positive;
 *    - `'invalid_output_tokens'`: `outputTokens` is not a valid non-negative safe integer;
 *    - `'short_timing'`: total request duration is below `MIN_SPEED_DURATION_SECONDS` (0.5s), prone to timer granularity noise;
 *    - `'inconsistent_timing'`: native TTFT `nativeTtftSec` exceeds `totalDurationSec + 0.01s` (clock or metadata contradiction);
 *    - `'compaction'` / `'short_sample'`: per-step throughput is computable, but the step is a context compaction checkpoint (`CORTEX_STEP_TYPE_CHECKPOINT`)
 *      or has fewer than `MIN_MEAN_OUTPUT_TOKENS` (50 tokens) of output, so it is excluded from mean speed samples (`speedSampleEligible`).
 * 3. **Tail-step context backfill logic**:
 *    If the last model step itself has no `contextBreakdown` (e.g., lightweight tail update or missing inline `chatModel`),
 *    but `generatorMetadata` for the trajectory has a recent `latestBreakdownChat`, backfill that context breakdown and max budget onto the tail step
 *    so the panel's current conversation context watermark is not lost.
 *
 * @param {Array<object>} [rawSteps=[]] Raw Cortex steps array
 * @param {Array<object>} [generatorMetadata=[]] Trajectory-level generator metadata list
 * @returns {Array<object>} Standardized step metrics list with inferred compaction step models
 */
const IMAGE_REF_INPUT_TOKENS = 560;

function isGenerateImageStep(step) {
  if (!step || typeof step !== 'object') return false;
  if (step.generateImage && typeof step.generateImage === 'object') return true;
  const t = String(step.type || '').trim().toUpperCase();
  if (t === 'CORTEX_STEP_TYPE_GENERATE_IMAGE' || t === 'GENERATE_IMAGE') return true;
  const toolName = String(step?.metadata?.toolCall?.name || '')
    .trim()
    .replace(/^default_api:/i, '')
    .toLowerCase();
  return toolName === 'generate_image';
}

function estimatePromptTextTokens(text) {
  const s = String(text || '').trim();
  if (!s) return 0;
  let asciiChars = 0;
  let nonAsciiChars = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) <= 0x7f) asciiChars += 1;
    else nonAsciiChars += 1;
  }
  return Math.max(1, Math.round(asciiChars * 0.25 + nonAsciiChars * 0.6));
}

function resolveImageGenResolutionTier(gi = {}, args = {}) {
  const w = Number(gi?.width || gi?.imageDimensions?.width) || 0;
  const h = Number(gi?.height || gi?.imageDimensions?.height) || 0;
  const maxDim = Math.max(w, h);
  const pixels = w > 0 && h > 0 ? w * h : 0;
  if (maxDim > 0) {
    if (maxDim <= 640 && (pixels === 0 || pixels <= 360_000)) return '0.5K';
    if (maxDim <= 1536 && (pixels === 0 || pixels <= 1_650_000)) return '1K';
    if (maxDim <= 2816 && (pixels === 0 || pixels <= 6_000_000)) return '2K';
    return '4K';
  }
  const rawSize = String(gi?.imageSize || args?.ImageSize || args?.imageSize || '')
    .trim()
    .toUpperCase();
  if (rawSize === '0.5K' || rawSize === '512' || rawSize === '512PX') return '0.5K';
  if (rawSize === '2K' || rawSize === '2048' || rawSize === '2048PX') return '2K';
  if (rawSize === '4K' || rawSize === '4096' || rawSize === '4096PX') return '4K';
  return '1K';
}

function resolveImageGenOutputTokens(modelId, resTier) {
  const m = String(modelId || '').toLowerCase();
  if (/2[._-]5[-_]flash[-_]image/.test(m)) {
    return 1290;
  }
  if (/3(?:[._-]\d+)?[-_]pro[-_]image/.test(m)) {
    return resTier === '4K' ? 2000 : 1120;
  }
  if (resTier === '0.5K') return 747;
  if (resTier === '2K') return 1680;
  if (resTier === '4K') return 2520;
  return 1120;
}

/**
 * Estimate equivalent input and output tokens for a `generate_image` step using Google AI Studio's official image-generation billing rules.
 *
 * @param {object} step
 * @param {boolean} hasGeneratedResult
 * @returns {{ modelName: string, inputTokens: number, outputTokens: number, aspectRatio: string, resolutionTier: string, imageName: string }}
 */
export function estimateImageGenStepUsage(step, hasGeneratedResult = true) {
  const gi = step?.generateImage && typeof step.generateImage === 'object' ? step.generateImage : {};
  let args = {};
  const rawArgs = step?.metadata?.toolCall?.argumentsJson;
  if (typeof rawArgs === 'string' && rawArgs.trim()) {
    try {
      const parsed = JSON.parse(rawArgs);
      if (parsed && typeof parsed === 'object') args = parsed;
    } catch {
      // Ignore incomplete streaming arguments JSON
    }
  } else if (rawArgs && typeof rawArgs === 'object') {
    args = rawArgs;
  }
  const modelName =
    String(gi.modelName || gi.model || args?.Model || args?.model || '').trim() ||
    'gemini-3.1-flash-image';
  const prompt = String(gi.prompt || args?.Prompt || args?.prompt || '').trim();
  const refImages = Array.isArray(args?.ImagePaths)
    ? args.ImagePaths.length
    : Array.isArray(args?.imagePaths)
      ? args.imagePaths.length
      : 0;
  const inputTokens = estimatePromptTextTokens(prompt) + refImages * IMAGE_REF_INPUT_TOKENS;
  const resolutionTier = resolveImageGenResolutionTier(gi, args);
  const outputTokens = hasGeneratedResult
    ? resolveImageGenOutputTokens(modelName, resolutionTier)
    : 0;
  const aspectRatio = String(gi.aspectRatio || args?.AspectRatio || args?.aspectRatio || '').trim();
  const imageName = String(gi.imageName || args?.ImageName || args?.imageName || '').trim();
  return {
    modelName,
    inputTokens,
    outputTokens,
    aspectRatio,
    resolutionTier,
    imageName,
  };
}

export function extractModelSteps(rawSteps = [], generatorMetadata = []) {
  const genByStep = new Map();
  const orchestratorExecModels = new Set();
  const collectOrchestratorExecModel = (pc) => {
    const execModel = pc?.planExecuteConfig?.executionModel;
    if (typeof execModel !== 'string' || !execModel.trim()) {
      return;
    }
    const cleanExec = execModel.trim();
    const cleanPlan = String(pc?.planModel || '').trim();
    if (
      /orchestrator|MODEL_PLACEHOLDER_M(?:667|681|537)\b/i.test(
        `${pc?.modelName || ''} ${cleanPlan}`
      ) ||
      (cleanPlan && cleanExec !== cleanPlan)
    ) {
      orchestratorExecModels.add(cleanExec);
    }
  };
  let latestBreakdownChat = null;
  let latestBreakdownStepIdx = -1;
  let latestBreakdownUnindexed = false;
  let lastKnownGmStepIdx = -1;

  for (const gm of generatorMetadata || []) {
    collectOrchestratorExecModel(gm?.plannerConfig);
    if (!gm?.chatModel) {
      continue;
    }
    let gmMaxIdx = -1;
    for (const index of gm?.stepIndices || []) {
      const numIdx = Number(index);
      genByStep.set(numIdx, gm);
      if (Number.isFinite(numIdx) && numIdx > gmMaxIdx) {
        gmMaxIdx = numIdx;
      }
    }
    if (gmMaxIdx >= 0) {
      lastKnownGmStepIdx = Math.max(lastKnownGmStepIdx, gmMaxIdx);
    }
    if (extractContextBreakdown(gm.chatModel)) {
      latestBreakdownChat = gm.chatModel;
      latestBreakdownStepIdx = gmMaxIdx >= 0 ? gmMaxIdx : lastKnownGmStepIdx;
      latestBreakdownUnindexed = gmMaxIdx < 0;
    }
  }

  const result = [];
  let lastCompactionStepIdx = -1;
  let turnCounter = 0;
  let activeTurnIndex = null;
  let pendingTurnPrompts = [];
  let pendingTurnHasMedia = false;
  let hasUnconsumedTurn = false;

  const isUserTurnBoundary = (step) => {
    if (!step || typeof step !== 'object') return false;
    const t = String(step.type || '').trim().toUpperCase();
    if (t === 'CORTEX_STEP_TYPE_USER_INPUT' || t === 'USER_INPUT') {
      return true;
    }
    return Boolean(step.userInput && typeof step.userInput === 'object');
  };

  const hasHumanUserTurn = rawSteps.some(isUserTurnBoundary);

  const isSystemWakeupBoundary = (step) => {
    if (hasHumanUserTurn || !step || typeof step !== 'object') return false;
    if (isCheckpointStep(step)) return false;
    const t = String(step.type || '').trim().toUpperCase();
    if (t !== 'CORTEX_STEP_TYPE_SYSTEM_MESSAGE' && t !== 'SYSTEM_MESSAGE') {
      return false;
    }
    const rawMsg = String(step?.systemMessage?.message || step?.content || '').trim();
    const withoutSummary = rawMsg
      .replace(/<CONTEXT_SUMMARY>[\s\S]*?<\/CONTEXT_SUMMARY>/gi, '')
      .trim();
    if (!withoutSummary || /BROWSER_HOST_FACTS/i.test(withoutSummary)) return false;
    return true;
  };

  const extractSystemWakeupInfo = (step) => {
    let raw = String(step?.systemMessage?.message || step?.content || '').trim();
    const sysMatches = [...raw.matchAll(/<SYSTEM_MESSAGE>([\s\S]*?)<\/SYSTEM_MESSAGE>/gi)];
    if (sysMatches.length > 0) {
      raw = sysMatches[sysMatches.length - 1][1].trim();
    } else {
      raw = raw.replace(/^The following is a <SYSTEM_MESSAGE>[\s\S]*?<SYSTEM_MESSAGE>/i, '').replace(/<\/SYSTEM_MESSAGE>\s*$/i, '').trim();
    }
    raw = raw.replace(/^\[Message\]\s+timestamp=\S+\s+sender=\S+\s+priority=\S+\s+content=/i, '').trim();

    const doorbellMatch = raw.match(/^\[swarm\]\s+new board message\s+#(\d+)\s*$/i);
    if (doorbellMatch) {
      const tag = `[swarm] #${doorbellMatch[1]}`;
      return { cleanText: tag, legacyPrompt: tag, hasMedia: false, isDoorbellOnly: true };
    }

    const assignMatch = raw.match(
      /^You have just started\.\s*Your assignment\s*\(recorded on the board as #(\d+)\s+for\s+@?([^\s):]+)\)\s*:\s*([\s\S]*)$/i
    );
    if (assignMatch) {
      const seq = assignMatch[1];
      const member = assignMatch[2];
      const bodyLines = String(assignMatch[3] || '')
        .split(/\r?\n/)
        .map((l) => l.replace(/\s+/g, ' ').trim())
        .filter(Boolean);
      const bodyPreview = bodyLines.join(' ');
      const full = bodyPreview ? `#${seq} @${member} · ${bodyPreview}` : `#${seq} @${member}`;
      const cleanText = full.length > 180 ? `${full.slice(0, 179)}…` : full;
      return { cleanText, legacyPrompt: cleanText, hasMedia: false, isDoorbellOnly: false };
    }

    const boardDeltaMatch = raw.match(
      /^\[board\]\s+the latest message is #(\d+)\s*\(you have read up to #(\d+)\)/i
    );
    if (boardDeltaMatch) {
      const tag = `[board] #${boardDeltaMatch[2]} -> #${boardDeltaMatch[1]}`;
      return { cleanText: tag, legacyPrompt: tag, hasMedia: false, isDoorbellOnly: true };
    }

    const monitorTickMatch = raw.match(/^\[monitor\]\s+tick:[^(]*\(iteration\s+(\d+)\)\s*$/i);
    if (monitorTickMatch) {
      const tag = `[monitor] tick #${monitorTickMatch[1]}`;
      return { cleanText: tag, legacyPrompt: tag, hasMedia: false, isDoorbellOnly: false };
    }

    const cleaned = raw
      .split(/\r?\n/)
      .map((l) => l.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join('\n');
    const cleanText = cleaned.length > 180 ? `${cleaned.slice(0, 179)}…` : cleaned;
    return { cleanText, legacyPrompt: cleanText, hasMedia: false, isDoorbellOnly: false };
  };

  const extractUserTurnInfo = (step) => {
    const ui = step?.userInput;
    let raw = '';
    if (typeof ui?.userResponse === 'string' && ui.userResponse.trim()) {
      raw = ui.userResponse;
    } else if (Array.isArray(ui?.items)) {
      raw = ui.items
        .map((it) => (typeof it?.text === 'string' ? it.text : ''))
        .filter(Boolean)
        .join('\n');
    } else if (typeof step?.content === 'string' && step.content.trim()) {
      raw = extractCleanUserRequestBody(step.content);
    }
    const cleaned = String(raw || '')
      .split(/\r?\n/)
      .map((l) => l.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join('\n');
    const mediaArr = Array.isArray(ui?.media)
      ? ui.media
      : Array.isArray(step?.media)
        ? step.media
        : [];
    const hasMedia = mediaArr.length > 0;
    const cleanText = cleaned.length > 180 ? `${cleaned.slice(0, 179)}…` : cleaned;
    const legacyRaw = !cleaned ? (hasMedia ? '[Image/attachment prompt]' : '') : hasMedia ? `${cleaned} [with attachment]` : cleaned;
    const legacyPrompt = legacyRaw.length > 180 ? `${legacyRaw.slice(0, 179)}…` : legacyRaw;
    return { cleanText, legacyPrompt, hasMedia };
  };

  let pendingTurnCleanPrompts = [];
  let pendingTurnDoorbellOnly = false;
  let pendingErrorSteps = [];

  const isErrorMessageStep = (step) => {
    if (!step || typeof step !== 'object') return false;
    const t = String(step.type || '').trim().toUpperCase();
    return (
      t === 'CORTEX_STEP_TYPE_ERROR_MESSAGE' ||
      t === 'ERROR_MESSAGE' ||
      Boolean(step.errorMessage && typeof step.errorMessage === 'object')
    );
  };

  const mergeTrailingErrorsIntoStep = (targetStep, errSteps) => {
    if (!targetStep || !Array.isArray(errSteps) || errSteps.length === 0) return;
    const prevEvents = Array.isArray(targetStep.anomaly?.events) ? targetStep.anomaly.events : [];
    const trailingRec = buildStepAnomalyRecord(null, null, null, errSteps);
    if (!trailingRec) return;
    const isStatusOnlyPlaceholder =
      prevEvents.length === 1 &&
      Number(targetStep.anomaly?.count || 0) === 1 &&
      !prevEvents[0].message &&
      !(Number(prevEvents[0].delaySec) > 0) &&
      (prevEvents[0].kind === 'error' || prevEvents[0].kind === 'disconnect');
    if (prevEvents.length === 0 || isStatusOnlyPlaceholder) {
      const nextAnomaly =
        isStatusOnlyPlaceholder &&
        targetStep.anomaly?.severity === 'danger' &&
        trailingRec.anomaly.severity !== 'danger'
          ? { ...trailingRec.anomaly, severity: 'danger' }
          : trailingRec.anomaly;
      targetStep.anomaly = nextAnomaly;
      targetStep.anomalySig =
        nextAnomaly === trailingRec.anomaly
          ? trailingRec.anomalySig
          : trailingRec.anomalySig.replace(':warn:', ':danger:');
      return;
    }
    const mergedKinds = { ...(targetStep.anomaly.kinds || {}) };
    for (const [k, c] of Object.entries(trailingRec.anomaly.kinds || {})) {
      mergedKinds[k] = (mergedKinds[k] || 0) + c;
    }
    const mergedCount = Number(targetStep.anomaly.count || 0) + Number(trailingRec.anomaly.count || 0);
    const mergedDelay = +(
      Number(targetStep.anomaly.totalDelaySec || 0) + Number(trailingRec.anomaly.totalDelaySec || 0)
    ).toFixed(1);
    const mergedSeverity =
      targetStep.anomaly.severity === 'danger' || trailingRec.anomaly.severity === 'danger'
        ? 'danger'
        : 'warn';
    let primaryKind = targetStep.anomaly.primaryKind || trailingRec.anomaly.primaryKind;
    let bestCount = -1;
    let bestPrio = -1;
    for (const [k, c] of Object.entries(mergedKinds)) {
      const prio = ANOMALY_SEVERITY_PRIORITY[k] ?? 1;
      if (c > bestCount || (c === bestCount && prio > bestPrio)) {
        primaryKind = k;
        bestCount = c;
        bestPrio = prio;
      }
    }
    const combinedEvents = [...prevEvents, ...(trailingRec.anomaly.events || [])]
      .slice(0, 6)
      .map((ev, i) => ({ ...ev, attempt: i + 1 }));
    const kindSig = Object.entries(mergedKinds)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([k, v]) => `${k}=${v}`)
      .join(',');
    targetStep.anomaly = {
      count: mergedCount,
      primaryKind,
      severity: mergedSeverity,
      totalDelaySec: mergedDelay,
      kinds: mergedKinds,
      events: combinedEvents,
    };
    targetStep.anomalySig = `${primaryKind}:${mergedCount}:${mergedSeverity}:${mergedDelay}:${kindSig}`;
  };

  rawSteps.forEach((s, index) => {
    const isHumanBoundary = isUserTurnBoundary(s);
    const isWakeupBoundary = !isHumanBoundary && isSystemWakeupBoundary(s);
    if (isHumanBoundary || isWakeupBoundary) {
      if (pendingErrorSteps.length > 0 && result.length > 0) {
        const lastPrev = result[result.length - 1];
        if (lastPrev.turnIndex === activeTurnIndex) {
          mergeTrailingErrorsIntoStep(lastPrev, pendingErrorSteps);
        }
      }
      pendingErrorSteps = [];
      const { cleanText, legacyPrompt, hasMedia, isDoorbellOnly = false } = isHumanBoundary
        ? extractUserTurnInfo(s)
        : extractSystemWakeupInfo(s);
      if (!hasUnconsumedTurn) {
        hasUnconsumedTurn = true;
        pendingTurnPrompts = legacyPrompt ? [legacyPrompt] : [];
        pendingTurnCleanPrompts = cleanText ? [cleanText] : [];
        pendingTurnHasMedia = hasMedia;
        pendingTurnDoorbellOnly = Boolean(isWakeupBoundary && isDoorbellOnly);
      } else if (isWakeupBoundary && pendingTurnDoorbellOnly && !isDoorbellOnly && cleanText) {
        // When merging consecutive wakeup steps, overwrite the preceding #seq-only doorbell prompt with the following actual brief/task body
        pendingTurnPrompts = legacyPrompt ? [legacyPrompt] : [];
        pendingTurnCleanPrompts = [cleanText];
        pendingTurnDoorbellOnly = false;
      } else if (!(isWakeupBoundary && isDoorbellOnly && !pendingTurnDoorbellOnly)) {
        if (
          legacyPrompt &&
          pendingTurnPrompts[pendingTurnPrompts.length - 1] !== legacyPrompt
        ) {
          pendingTurnPrompts.push(legacyPrompt);
        }
        if (
          cleanText &&
          pendingTurnCleanPrompts[pendingTurnCleanPrompts.length - 1] !== cleanText
        ) {
          pendingTurnCleanPrompts.push(cleanText);
        }
        if (hasMedia) pendingTurnHasMedia = true;
      }
    }

    if (isErrorMessageStep(s)) {
      pendingErrorSteps.push(s);
      return;
    }

    const m = s?.metadata || {};
    const u = m?.modelUsage || m?.retryInfos?.[0]?.usage;
    const isImageGen = !u && isGenerateImageStep(s);
    if (!u && !isImageGen) {
      return;
    }
    const stepPendingErrors = pendingErrorSteps;
    pendingErrorSteps = [];

    let stepIsTurnStart = false;
    let stepTurnPrompt = '';
    let stepTurnPromptClean = '';
    let stepTurnHasMedia = false;
    let stepTurnMediaOnly = false;
    if (hasUnconsumedTurn) {
      turnCounter += 1;
      activeTurnIndex = turnCounter;
      stepIsTurnStart = true;
      const joinedPrompt = pendingTurnPrompts.join('\n').trim();
      const joinedClean = pendingTurnCleanPrompts.join('\n').trim();
      stepTurnPrompt =
        joinedPrompt.length > 180 ? `${joinedPrompt.slice(0, 179)}…` : joinedPrompt;
      stepTurnPromptClean =
        joinedClean.length > 180 ? `${joinedClean.slice(0, 179)}…` : joinedClean;
      stepTurnHasMedia = pendingTurnHasMedia;
      stepTurnMediaOnly = Boolean(pendingTurnHasMedia && !stepTurnPromptClean);
      hasUnconsumedTurn = false;
      pendingTurnPrompts = [];
      pendingTurnCleanPrompts = [];
      pendingTurnHasMedia = false;
      pendingTurnDoorbellOnly = false;
    }

    const stepIndex = m.sourceTrajectoryStepInfo?.stepIndex ?? index;
    if (isImageGen) {
      const isClearedImg = s.status === 'CORTEX_STEP_STATUS_CLEARED';
      const explicitlyIncompleteImg = Boolean(
        s.status && s.status !== 'CORTEX_STEP_STATUS_DONE' && !isClearedImg
      );
      const startIsoImg = m.startedAt || m.createdAt || null;
      const startMsImg = parseIsoMs(m.createdAt || m.startedAt);
      const measuredImgDuration = requestDuration(
        startIsoImg,
        isClearedImg ? null : m.completedAt
      );
      const completeImg = !explicitlyIncompleteImg && measuredImgDuration !== null;
      const hasGeneratedMedia = Boolean(
        s?.generateImage?.generatedMedia?.uri ||
          (completeImg &&
            s.status !== 'CORTEX_STEP_STATUS_ERROR' &&
            s.status !== 'CORTEX_STEP_STATUS_CANCELED')
      );
      const imgUsage = estimateImageGenStepUsage(s, hasGeneratedMedia);
      const totalDurationSecImg = completeImg ? measuredImgDuration : null;

      let imgTimingReason = null;
      if (s.status === 'CORTEX_STEP_STATUS_CANCELED') {
        imgTimingReason = 'canceled';
      } else if (s.status === 'CORTEX_STEP_STATUS_ERROR') {
        imgTimingReason = 'error';
      } else if (s.status === 'CORTEX_STEP_STATUS_INTERRUPTED') {
        imgTimingReason = 'interrupted';
      } else if (!completeImg || !(totalDurationSecImg > 0)) {
        imgTimingReason = 'incomplete_or_invalid_timing';
      } else if (!(imgUsage.outputTokens > 0)) {
        imgTimingReason = 'invalid_output_tokens';
      } else if (totalDurationSecImg < MIN_SPEED_DURATION_SECONDS) {
        imgTimingReason = 'short_timing';
      }

      const imgTokPerSec =
        imgTimingReason === null ? imgUsage.outputTokens / totalDurationSecImg : null;
      const anomalyRecImg = buildStepAnomalyRecord(s, m, null, stepPendingErrors);

      result.push({
        stepIndex,
        isCompactionStep: false,
        isImageGenStep: true,
        modelKey: imgUsage.modelName,
        modelSource: 'generateImage.modelName',
        responseModel: imgUsage.modelName,
        modelIdentityVersion: MODEL_IDENTITY_VERSION,
        modelDisplayName: '',
        apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
        createdAt: m.createdAt || m.startedAt || null,
        createdAtMs: Math.floor(startMsImg),
        hasVisibleText: false,
        hasToolCalls: false,
        inputTokens: imgUsage.inputTokens,
        cacheReadTokens: 0,
        outputTokens: imgUsage.outputTokens,
        thinkingTokens: 0,
        responseTokens: imgUsage.outputTokens,
        estimatedContextTokens: 0,
        maxContextBudgetTokens: 0,
        contextBreakdown: null,
        measurementVersion: MEASUREMENT_VERSION,
        isComplete: completeImg,
        nativeTtftSec: null,
        nativeStreamSec: null,
        viewableDelaySec: elapsed(startMsImg, parseIsoMs(m.viewableAt)),
        ttftSec: null,
        ttftSource: 'unavailable',
        thinkingDurationSec: null,
        totalDurationSec: totalDurationSecImg,
        totalTokPerSec: imgTokPerSec,
        speedBasis: imgTokPerSec === null ? 'unavailable' : 'request_total',
        speedSampleEligible: false,
        speedReason: imgTimingReason || 'image_gen',
        ...(anomalyRecImg
          ? { anomaly: anomalyRecImg.anomaly, anomalySig: anomalyRecImg.anomalySig }
          : {}),
        turnIndex: activeTurnIndex,
        isTurnStart: stepIsTurnStart,
        ...(stepIsTurnStart && stepTurnPrompt ? { turnPrompt: stepTurnPrompt } : {}),
        ...(stepIsTurnStart && stepTurnPromptClean ? { turnPromptClean: stepTurnPromptClean } : {}),
        ...(stepIsTurnStart ? { turnHasMedia: stepTurnHasMedia, turnMediaOnly: stepTurnMediaOnly } : {}),
      });
      return;
    }
    if (Array.isArray(m.generatorMetadata)) {
      for (const g of m.generatorMetadata) {
        collectOrchestratorExecModel(g?.plannerConfig);
      }
    }
    const inlineChat = Array.isArray(m.generatorMetadata)
      ? m.generatorMetadata.find((g) => g?.chatModel)
      : null;
    const gm = inlineChat || genByStep.get(Number(stepIndex));
    const chat = gm?.chatModel;
    const p = s.plannerResponse || {};
    const isCompactionStep = isCheckpointStep(s);
    if (isCompactionStep && Number.isFinite(Number(stepIndex))) {
      lastCompactionStepIdx = Math.max(lastCompactionStepIdx, Number(stepIndex));
    }

    const inputTokens = safeTokenCount(u.inputTokens);
    const cacheReadTokens = safeTokenCount(u.cacheReadTokens);
    const outputTokens = safeTokenCount(u.outputTokens);
    const rawThinkingTok = safeTokenCount(
      p.thinkingTokens ??
        u.thinkingOutputTokens ??
        chat?.usage?.thinkingOutputTokens ??
        0
    );
    const rawResponseTok =
      p.responseTokens ??
      u.responseOutputTokens ??
      chat?.usage?.responseOutputTokens;
    const thinkingTokens =
      rawResponseTok !== undefined && rawResponseTok !== null
        ? rawThinkingTok
        : Math.min(outputTokens, rawThinkingTok);
    const responseTokens =
      rawResponseTok !== undefined && rawResponseTok !== null
        ? safeTokenCount(rawResponseTok)
        : Math.max(0, outputTokens - thinkingTokens);

    const start = parseIsoMs(m.createdAt);
    // Trajectory cleanup can mark generated steps as CLEARED; still use the original generation end time so cleanup time is not included in speed measurement.
    const isCleared = s.status === 'CORTEX_STEP_STATUS_CLEARED';
    const measuredDuration = requestDuration(
      m.createdAt,
      m.finishedGeneratingAt || (isCleared ? null : m.completedAt)
    );
    const explicitlyIncomplete = Boolean(
      s.status && s.status !== 'CORTEX_STEP_STATUS_DONE' && !isCleared
    );
    const complete = !explicitlyIncomplete && measuredDuration !== null;
    const totalDurationSec = complete ? measuredDuration : null;
    const nativeTtftSec = duration(chat?.timeToFirstToken);

    // Phase timers (streamingDuration / thinkingDuration) are for diagnostic display only:
    // buffered tool calls can make streamingDuration tiny, so never use it as the speed denominator or subtract it from total duration
    const nativeStreamSec = duration(chat?.streamingDuration);
    const thinkingDurationSec = duration(p.thinkingDuration);

    // Validate status, duration, and token validity first, then check for compaction steps and short samples.
    let timingReason = null;
    if (s.status === 'CORTEX_STEP_STATUS_CANCELED') {
      timingReason = 'canceled';
    } else if (s.status === 'CORTEX_STEP_STATUS_ERROR') {
      timingReason = 'error';
    } else if (s.status === 'CORTEX_STEP_STATUS_INTERRUPTED') {
      timingReason = 'interrupted';
    } else if (!complete || !(totalDurationSec > 0)) {
      timingReason = 'incomplete_or_invalid_timing';
    } else if (!validCount(u.outputTokens)) {
      timingReason = 'invalid_output_tokens';
    } else if (totalDurationSec < MIN_SPEED_DURATION_SECONDS) {
      timingReason = 'short_timing';
    } else if (
      nativeTtftSec !== null &&
      nativeTtftSec > totalDurationSec + 0.01
    ) {
      timingReason = 'inconsistent_timing';
    }

    const totalTokPerSec =
      timingReason === null ? outputTokens / totalDurationSec : null;
    const shortOutputSample =
      totalTokPerSec !== null && outputTokens < MIN_MEAN_OUTPUT_TOKENS;
    const speedReason =
      timingReason ||
      (isCompactionStep
        ? 'compaction'
        : shortOutputSample
          ? 'short_sample'
          : null);

    const context = chat?.chatStartMetadata?.contextWindowMetadata;
    const contextBreakdown = extractContextBreakdown(chat);

    // 5-tier model identity evidence chain: trust only explicit fields on the current request;
    // if a Checkpoint compaction step lacks model fields, inferCompactionStepModels will fall back to neighboring steps in the same trajectory later
    const isValidModelValue = (value) =>
      typeof value === 'string' &&
      value.trim() &&
      !/^(?:0|unknown|MODEL_(?:UNSPECIFIED|UNKNOWN))$/i.test(value.trim());

    const modelCandidates = [
      ['usage.model', u.model],
      ['chat.usage.model', chat?.usage?.model],
      ['chat.model', chat?.model],
      ['metadata.generatorModel', m.generatorModel],
      ['chat.responseModel', chat?.responseModel],
    ];
    const identity = modelCandidates.find(([, value]) =>
      isValidModelValue(value)
    );
    const rawResponseModel = [
      chat?.responseModel,
      u?.responseModel,
      m?.responseModel,
    ].find(isValidModelValue);

    const resolvedModelKey = identity ? identity[1].trim() : 'unknown';
    const rawDisplayName = String(chat?.modelDisplayName || '').trim();
    const isExplicitNamedWorker = /\bOrchestrator\s+Worker\s*\([^)]+\)/i.test(rawDisplayName);
    const isLeakedPlannerOrchDisplay =
      Boolean(rawDisplayName) &&
      /\borchestrator\b/i.test(rawDisplayName) &&
      !isExplicitNamedWorker;
    const isGenericWorkerDisplay =
      !rawDisplayName ||
      isLeakedPlannerOrchDisplay ||
      /^gemini\s+(?:flash|pro)(?:\s+worker)?$/i.test(rawDisplayName);
    const isHydrogenWorkerStep =
      resolvedModelKey === 'MODEL_PLACEHOLDER_M669' ||
      /^gemini-flash-worker-agy$/i.test(rawResponseModel || '');
    const isNeonWorkerStep = /^gemini-(?:4-)?neon-worker-agy$/i.test(rawResponseModel || '');
    const isExecWorkerStep = orchestratorExecModels.has(resolvedModelKey);

    let resolvedDisplayName = rawDisplayName;
    if (isHydrogenWorkerStep && isGenericWorkerDisplay) {
      resolvedDisplayName = 'Orchestrator Worker (Hydrogen)';
    } else if (isNeonWorkerStep && isGenericWorkerDisplay) {
      resolvedDisplayName = 'Orchestrator Worker (Neon)';
    } else if (isExecWorkerStep && isLeakedPlannerOrchDisplay) {
      // If a non-Hydrogen execution model (e.g., Neon / Claude Worker) inherited the main orchestrator display name, clear it so its own model identity resolves
      resolvedDisplayName = '';
    }

    const anomalyRec = buildStepAnomalyRecord(s, m, chat, stepPendingErrors);

    result.push({
      stepIndex,
      isCompactionStep,
      modelKey: resolvedModelKey,
      modelSource: identity?.[0] || 'unavailable',
      responseModel: rawResponseModel ? rawResponseModel.trim() : '',
      modelIdentityVersion: MODEL_IDENTITY_VERSION,
      modelDisplayName: resolvedDisplayName,
      apiProvider: u.apiProvider || chat?.usage?.apiProvider || '',
      createdAt: m.createdAt || null,
      createdAtMs: Math.floor(start),
      hasVisibleText:
        String(p.modifiedResponse || p.response || '').trim().length > 0,
      hasToolCalls: Array.isArray(p.toolCalls) && p.toolCalls.length > 0,
      inputTokens,
      cacheReadTokens,
      outputTokens,
      thinkingTokens,
      responseTokens,
      estimatedContextTokens: Number(
        context?.estimatedTokensUsed || contextBreakdown?.totalTokens || 0
      ),
      maxContextBudgetTokens: Number(context?.maxContextTokens || 256000),
      ...(context?.maxContextTokens > 0 ? { reportedContextLimitTokens: Number(context.maxContextTokens) } : {}),
      contextBreakdown,
      measurementVersion: MEASUREMENT_VERSION,
      isComplete: complete,
      nativeTtftSec,
      nativeStreamSec,
      viewableDelaySec: elapsed(start, parseIsoMs(m.viewableAt)),
      ttftSec: nativeTtftSec,
      ttftSource: nativeTtftSec === null ? 'unavailable' : 'native',
      thinkingDurationSec,
      totalDurationSec,
      totalTokPerSec,
      speedBasis: totalTokPerSec === null ? 'unavailable' : 'request_total',
      speedSampleEligible:
        totalTokPerSec !== null && !shortOutputSample && !isCompactionStep,
      speedReason,
      ...(anomalyRec ? { anomaly: anomalyRec.anomaly, anomalySig: anomalyRec.anomalySig } : {}),
      turnIndex: activeTurnIndex,
      isTurnStart: stepIsTurnStart,
      ...(stepIsTurnStart && stepTurnPrompt ? { turnPrompt: stepTurnPrompt } : {}),
      ...(stepIsTurnStart && stepTurnPromptClean ? { turnPromptClean: stepTurnPromptClean } : {}),
      ...(stepIsTurnStart ? { turnHasMedia: stepTurnHasMedia, turnMediaOnly: stepTurnMediaOnly } : {}),
    });
  });

  if (pendingErrorSteps.length > 0 && result.length > 0) {
    const lastStep = result[result.length - 1];
    if (lastStep.turnIndex === activeTurnIndex) {
      mergeTrailingErrorsIntoStep(lastStep, pendingErrorSteps);
    }
  }

  // Tail-step context backfill:
  // 1. When the tail is a normal step missing contextBreakdown, backfill if the latest valid generatorMetadata has not crossed a compaction boundary
  //    (including breakdowns inherited from prior positions for tail `stepIndices: []` after undo/interruption; skip if unindexed breakdown is significantly larger than current step to avoid inflating a rolled-back watermark);
  // 2. When the tail is a compaction step and its preceding pre-compaction anchor step lacks contextBreakdown (common with tail `stepIndices: []`), backfill onto that pre-compaction step
  //    so the 5 static context channels can still be inherited after compaction (never write directly onto the compaction step itself).
  if (result.length > 0 && latestBreakdownChat) {
    const applyFallbackBreakdown = (targetStep) => {
      const fallbackBreakdown = extractContextBreakdown(latestBreakdownChat);
      if (!fallbackBreakdown) return;
      const targetPrompt =
        Number(targetStep?.inputTokens || 0) + Number(targetStep?.cacheReadTokens || 0);
      const bdTotal = Number(fallbackBreakdown.totalTokens || 0);
      if (
        latestBreakdownUnindexed &&
        targetPrompt > 0 &&
        bdTotal > 0 &&
        targetPrompt < bdTotal * 0.5
      ) {
        return;
      }
      const fallbackCtx =
        latestBreakdownChat?.chatStartMetadata?.contextWindowMetadata;
      targetStep.contextBreakdown = fallbackBreakdown;
      if (!targetStep.estimatedContextTokens) {
        targetStep.estimatedContextTokens = Number(
          fallbackCtx?.estimatedTokensUsed || fallbackBreakdown?.totalTokens || 0
        );
      }
      if (fallbackCtx?.maxContextTokens) {
        targetStep.maxContextBudgetTokens = Number(fallbackCtx.maxContextTokens);
        if (!targetStep.reportedContextLimitTokens) {
          targetStep.reportedContextLimitTokens = Number(fallbackCtx.maxContextTokens);
        }
      }
    };

    const lastStep = result[result.length - 1];
    if (
      !lastStep.isCompactionStep &&
      !lastStep.contextBreakdown &&
      (lastCompactionStepIdx < 0 || latestBreakdownStepIdx > lastCompactionStepIdx)
    ) {
      applyFallbackBreakdown(lastStep);
    } else if (
      lastStep.isCompactionStep &&
      (latestBreakdownStepIdx < 0 || latestBreakdownStepIdx <= lastCompactionStepIdx)
    ) {
      for (let i = result.length - 2; i >= 0; i -= 1) {
        const preStep = result[i];
        if (!preStep || preStep.isCompactionStep) break;
        if (!preStep.contextBreakdown) {
          applyFallbackBreakdown(preStep);
        }
        break;
      }
    }
  }

  return inferCompactionStepModels(result);
}

/**
 * Infer the owning model for context compaction steps (`isCompactionStep`) that lack an explicit model identifier.
 *
 * 4-pass forward/backward neighbor fallback rules (selecting only steps with genuine explicit model identity `isExplicitDonor` as donors):
 * - **Pass 1 (backward, same Provider preferred)**: scan backward (`idx - 1 -> 0`) for the first explicit-model step with a compatible `apiProvider`;
 * - **Pass 2 (forward, same Provider next)**: if not found backward, scan forward (`idx + 1 -> steps.length - 1`) for the first explicit-model step with a compatible `apiProvider`;
 * - **Pass 3 (backward, any explicit model fallback)**: if still not found, ignore Provider and scan backward for the nearest explicit-model step;
 * - **Pass 4 (forward, any explicit model last resort)**: finally scan forward for the nearest explicit-model step.
 *
 * On match, populate `modelKey`, mark `modelSource` as `'inferred_compaction'`, and fill in `responseModel` and `modelDisplayName` from the same model.
 *
 * @param {Array<object>} steps Extracted steps list
 * @returns {Array<object>} Steps list with compaction step models inferred
 */
export function inferCompactionStepModels(steps) {
  if (!Array.isArray(steps) || steps.length < 2) {
    return steps;
  }

  const isExplicitDonor = (step) =>
    Boolean(
      step &&
        !step.isImageGenStep &&
        step.modelKey &&
        step.modelKey !== 'unknown' &&
        step.modelSource !== 'inferred_compaction' &&
        step.modelSource !== 'legacy_unverified'
    );

  const isProviderCompatible = (target, donor) =>
    !target.apiProvider ||
    !donor.apiProvider ||
    target.apiProvider === donor.apiProvider;

  return steps.map((step, idx) => {
    if (!step?.isCompactionStep) {
      return step;
    }
    const needsModel = !step.modelKey || step.modelKey === 'unknown';
    const needsUpstream =
      step.modelSource === 'inferred_compaction' && !step.responseModel;
    if (!needsModel && !needsUpstream) {
      return step;
    }

    const canDonate = (cand) => {
      if (!isExplicitDonor(cand)) return false;
      if (!needsModel) {
        return cand.modelKey === step.modelKey && Boolean(cand.responseModel);
      }
      return true;
    };

    let donor = null;

    // Pass 1: scan backward for the nearest explicit-model step with the same API Provider
    for (let j = idx - 1; j >= 0; j--) {
      if (canDonate(steps[j]) && isProviderCompatible(step, steps[j])) {
        donor = steps[j];
        break;
      }
    }
    // Pass 2: scan forward for the nearest explicit-model step with the same API Provider
    if (!donor) {
      for (let j = idx + 1; j < steps.length; j++) {
        if (canDonate(steps[j]) && isProviderCompatible(step, steps[j])) {
          donor = steps[j];
          break;
        }
      }
    }
    // Pass 3: scan backward for any nearest explicit-model step
    if (!donor) {
      for (let j = idx - 1; j >= 0; j--) {
        if (canDonate(steps[j])) {
          donor = steps[j];
          break;
        }
      }
    }
    // Pass 4: scan forward for any nearest explicit-model step
    if (!donor) {
      for (let j = idx + 1; j < steps.length; j++) {
        if (canDonate(steps[j])) {
          donor = steps[j];
          break;
        }
      }
    }

    if (!donor) {
      return step;
    }

    const nextModelKey = needsModel ? donor.modelKey : step.modelKey;
    const nextModelSource = needsModel ? 'inferred_compaction' : step.modelSource;
    const donorSameModel = donor.modelKey === nextModelKey;
    const nextResponseModel =
      step.responseModel || (donorSameModel ? donor.responseModel || '' : '');
    const nextDisplayName =
      step.modelDisplayName || (donorSameModel ? donor.modelDisplayName || '' : '');
    const nextMaxBudget =
      !step.reportedContextLimitTokens && donor.maxContextBudgetTokens > 0
        ? donor.maxContextBudgetTokens
        : step.maxContextBudgetTokens;

    if (
      nextModelKey === step.modelKey &&
      nextModelSource === step.modelSource &&
      nextResponseModel === (step.responseModel || '') &&
      nextDisplayName === (step.modelDisplayName || '') &&
      nextMaxBudget === step.maxContextBudgetTokens
    ) {
      return step;
    }

    return {
      ...step,
      modelKey: nextModelKey,
      modelSource: nextModelSource,
      responseModel: nextResponseModel,
      modelDisplayName: nextDisplayName,
      maxContextBudgetTokens: nextMaxBudget,
    };
  });
}

/**
 * Normalize and migrate historical step objects loaded from disk cache.
 *
 * Migration and disambiguation rules:
 * 1. **Legacy `v9` cache `MODEL_PLACEHOLDER_M418` disambiguation**:
 *    Legacy `v9` cache recorded both genuine Argon model requests and hardcoded fallback defaults for missing model metadata as `MODEL_PLACEHOLDER_M418`.
 *    Without raw trajectory evidence, the two cannot be distinguished; therefore, on migration, preserve token usage and timing info, reset `MODEL_PLACEHOLDER_M418` (and empty model names)
 *    to `modelKey: 'unknown'` and `modelSource: 'legacy_unverified'`, and save the original value in `legacyModelKey` for subsequent full reload from the raw trajectory.
 * 2. **Cross-measurement-version speed field invalidation guard**:
 *    If a cached step's `measurementVersion` differs from the current `MEASUREMENT_VERSION`, retain billed token data so reload failures never lose billing records,
 *    but clear all derived speed and phase-duration fields and mark `speedReason: 'legacy_cache'` to prevent distorted legacy rates from mixing into current stats.
 *
 * @param {object} step Cached step object
 * @returns {object} Migrated and cleaned step object
 */
export function normalizeCachedStep(step) {
  if (!step || typeof step !== 'object' || Array.isArray(step)) {
    return null;
  }
  if (step.modelIdentityVersion !== MODEL_IDENTITY_VERSION) {
    const ambiguous =
      !step.modelKey || step.modelKey === 'MODEL_PLACEHOLDER_M418';
    step = {
      ...step,
      modelIdentityVersion: MODEL_IDENTITY_VERSION,
      ...(ambiguous
        ? {
            legacyModelKey: step.modelKey || null,
            modelKey: 'unknown',
            modelDisplayName: '',
            modelSource: 'legacy_unverified',
          }
        : { modelSource: 'legacy_explicit' }),
    };
  }

  const DEAD_V3_KEYS = [
    'phaseDurationSec',
    'phaseTokPerSec',
    'phaseReason',
    'answerStartDelaySec',
    'streamDurationSec',
    'streamTokens',
    'streamTokPerSec',
  ];
  const hasDeadV3Key = DEAD_V3_KEYS.some((k) => Object.prototype.hasOwnProperty.call(step, k));
  if (hasDeadV3Key) {
    step = { ...step };
    for (const k of DEAD_V3_KEYS) {
      delete step[k];
    }
  }

  const safeIn = safeTokenCount(step.inputTokens);
  const safeCache = safeTokenCount(step.cacheReadTokens);
  const safeOut = safeTokenCount(step.outputTokens);
  const safeThink = safeTokenCount(step.thinkingTokens);
  const safeResp =
    step.responseTokens !== undefined && step.responseTokens !== null
      ? safeTokenCount(step.responseTokens)
      : Math.max(0, safeOut - safeThink);

  if (
    step.inputTokens !== safeIn ||
    step.cacheReadTokens !== safeCache ||
    step.outputTokens !== safeOut ||
    step.thinkingTokens !== safeThink ||
    step.responseTokens !== safeResp
  ) {
    step = {
      ...step,
      inputTokens: safeIn,
      cacheReadTokens: safeCache,
      outputTokens: safeOut,
      thinkingTokens: safeThink,
      responseTokens: safeResp,
    };
  }

  if (step.measurementVersion === MEASUREMENT_VERSION) {
    return step;
  }

  return {
    ...step,
    measurementVersion: null,
    isComplete: false,
    nativeTtftSec: null,
    nativeStreamSec: null,
    viewableDelaySec: null,
    ttftSec: null,
    ttftSource: 'unavailable',
    thinkingDurationSec: null,
    totalDurationSec: null,
    totalTokPerSec: null,
    speedBasis: 'unavailable',
    speedSampleEligible: false,
    speedReason: 'legacy_cache',
  };
}

/**
 * Extract speed metric summary for a single step and whether it is eligible for mean speed statistics.
 *
 * @param {object} step Standardized step object
 * @returns {{ value: number | null, tokens: number, seconds: number, eligible: boolean, reason: string | null }}
 */
export function speedMetric(step) {
  const missing = (reason) => ({
    value: null,
    tokens: 0,
    seconds: 0,
    eligible: false,
    reason,
  });

  if (step.measurementVersion !== MEASUREMENT_VERSION) {
    return missing('legacy_cache');
  }
  if (
    !step.isComplete ||
    !Number.isFinite(step.totalTokPerSec) ||
    !(step.totalDurationSec >= MIN_SPEED_DURATION_SECONDS)
  ) {
    const reason = step.speedReason || 'incomplete_or_invalid_timing';
    return missing(step.isCompactionStep && reason === 'incomplete_or_invalid_timing'
      ? 'compaction_timing_unavailable'
      : reason);
  }

  return {
    value: step.totalTokPerSec,
    tokens: step.outputTokens,
    seconds: step.totalDurationSec,
    eligible:
      step.speedSampleEligible === true &&
      !step.isCompactionStep &&
      !step.isImageGenStep,
    reason: step.speedReason,
  };
}

/**
 * Create initial accumulator state for aggregating multi-step throughput.
 *
 * @returns {{ tokens: number, seconds: number, sampleCount: number, excludedCount: number, excludedReasons: Record<string, number> }}
 */
export function createSpeedAccumulator() {
  return {
    tokens: 0,
    seconds: 0,
    sampleCount: 0,
    excludedCount: 0,
    excludedReasons: {},
  };
}

/**
 * Accumulate speed metrics for a single step into the summary accumulator (automatically skipping context compaction steps).
 *
 * @param {ReturnType<typeof createSpeedAccumulator>} acc Speed accumulator
 * @param {object} step Standardized step object
 */
export function accumulateSpeed(acc, step) {
  if (step.isCompactionStep || step.isImageGenStep) {
    return;
  }
  const metric = speedMetric(step);
  if (metric.eligible) {
    acc.tokens += metric.tokens;
    acc.seconds += metric.seconds;
    acc.sampleCount++;
  } else {
    acc.excludedCount++;
    acc.excludedReasons[metric.reason] =
      (acc.excludedReasons[metric.reason] || 0) + 1;
  }
}

/**
 * Finalize speed accumulation and compute weighted average throughput (`total output tokens / total valid duration seconds`).
 *
 * @param {ReturnType<typeof createSpeedAccumulator>} acc Speed accumulator
 * @returns {ReturnType<typeof createSpeedAccumulator> & { avgTokPerSec: number | null }}
 */
export function finishSpeed(acc) {
  return {
    ...acc,
    avgTokPerSec: acc.seconds > 0 ? acc.tokens / acc.seconds : null,
  };
}

/**
 * Summarize overall throughput metrics across a list of steps in one pass.
 *
 * @param {Array<object>} steps Steps list
 * @returns {ReturnType<typeof finishSpeed>}
 */
export function summarizeSpeed(steps) {
  const acc = createSpeedAccumulator();
  for (const step of steps) {
    accumulateSpeed(acc, step);
  }
  return finishSpeed(acc);
}

/**
 * Summarize mean native time to first token (TTFT) across a list of steps.
 * Only includes valid samples that are non-compaction, current measurement version, complete, and satisfy `0 <= nativeTtftSec <= totalDurationSec + 0.01`.
 *
 * @param {Array<object>} steps Steps list
 * @returns {{ sampleCount: number, avgSec: number | null }}
 */
export function summarizeTtft(steps) {
  const values = steps
    .filter(
      (s) =>
        !s.isCompactionStep &&
        !s.isImageGenStep &&
        s.measurementVersion === MEASUREMENT_VERSION &&
        s.isComplete &&
        Number.isFinite(s.totalDurationSec) &&
        Number.isFinite(s.nativeTtftSec) &&
        s.nativeTtftSec >= 0 &&
        s.nativeTtftSec <= s.totalDurationSec + 0.01
    )
    .map((s) => s.nativeTtftSec);

  const avgSec = values.length
    ? values.reduce((a, b) => a + b, 0) / values.length
    : null;

  return {
    sampleCount: values.length,
    avgSec,
  };
}

/** Enum set of status values indicating a raw trajectory step has reached a terminal state (compatible with Connect RPC and transcript.jsonl) */
const LIVE_TERMINAL_STATUSES = new Set([
  'CORTEX_STEP_STATUS_DONE',
  'CORTEX_STEP_STATUS_CLEARED',
  'CORTEX_STEP_STATUS_ERROR',
  'CORTEX_STEP_STATUS_CANCELED',
  'CORTEX_STEP_STATUS_CANCELLED',
  'DONE',
  'CLEARED',
  'ERROR',
  'CANCELED',
  'CANCELLED',
]);

/**
 * Determine whether a raw step status represents waiting for human confirmation or approval.
 *
 * @param {unknown} status
 * @returns {boolean}
 */
function isWaitingStepStatus(status) {
  const s = String(status || '').toUpperCase();
  return (
    s.includes('WAIT') ||
    s.includes('CONFIRM') ||
    s.includes('APPROV') ||
    s.includes('BLOCKED')
  );
}

/**
 * Determine whether a single raw trajectory step has finished executing.
 *
 * @param {object} step
 * @returns {boolean}
 */
function isRawStepComplete(step) {
  if (!step || typeof step !== 'object') return true;
  if (typeof step.status === 'string' && step.status.trim()) {
    return LIVE_TERMINAL_STATUSES.has(step.status.trim().toUpperCase());
  }
  return Boolean(
    step.metadata?.completedAt ||
      step.metadata?.finishedGeneratingAt ||
      step.completed_at ||
      step.completedAt
  );
}

function getRawStepStartMs(step) {
  const m = step?.metadata || {};
  return Math.floor(
    parseIsoMs(m.createdAt || m.viewableAt || step?.created_at || step?.createdAt) || 0
  );
}

function getRawStepFinishMs(step) {
  const m = step?.metadata || {};
  const explicitEnd = parseIsoMs(
    m.completedAt || m.finishedGeneratingAt || step?.completed_at || step?.completedAt
  );
  if (explicitEnd > 0) return Math.floor(explicitEnd);
  if (typeof step?.content === 'string') {
    const mCompleted = step.content.match(/^Completed At:\s*(\S+)/m);
    if (mCompleted && mCompleted[1]) {
      const parsed = parseIsoMs(mCompleted[1]);
      if (parsed > 0) return Math.floor(parsed);
    }
  }
  return 0;
}

function getRawStepEndMs(step) {
  const finishMs = getRawStepFinishMs(step);
  if (finishMs > 0) return finishMs;
  const m = step?.metadata || {};
  return Math.floor(
    parseIsoMs(m.viewableAt || m.createdAt || step?.created_at || step?.createdAt) || 0
  );
}

function getStepStableId(step, fallbackIdx) {
  const idx =
    step?.step_index ??
    step?.stepIndex ??
    step?.metadata?.sourceTrajectoryStepInfo?.stepIndex;
  return idx !== undefined && idx !== null ? idx : fallbackIdx;
}

/**
 * Unescape field values from `transcript.jsonl` or tool arguments that may have been double-JSON-serialized.
 *
 * @param {unknown} val
 * @returns {unknown}
 */
function unwrapArgValue(val) {
  if (typeof val !== 'string') return val;
  const trimmed = val.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
    (trimmed.startsWith('{') && trimmed.endsWith('}'))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // Fall back to regex unescaping for partial-streaming or non-standard JSON
    }
  }
  return trimmed
    .replace(/^"+|"+$/g, '')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
    .replace(/\\n/g, ' ')
    .replace(/\\r/g, '');
}

function unwrapArgString(val) {
  const unwrapped = unwrapArgValue(val);
  if (typeof unwrapped === 'string') return unwrapped.trim();
  if (typeof unwrapped === 'number' && Number.isFinite(unwrapped)) return String(unwrapped);
  return '';
}

/**
 * Extract the trailing file or directory basename of a path (supports Windows backslashes, `file://` URIs, and double-escaped strings).
 *
 * @param {unknown} rawPath
 * @returns {string}
 */
function shortBasename(rawPath) {
  if (typeof rawPath !== 'string' || !rawPath.trim()) return '';
  let cleaned = unwrapArgString(rawPath).replace(/^file:\/\/\/?/i, '');
  try {
    if (cleaned.includes('%')) {
      cleaned = decodeURIComponent(cleaned);
    }
  } catch {
    // Ignore URI decode errors
  }
  cleaned = cleaned.replace(/[\\/]+$/, '');
  const parts = cleaned.split(/[\\/]/);
  return parts[parts.length - 1] || cleaned;
}

/**
 * Clean multi-line or Markdown-formatted text into a compact single-line preview snippet.
 *
 * @param {unknown} rawText
 * @param {number} [maxLen=52]
 * @param {boolean} [takeLastLine=false]
 * @returns {string}
 */
function cleanSingleLineSnippet(rawText, maxLen = 52, takeLastLine = false) {
  if (typeof rawText !== 'string' || !rawText.trim()) return '';
  const lines = rawText
    .split(/\r?\n/)
    .map((l) =>
      l
        .replace(/^[#>*\-\d.\s]+/, '')
        .replace(/[`*_~]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
    )
    .filter(Boolean);
  if (lines.length === 0) return '';
  const target = takeLastLine ? lines[lines.length - 1] : lines[0];
  return target.length > maxLen ? `${target.slice(0, maxLen - 1)}…` : target;
}

/**
 * Extract a string field value by key from a partially streamed, incomplete JSON string.
 *
 * @param {string} rawJson
 * @param {string[]} keys
 * @returns {string}
 */
function extractPartialJsonStringField(rawJson, keys) {
  if (typeof rawJson !== 'string' || !rawJson) return '';
  for (const key of keys) {
    const re = new RegExp(`"${key}"\\s*:\\s*"([^"\\\\]*(?:\\\\.[^"\\\\]*)*)`, 'i');
    const m = rawJson.match(re);
    if (m && m[1]) {
      return m[1]
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\')
        .replace(/\\n/g, ' ')
        .replace(/\\r/g, '')
        .trim();
    }
  }
  return '';
}

function getStepPlannerToolCalls(step) {
  if (Array.isArray(step?.plannerResponse?.toolCalls)) {
    return step.plannerResponse.toolCalls;
  }
  if (Array.isArray(step?.tool_calls)) {
    return step.tool_calls;
  }
  if (Array.isArray(step?.toolCalls)) {
    return step.toolCalls;
  }
  return [];
}

function getStepResponseText(step) {
  const p = step?.plannerResponse || {};
  return String(p.modifiedResponse || p.response || step?.content || '').trim();
}

function getStepThinkingText(step) {
  const p = step?.plannerResponse || {};
  return String(p.rawThinking || p.thinking || step?.thinking || '').trim();
}

function isPlannerStep(step) {
  const t = String(step?.type || '').toUpperCase();
  return (
    t === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE' ||
    t === 'PLANNER_RESPONSE' ||
    Boolean(step?.plannerResponse) ||
    Array.isArray(step?.tool_calls)
  );
}

function isCheckpointStep(step) {
  const t = String(step?.type || '').toUpperCase();
  if (
    t === 'CORTEX_STEP_TYPE_CHECKPOINT' ||
    t === 'CHECKPOINT' ||
    t.includes('CHECKPOINT') ||
    Boolean(step?.checkpoint && typeof step.checkpoint === 'object')
  ) {
    return true;
  }
  if (t.includes('SYSTEM') && typeof step?.content === 'string') {
    return /^\s*#\s*Resuming from a compaction\b/i.test(step.content);
  }
  return false;
}

function isAuxiliaryMetaStep(step) {
  const t = String(step?.type || '').toUpperCase();
  return t.includes('MEMENTO') || t.includes('EPHEMERAL');
}

/**
 * Parse a tool call object or partially streamed JSON arguments and return a UI-friendly single-line action label and detail description.
 *
 * @param {object|null|undefined} rawToolCall
 * @param {object|null|undefined} [fallbackStep=null]
 * @returns {{ toolName: string, isAskUser: boolean, label: string, detail: string }}
 */
export function summarizeToolCall(rawToolCall, fallbackStep = null) {
  const stepToolCall = fallbackStep?.metadata?.toolCall || {};
  const stepType = String(fallbackStep?.type || '').toUpperCase();
  let rawName = String(
    rawToolCall?.name ||
      rawToolCall?.toolName ||
      rawToolCall?.function?.name ||
      stepToolCall?.name ||
      ''
  ).trim();

  if (!rawName) {
    if (
      stepType.includes('RUN_COMMAND') ||
      stepType.includes('COMMAND_STATUS') ||
      fallbackStep?.runCommand
    ) {
      rawName = 'run_command';
    } else if (stepType.includes('INVOKE_SUBAGENT') || fallbackStep?.invokeSubagent) {
      rawName = 'invoke_subagent';
    } else if (
      stepType.includes('VIEW_FILE') ||
      stepType.includes('READ_FILE') ||
      fallbackStep?.viewFile ||
      fallbackStep?.readFile
    ) {
      rawName = 'read_file';
    } else if (
      stepType.includes('CODE_ACTION') ||
      stepType.includes('EDIT_FILE') ||
      fallbackStep?.codeAction ||
      fallbackStep?.editFile
    ) {
      rawName = 'edit_file';
    } else if (stepType.includes('GREP_SEARCH') || fallbackStep?.grepSearch) {
      rawName = 'grep_search';
    } else if (
      stepType.includes('FIND_BY_NAME') ||
      stepType === 'CORTEX_STEP_TYPE_FIND' ||
      fallbackStep?.findByName
    ) {
      rawName = 'find_by_name';
    } else if (stepType.includes('SEARCH_WEB') || fallbackStep?.searchWeb) {
      rawName = 'search_web';
    } else if (stepType.includes('GENERATE_IMAGE') || fallbackStep?.generateImage) {
      rawName = 'generate_image';
    }
  }

  const nameLower = rawName.toLowerCase().replace(/^default_api:/, '');
  let args = {};
  let rawArgsStr = '';

  const candidateArgs =
    rawToolCall?.args ??
    rawToolCall?.arguments ??
    rawToolCall?.argumentsJson ??
    rawToolCall?.function?.arguments ??
    stepToolCall?.argumentsJson;

  if (candidateArgs && typeof candidateArgs === 'object') {
    args = candidateArgs;
  } else if (typeof candidateArgs === 'string' && candidateArgs.trim()) {
    rawArgsStr = candidateArgs.trim();
    try {
      const parsed = JSON.parse(rawArgsStr);
      if (parsed && typeof parsed === 'object') args = parsed;
    } catch {
      // Partial-streaming JSON not yet closed; key fields will be extracted via regex below
    }
  }

  const stepPayload =
    fallbackStep?.runCommand ||
    fallbackStep?.commandStatus ||
    fallbackStep?.viewFile ||
    fallbackStep?.readFile ||
    fallbackStep?.viewFileOutline ||
    fallbackStep?.viewCodeItem ||
    fallbackStep?.codeAction ||
    fallbackStep?.editFile ||
    fallbackStep?.replaceFileContent ||
    fallbackStep?.writeToFile ||
    fallbackStep?.grepSearch ||
    fallbackStep?.findByName ||
    fallbackStep?.listDir ||
    fallbackStep?.searchWeb ||
    fallbackStep?.readUrlContent ||
    null;

  const pickField = (keys) => {
    for (const k of keys) {
      const fromArgs = unwrapArgString(args?.[k]);
      if (fromArgs) return fromArgs;
      const camelKey = k.charAt(0).toLowerCase() + k.slice(1);
      const fromArgsCamel = unwrapArgString(args?.[camelKey]);
      if (fromArgsCamel) return fromArgsCamel;
      if (stepPayload && typeof stepPayload === 'object') {
        const fromStep = unwrapArgString(stepPayload[k] ?? stepPayload[camelKey]);
        if (fromStep) return fromStep;
      }
    }
    return extractPartialJsonStringField(rawArgsStr, keys);
  };

  if (
    nameLower === 'run_command' ||
    nameLower === 'command_status' ||
    nameLower === 'send_command_input'
  ) {
    const summary = pickField(['toolSummary', 'Description', 'Summary']);
    const cmd = pickField(['CommandLine', 'Command', 'command']);
    const cmdSnippet = cleanSingleLineSnippet(cmd, 48);
    const detail =
      summary && cmdSnippet && summary !== cmdSnippet
        ? `${summary} (${cmdSnippet})`
        : summary || cmdSnippet || '';
    return {
      toolName: nameLower,
      actionKey: 'run_command',
      isAskUser: false,
      label: 'Running command',
      detail,
    };
  }

  if (
    nameLower === 'read_file' ||
    nameLower === 'view_file' ||
    nameLower === 'view_file_outline' ||
    nameLower === 'view_code_item' ||
    nameLower === 'read_notebook'
  ) {
    const file = shortBasename(
      pickField(['Path', 'AbsolutePath', 'AbsolutePathUri', 'FilePath', 'File', 'Uri'])
    );
    const startLine = pickField(['StartLine', 'startLine']);
    const endLine = pickField(['EndLine', 'endLine']);
    const rangeSuffix =
      startLine && endLine
        ? `:${startLine}-${endLine}`
        : startLine
          ? `:${startLine}+`
          : '';
    return {
      toolName: nameLower,
      actionKey: 'read_file',
      isAskUser: false,
      label: 'Reading file',
      detail: file ? `${file}${rangeSuffix}` : '',
    };
  }

  if (
    nameLower === 'edit_file' ||
    nameLower === 'replace_file_content' ||
    nameLower === 'multi_replace_file_content' ||
    nameLower === 'edit_notebook'
  ) {
    const file = shortBasename(
      pickField(['Path', 'TargetFile', 'AbsolutePath', 'AbsolutePathUri', 'FilePath', 'Uri'])
    );
    return {
      toolName: nameLower,
      actionKey: 'edit_file',
      isAskUser: false,
      label: 'Editing file',
      detail: file || '',
    };
  }

  if (nameLower === 'write_file' || nameLower === 'write_to_file') {
    const file = shortBasename(
      pickField(['Path', 'TargetFile', 'AbsolutePath', 'AbsolutePathUri', 'FilePath', 'Uri'])
    );
    return {
      toolName: nameLower,
      actionKey: 'write_file',
      isAskUser: false,
      label: 'Writing file',
      detail: file || '',
    };
  }

  if (nameLower === 'grep_search' || nameLower === 'ripgrep') {
    const query = pickField(['Query', 'Pattern', 'query']);
    const searchPath = shortBasename(pickField(['SearchPath', 'DirectoryPath', 'Path']));
    const detail =
      query && searchPath
        ? `${cleanSingleLineSnippet(query, 32)} (${searchPath})`
        : cleanSingleLineSnippet(query, 48) || searchPath || '';
    return {
      toolName: nameLower,
      actionKey: 'grep_search',
      isAskUser: false,
      label: 'Searching code',
      detail,
    };
  }

  if (nameLower === 'find_by_name' || nameLower === 'list_dir') {
    const pattern = pickField(['Pattern', 'Query']);
    const dir = shortBasename(pickField(['SearchDirectory', 'DirectoryPath', 'Path']));
    return {
      toolName: nameLower,
      actionKey: 'find_file',
      isAskUser: false,
      label: 'Finding files',
      detail: pattern && dir ? `${pattern} (${dir})` : pattern || dir || '',
    };
  }

  if (nameLower === 'search_web' || nameLower === 'read_url_content' || nameLower === 'fetch_url') {
    const isUrl = nameLower.includes('url');
    const target = pickField(['query', 'Query', 'Url', 'url']);
    return {
      toolName: nameLower,
      actionKey: isUrl ? 'read_url' : 'search_web',
      isAskUser: false,
      label: isUrl ? 'Reading web page' : 'Searching web',
      detail: cleanSingleLineSnippet(target, 52) || '',
    };
  }

  if (nameLower === 'generate_image') {
    const imgName =
      pickField(['ImageName', 'imageName']) ||
      String(fallbackStep?.generateImage?.imageName || '').trim();
    const ratio =
      pickField(['AspectRatio', 'aspectRatio']) ||
      String(fallbackStep?.generateImage?.aspectRatio || '').trim();
    const detail = imgName && ratio ? `${imgName} (${ratio})` : imgName || ratio || '';
    return {
      toolName: nameLower,
      actionKey: 'generate_image',
      isAskUser: false,
      label: 'Generating image',
      detail,
    };
  }

  if (nameLower === 'invoke_subagent') {
    const subSpec = fallbackStep?.invokeSubagent?.subagents?.[0] || {};
    const role =
      pickField(['Role', 'role']) ||
      String(subSpec.role || '').trim() ||
      pickField(['TypeName', 'typeName']) ||
      String(subSpec.typeName || '').trim();
    return {
      toolName: nameLower,
      actionKey: 'invoke_subagent',
      isAskUser: false,
      label: 'Invoking subagent',
      detail: role || '',
    };
  }

  if (nameLower === 'send_message') {
    const recipient = pickField(['Recipient', 'recipient']);
    return {
      toolName: nameLower,
      actionKey: 'send_message',
      isAskUser: false,
      label: 'Messaging subagent',
      detail: recipient ? recipient.slice(0, 8) : '',
    };
  }

  if (nameLower === 'manage_subagents' || nameLower === 'define_subagent') {
    const subName = pickField(['Name', 'Action', 'action']);
    return {
      toolName: nameLower,
      actionKey: 'manage_subagents',
      isAskUser: false,
      label: 'Managing subagents',
      detail: subName || '',
    };
  }

  if (nameLower === 'swarm') {
    const action = pickField(['action', 'Action']).toLowerCase();
    const memberName = pickField(['name', 'Name']).replace(/^@+/, '').trim();
    if (action === 'add') {
      const rawTasks = unwrapArgValue(args?.tasks);
      const rawCount = Number(unwrapArgValue(args?.n) || 0);
      const shardCount = Array.isArray(rawTasks) && rawTasks.length > 1
        ? rawTasks.length
        : rawCount > 1
          ? Math.floor(rawCount)
          : 0;
      const detail = memberName
        ? shardCount > 1
          ? `@${memberName}-1..${shardCount}`
          : `@${memberName}`
        : '';
      return {
        toolName: nameLower,
        actionKey: 'swarm_add',
        isAskUser: false,
        label: 'Spawning worker',
        detail,
      };
    }
    if (action === 'title') {
      return {
        toolName: nameLower,
        actionKey: 'swarm_title',
        isAskUser: false,
        label: 'Naming swarm',
        detail: cleanSingleLineSnippet(pickField(['title', 'Title']), 44) || '',
      };
    }
    if (action === 'kill') {
      return {
        toolName: nameLower,
        actionKey: 'swarm_kill',
        isAskUser: false,
        label: 'Terminating worker',
        detail: memberName ? `@${memberName}` : '',
      };
    }
    if (action === 'model') {
      const target = memberName ? `@${memberName}` : '@coordinator';
      const nextModel = pickField(['model', 'Model']);
      return {
        toolName: nameLower,
        actionKey: 'swarm_model',
        isAskUser: false,
        label: 'Switching worker model',
        detail: nextModel ? `${target} -> ${nextModel}` : target,
      };
    }
    if (action === 'channel') {
      const op = pickField(['op', 'Op']);
      const ch = pickField(['channel', 'Channel']).replace(/^#+/, '').trim();
      return {
        toolName: nameLower,
        actionKey: 'swarm_channel',
        isAskUser: false,
        label: 'Swarm channel',
        detail: ch ? `${op ? `${op} ` : ''}#${ch}` : op || '',
      };
    }
    return {
      toolName: nameLower,
      actionKey: 'swarm_status',
      isAskUser: false,
      label: 'Inspecting swarm',
      detail: action || 'status',
    };
  }

  if (nameLower === 'post_message') {
    const channel = pickField(['channel', 'Channel']).replace(/^#+/, '').trim();
    const textSnippet = cleanSingleLineSnippet(pickField(['text', 'Text']), 48);
    const detail =
      channel && channel !== 'main'
        ? `[#${channel}]${textSnippet ? ` ${textSnippet}` : ''}`
        : textSnippet || '';
    return {
      toolName: nameLower,
      actionKey: 'post_message',
      isAskUser: false,
      label: 'Posting to board',
      detail,
    };
  }

  if (nameLower === 'read_board') {
    const rawStatus = unwrapArgValue(args?.status) ?? pickField(['status']);
    const isStatus = String(rawStatus).trim().toLowerCase() === 'true';
    const rawSeqs = unwrapArgValue(args?.seqs);
    const seqsLabel =
      Array.isArray(rawSeqs) && rawSeqs.length > 0
        ? `${rawSeqs
            .slice(0, 4)
            .map((n) => `#${String(unwrapArgValue(n) ?? n).trim()}`)
            .join(', ')}${rawSeqs.length > 4 ? '…' : ''}`
        : '';
    const sinceVal = unwrapArgValue(args?.since) ?? pickField(['since']);
    const channel = pickField(['channel', 'Channel']).replace(/^#+/, '').trim();
    const detail = isStatus
      ? 'status'
      : [
          channel && channel !== 'main' ? `#${channel}` : '',
          seqsLabel ||
            (sinceVal !== undefined && sinceVal !== null && String(sinceVal).trim() !== ''
              ? `#${String(sinceVal).trim()}+`
              : ''),
        ]
          .filter(Boolean)
          .join(' ');
    return {
      toolName: nameLower,
      actionKey: 'read_board',
      isAskUser: false,
      label: 'Reading board',
      detail,
    };
  }

  if (nameLower === 'swarm_wait') {
    const sinceVal = unwrapArgValue(args?.since) ?? pickField(['since']);
    const detail =
      sinceVal !== undefined && sinceVal !== null && String(sinceVal).trim() !== ''
        ? `#${String(sinceVal).trim()}+`
        : '';
    return {
      toolName: nameLower,
      actionKey: 'swarm_wait',
      isAskUser: false,
      isSwarmWait: true,
      label: 'Waiting on board',
      detail,
    };
  }

  if (nameLower === 'manage_task') {
    const action = pickField(['Action', 'action']);
    const taskId = pickField(['TaskId', 'taskId']);
    return {
      toolName: nameLower,
      actionKey: 'manage_task',
      isAskUser: false,
      label: 'Background task',
      detail: taskId ? `${action || 'status'} (${taskId})` : action || '',
    };
  }

  if (nameLower === 'schedule') {
    const dur = pickField(['DurationSeconds']);
    const cron = pickField(['CronExpression']);
    return {
      toolName: nameLower,
      actionKey: 'schedule',
      isAskUser: false,
      label: 'Scheduled task',
      detail: dur ? `${dur}s` : cron || '',
    };
  }

  if (nameLower === 'ask_question') {
    const rawQuestions = unwrapArgValue(args?.questions);
    const qText =
      (Array.isArray(rawQuestions) ? rawQuestions[0]?.question : '') ||
      extractPartialJsonStringField(
        typeof args?.questions === 'string' ? args.questions : rawArgsStr,
        ['question']
      );
    return {
      toolName: nameLower,
      actionKey: 'ask_question',
      isAskUser: true,
      label: 'Waiting for user choice',
      detail: cleanSingleLineSnippet(qText, 50) || '',
    };
  }

  if (nameLower === 'search_marketplace' || nameLower === 'list_plugin_accounts') {
    const rawQueries = unwrapArgValue(args?.queries);
    const q = Array.isArray(rawQueries) ? rawQueries.join(', ') : '';
    return {
      toolName: nameLower,
      actionKey: 'search_marketplace',
      isAskUser: false,
      label: 'Searching plugins',
      detail: cleanSingleLineSnippet(q, 48) || '',
    };
  }

  if (isMcpToolItem(nameLower)) {
    const mcpClean = nameLower.replace(/^mcp[_-]/i, '').replace(/_/g, ' · ');
    return {
      toolName: nameLower,
      actionKey: 'mcp_tool',
      isAskUser: false,
      label: 'Calling MCP tool',
      detail: mcpClean || '',
    };
  }

  return {
    toolName: nameLower || 'tool',
    actionKey: 'tool_call',
    isAskUser: false,
    label: 'Calling tool',
    detail: nameLower || '',
  };
}

/**
 * Extract a live model activity summary from a running conversation's raw steps array (`rawSteps`, compatible with `GetCascadeTrajectory` and `transcript.jsonl`).
 *
 * State detection covers the full Agent loop:
 * 1. Trajectory is empty or newly created: show "Reasoning";
 * 2. Tail step is incomplete (`!isRawStepComplete(lastStep)`):
 *    - If `CHECKPOINT`: show "Context compaction";
 *    - If `PLANNER_RESPONSE`: extract current streaming activity in `toolCalls -> response -> thinking -> waiting for TTFT` priority order;
 *    - If tool execution step: combine with `status` to detect "Waiting for approval", and trace back to the latest `PLANNER_RESPONSE` to match tool name and `[m/n]` batch progress;
 * 3. Tail step is complete (`DONE`) while the conversation is still `RUNNING`:
 *    - If the latest `PLANNER_RESPONSE` declared `N` tool calls and only `M < N` completed steps follow, infer that the `(M + 1)`-th tool is running;
 *    - If `M >= N` (all tools have returned results) or the tail is `USER_INPUT`, infer that the model is summarizing tool results and preparing the next reasoning turn.
 *
 * @param {Array<object>} [rawSteps=[]]
 * @param {boolean} [isRunning=false]
 * @param {number} [fallbackStartMs=0]
 * @returns {{
 *   phase: 'thinking' | 'responding' | 'tool' | 'waiting' | 'compacting',
 *   label: string,
 *   detail: string,
 *   stepProgress: string,
 *   startedAtMs: number,
 *   signature: string
 * } | null}
 */
export function getMaxMeaningfulStepIndex(rawSteps = []) {
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) return -1;
  let idx = rawSteps.length - 1;
  while (idx > 0 && isAuxiliaryMetaStep(rawSteps[idx]) && isRawStepComplete(rawSteps[idx])) {
    idx--;
  }
  const numId = Number(getStepStableId(rawSteps[idx], idx));
  return Number.isFinite(numId) ? numId : idx;
}

export function extractLiveActivity(rawSteps = [], isRunning = false, fallbackStartMs = 0) {
  if (!isRunning) return null;
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    const startMs = Math.floor(fallbackStartMs || 0);
    return {
      phase: 'thinking',
      actionKey: 'thinking',
      waitingApproval: false,
      detailKey: '',
      label: 'Reasoning',
      detail: '',
      stepProgress: '',
      startedAtMs: startMs,
      signature: `init:0`,
    };
  }

  const hasBracketPrefix = (text) => /^\[\d+\s*\/\s*\d+\]/.test(String(text || '').trim());

  let lastPlannerIdx = -1;
  let lastUserIdx = -1;
  let lastCheckpointIdx = -1;
  for (let i = rawSteps.length - 1; i >= 0; i--) {
    const st = rawSteps[i];
    const t = String(st?.type || '').toUpperCase();
    if (lastCheckpointIdx === -1 && isCheckpointStep(st)) {
      lastCheckpointIdx = i;
    }
    if (lastPlannerIdx === -1 && isPlannerStep(st)) {
      lastPlannerIdx = i;
    }
    if (lastUserIdx === -1 && t.includes('USER_INPUT')) {
      lastUserIdx = i;
    }
    if (lastPlannerIdx !== -1 && lastUserIdx !== -1 && lastCheckpointIdx !== -1) break;
  }

  // Ignore trailing completed auxiliary metadata steps (e.g., MEMENTO / EPHEMERAL_MESSAGE) to avoid masking an active or just-finished compaction/tool step
  let lastIdx = rawSteps.length - 1;
  while (lastIdx > 0 && isAuxiliaryMetaStep(rawSteps[lastIdx]) && isRawStepComplete(rawSteps[lastIdx])) {
    lastIdx--;
  }
  const lastStep = rawSteps[lastIdx];
  const lastStepId = getStepStableId(lastStep, lastIdx);
  const lastComplete = isRawStepComplete(lastStep);

  // Case A: The last meaningful step itself is not yet complete (streaming output, compacting context, or running a tool)
  if (!lastComplete) {
    const prevStepEndMs =
      lastIdx > 0
        ? getRawStepFinishMs(rawSteps[lastIdx - 1]) || getRawStepEndMs(rawSteps[lastIdx - 1])
        : 0;
    const startMs =
      getRawStepStartMs(lastStep) || prevStepEndMs || Math.floor(fallbackStartMs || 0);

    if (isCheckpointStep(lastStep)) {
      return {
        phase: 'compacting',
        actionKey: 'compacting',
        waitingApproval: false,
        detailKey: '',
        label: 'Context compaction',
        detail: '',
        stepProgress: '',
        startedAtMs: startMs,
        signature: `compacting:${lastStepId}`,
      };
    }

    if (isPlannerStep(lastStep)) {
      const tools = getStepPlannerToolCalls(lastStep);
      const respText = getStepResponseText(lastStep);
      const thinkText = getStepThinkingText(lastStep);

      if (tools.length > 0) {
        const activeTool = tools[tools.length - 1];
        const info = summarizeToolCall(activeTool, lastStep);
        const stepProgress =
          tools.length > 1 && !hasBracketPrefix(info.detail) ? `${tools.length}/${tools.length}` : '';
        const phase = info.isAskUser || info.isSwarmWait ? 'waiting' : 'tool';
        return {
          phase,
          toolName: info.toolName,
          actionKey: info.actionKey,
          waitingApproval: false,
          detailKey: '',
          label: info.label,
          detail: info.detail,
          stepProgress,
          startedAtMs: startMs,
          signature: `planner-tool:${lastStepId}:${tools.length}:${info.actionKey}:${info.detail}`,
        };
      }

      if (respText.length > 0) {
        const snippet = cleanSingleLineSnippet(respText, 52, true);
        return {
          phase: 'responding',
          actionKey: 'responding',
          waitingApproval: false,
          detailKey: '',
          label: 'Writing response',
          detail: snippet,
          stepProgress: '',
          startedAtMs: startMs,
          signature: `responding:${lastStepId}:${snippet}`,
        };
      }

      if (thinkText.length > 0) {
        const snippet = cleanSingleLineSnippet(thinkText, 52, true);
        return {
          phase: 'thinking',
          actionKey: 'thinking',
          waitingApproval: false,
          detailKey: '',
          label: 'Reasoning',
          detail: snippet,
          stepProgress: '',
          startedAtMs: startMs,
          signature: `thinking:${lastStepId}:${snippet}`,
        };
      }

      return {
        phase: 'thinking',
        actionKey: 'thinking',
        waitingApproval: false,
        detailKey: '',
        label: 'Reasoning',
        detail: '',
        stepProgress: '',
        startedAtMs: startMs,
        signature: `waiting-ttft:${lastStepId}`,
      };
    }

    // Tail is an incomplete tool execution step (only associate with the latest PLANNER_RESPONSE after any compaction boundary)
    let matchedPlannerTool = null;
    let stepProgress = '';
    if (lastPlannerIdx >= 0 && lastPlannerIdx > lastUserIdx && lastPlannerIdx > lastCheckpointIdx) {
      const pTools = getStepPlannerToolCalls(rawSteps[lastPlannerIdx]);
      const toolStepsAfterPlanner = [];
      for (let k = lastPlannerIdx + 1; k <= lastIdx; k++) {
        const kt = String(rawSteps[k]?.type || '').toUpperCase();
        if (!kt.includes('CHECKPOINT') && !kt.includes('MEMENTO') && !kt.includes('EPHEMERAL')) {
          toolStepsAfterPlanner.push(rawSteps[k]);
        }
      }
      const toolIdx = toolStepsAfterPlanner.length - 1;
      if (toolIdx >= 0 && toolIdx < pTools.length) {
        matchedPlannerTool = pTools[toolIdx];
        if (pTools.length > 1) {
          stepProgress = `${toolIdx + 1}/${pTools.length}`;
        }
      }
    }

    const info = summarizeToolCall(matchedPlannerTool, lastStep);
    if (hasBracketPrefix(info.detail)) {
      stepProgress = '';
    }
    const waiting = isWaitingStepStatus(lastStep?.status) || info.isAskUser || Boolean(info.isSwarmWait);
    const waitingApproval = Boolean(waiting && !info.isAskUser && !info.isSwarmWait);
    const resolvedStartMs = startMs || prevStepEndMs || 0;
    const label = waitingApproval ? `Waiting for approval · ${info.label}` : info.label;

    return {
      phase: waiting ? 'waiting' : 'tool',
      toolName: info.toolName,
      actionKey: info.actionKey,
      waitingApproval,
      detailKey: '',
      label,
      detail: info.detail,
      stepProgress,
      startedAtMs: resolvedStartMs,
      signature: `step-run:${lastStepId}:${waiting}:${info.actionKey}:${stepProgress}:${info.detail}`,
    };
  }

  // Case A2: The latest key milestone is a completed (DONE) context compaction step (e.g., CHECKPOINT written to transcript.jsonl
  // or RPC compaction just finished and post-compaction context is being assembled for the next reasoning turn); never trace back into old pre-compaction tool actions
  if (lastCheckpointIdx >= 0 && lastCheckpointIdx > lastPlannerIdx && lastCheckpointIdx > lastUserIdx) {
    let hasPostCheckpointToolStep = false;
    for (let k = lastCheckpointIdx + 1; k <= lastIdx; k++) {
      const kt = String(rawSteps[k]?.type || '').toUpperCase();
      if (
        !isCheckpointStep(rawSteps[k]) &&
        !isAuxiliaryMetaStep(rawSteps[k]) &&
        !kt.includes('GENERIC') &&
        !kt.includes('SYSTEM')
      ) {
        hasPostCheckpointToolStep = true;
        break;
      }
    }
    if (!hasPostCheckpointToolStep) {
      const cpStep = rawSteps[lastCheckpointIdx];
      const cpStepId = getStepStableId(cpStep, lastCheckpointIdx);
      const prevBeforeCpMs =
        lastCheckpointIdx > 0
          ? getRawStepFinishMs(rawSteps[lastCheckpointIdx - 1]) ||
            getRawStepEndMs(rawSteps[lastCheckpointIdx - 1])
          : 0;
      const cpFinishMs = getRawStepFinishMs(cpStep);
      const cpStartMs =
        cpFinishMs ||
        getRawStepStartMs(cpStep) ||
        prevBeforeCpMs ||
        Math.floor(fallbackStartMs || 0);
      return {
        phase: 'compacting',
        actionKey: 'compacting',
        waitingApproval: false,
        detailKey: cpFinishMs > 0 ? 'compaction_resuming' : '',
        label: 'Context compaction',
        detail: cpFinishMs > 0 ? 'Compaction complete, resuming reasoning' : '',
        stepProgress: '',
        startedAtMs: cpStartMs,
        signature: cpFinishMs > 0 ? `compacting-done:${cpStepId}` : `compacting:${cpStepId}`,
      };
    }
  }

  // Case B: Tail step is already DONE, but the overall conversation is still RUNNING (match previous PLANNER_RESPONSE only after compaction boundary)
  if (lastPlannerIdx >= 0 && lastPlannerIdx > lastUserIdx && lastPlannerIdx > lastCheckpointIdx) {
    const plannerStep = rawSteps[lastPlannerIdx];
    const plannerStepId = getStepStableId(plannerStep, lastPlannerIdx);
    const pTools = getStepPlannerToolCalls(plannerStep);
    const toolStepsAfterPlanner = [];
    for (let k = lastPlannerIdx + 1; k <= lastIdx; k++) {
      const kt = String(rawSteps[k]?.type || '').toUpperCase();
      if (!kt.includes('CHECKPOINT') && !kt.includes('MEMENTO') && !kt.includes('EPHEMERAL')) {
        toolStepsAfterPlanner.push(rawSteps[k]);
      }
    }
    const completedAfterPlanner = toolStepsAfterPlanner.length;

    // B1: N tool calls from the previous PLANNER_RESPONSE still have unpersisted/unfinished items (completedAfterPlanner < N)
    if (pTools.length > 0 && completedAfterPlanner < pTools.length) {
      const currentTool = pTools[completedAfterPlanner];
      const info = summarizeToolCall(currentTool, null);
      const stepProgress =
        pTools.length > 1 && !hasBracketPrefix(info.detail)
          ? `${completedAfterPlanner + 1}/${pTools.length}`
          : '';
      // Prefer the actual completion time of the last completed step; fall back to step creation time if transcript.jsonl lacks completion timestamps
      const startMs =
        getRawStepFinishMs(lastStep) ||
        getRawStepFinishMs(plannerStep) ||
        getRawStepEndMs(lastStep) ||
        getRawStepEndMs(plannerStep) ||
        0;
      const phase = info.isAskUser || info.isSwarmWait ? 'waiting' : 'tool';

      return {
        phase,
        toolName: info.toolName,
        actionKey: info.actionKey,
        waitingApproval: false,
        detailKey: '',
        label: info.label,
        detail: info.detail,
        stepProgress,
        startedAtMs: startMs,
        signature: `pending-tool:${plannerStepId}:${completedAfterPlanner}:${info.actionKey}:${stepProgress}:${info.detail}`,
      };
    }

    // B2: All tools issued in the previous turn have completed; extract target file/command from each corresponding completed tool step
    if (pTools.length > 0 && completedAfterPlanner >= pTools.length) {
      const infos = pTools.map((t, idx) =>
        summarizeToolCall(t, toolStepsAfterPlanner[idx] || lastStep)
      );
      const swarmWaitInfo = infos.find((x) => x.isSwarmWait);
      if (swarmWaitInfo) {
        const startMs = getRawStepFinishMs(lastStep) || getRawStepEndMs(lastStep) || 0;
        return {
          phase: 'waiting',
          toolName: swarmWaitInfo.toolName,
          actionKey: swarmWaitInfo.actionKey,
          waitingApproval: false,
          detailKey: '',
          label: swarmWaitInfo.label,
          detail: swarmWaitInfo.detail,
          stepProgress: '',
          startedAtMs: startMs,
          signature: `swarm-wait:${lastStepId}:${swarmWaitInfo.detail}`,
        };
      }
      const lastToolInfo = infos[infos.length - 1];
      const allSameLabel = infos.every((x) => x.actionKey === lastToolInfo.actionKey);
      const detailsList = infos.map((x) => x.detail).filter(Boolean);
      const combinedDetail =
        infos.length > 1 && allSameLabel
          ? cleanSingleLineSnippet(detailsList.join(', '), 64)
          : lastToolInfo.detail || cleanSingleLineSnippet(detailsList.join(', '), 64);
      const stepProgress =
        pTools.length > 1 && !hasBracketPrefix(combinedDetail)
          ? `${pTools.length}/${pTools.length}`
          : '';
      const startMs = getRawStepFinishMs(lastStep) || getRawStepEndMs(lastStep) || 0;
      return {
        phase: 'thinking',
        toolName: lastToolInfo.toolName,
        actionKey: lastToolInfo.actionKey,
        waitingApproval: false,
        detailKey: '',
        label: lastToolInfo.label,
        detail: combinedDetail,
        stepProgress,
        startedAtMs: startMs,
        signature: `post-tool-think:${lastStepId}:${lastToolInfo.actionKey}:${combinedDetail}`,
      };
    }

    // B2.5: When tools exist as standalone steps in Connect RPC / SQLite trajectories (plannerResponse.toolCalls is empty), directly extract target file/command from the last tool step
    if (lastIdx > lastPlannerIdx) {
      const stepTypeUpper = String(lastStep?.type || '').toUpperCase();
      const hasStepToolMeta = Boolean(lastStep?.metadata?.toolCall?.name);
      if (!stepTypeUpper.includes('USER_INPUT') && (!stepTypeUpper.includes('GENERIC') || hasStepToolMeta)) {
        const lastInfo = summarizeToolCall(null, lastStep);
        if (lastInfo.toolName !== 'tool' || lastInfo.detail) {
          const startMs = getRawStepFinishMs(lastStep) || getRawStepEndMs(lastStep) || 0;
          if (lastInfo.isSwarmWait) {
            return {
              phase: 'waiting',
              toolName: lastInfo.toolName,
              actionKey: lastInfo.actionKey,
              waitingApproval: false,
              detailKey: '',
              label: lastInfo.label,
              detail: lastInfo.detail,
              stepProgress: '',
              startedAtMs: startMs,
              signature: `swarm-wait:${lastStepId}:${lastInfo.detail}`,
            };
          }
          return {
            phase: 'thinking',
            toolName: lastInfo.toolName,
            actionKey: lastInfo.actionKey,
            waitingApproval: false,
            detailKey: '',
            label: lastInfo.label,
            detail: lastInfo.detail,
            stepProgress: '',
            startedAtMs: startMs,
            signature: `post-step-tool:${lastStepId}:${lastInfo.actionKey}:${lastInfo.detail}`,
          };
        }
      }
    }

    // B3: Tail is a PLANNER_RESPONSE without tool calls (while conversation is still RUNNING); show latest response or thinking summary
    if (lastPlannerIdx === lastIdx) {
      const respText = getStepResponseText(plannerStep);
      const thinkText = getStepThinkingText(plannerStep);
      const startMs = getRawStepFinishMs(plannerStep) || getRawStepStartMs(plannerStep) || 0;
      if (respText.length > 0) {
        const snippet = cleanSingleLineSnippet(respText, 52, true);
        if (snippet) {
          return {
            phase: 'responding',
            actionKey: 'responding',
            waitingApproval: false,
            detailKey: '',
            label: 'Writing response',
            detail: snippet,
            stepProgress: '',
            startedAtMs: startMs,
            signature: `responding-done:${lastStepId}:${snippet}`,
          };
        }
      }
      if (thinkText.length > 0) {
        const snippet = cleanSingleLineSnippet(thinkText, 52, true);
        if (snippet) {
          return {
            phase: 'thinking',
            actionKey: 'thinking',
            waitingApproval: false,
            detailKey: '',
            label: 'Reasoning',
            detail: snippet,
            stepProgress: '',
            startedAtMs: startMs,
            signature: `thinking-done:${lastStepId}:${snippet}`,
          };
        }
      }
    }
  }

  // B4: Tail is USER_INPUT or a regular completed step
  const startMs = getRawStepFinishMs(lastStep) || getRawStepStartMs(lastStep) || 0;
  return {
    phase: 'thinking',
    actionKey: 'thinking',
    waitingApproval: false,
    detailKey: '',
    label: 'Reasoning',
    detail: '',
    stepProgress: '',
    startedAtMs: startMs,
    signature: `post-step-think:${lastStepId}`,
  };
}

/**
 * Identify and normalize Native Swarm worker node identity, stripping the redundant `Swarm Worker (<name>)` wrapper.
 *
 * @param {{ role?: string, typeName?: string, agentScriptName?: string, memberName?: string }} [input={}]
 * @returns {{ isSwarmWorker: boolean, memberName: string, isMonitor: boolean, isNarrator: boolean, isAuxiliary: boolean }}
 */
export function parseSwarmWorkerRole(input = {}) {
  const rawRole = String(input?.role || '').trim();
  const rawType = String(input?.typeName || '').trim().toLowerCase();
  const rawScript = String(input?.agentScriptName || '').trim();
  const explicitMember = String(input?.memberName || '').trim();

  const wrapperMatch = rawRole.match(/^Swarm\s+Worker\s*\(([^)]+)\)\s*$/i);
  const isSwarmWorker = Boolean(
    explicitMember || wrapperMatch || rawType === 'worker' || rawType === 'swarm_worker'
  );
  if (!isSwarmWorker) {
    return {
      isSwarmWorker: false,
      memberName: '',
      isMonitor: false,
      isNarrator: false,
      isAuxiliary: false,
    };
  }

  const candidate =
    explicitMember ||
    (wrapperMatch ? wrapperMatch[1] : '') ||
    rawScript ||
    (rawRole.toLowerCase() !== 'worker' && rawRole.toLowerCase() !== 'swarm worker' ? rawRole : '');
  const memberName = String(candidate || '').replace(/^@+/, '').trim();
  const isMonitor = /^monitor(?:-\d+)?$/i.test(memberName);
  const isNarrator = /^narrator(?:-\d+)?$/i.test(memberName);
  return {
    isSwarmWorker: true,
    memberName,
    isMonitor,
    isNarrator,
    isAuxiliary: isMonitor || isNarrator,
  };
}

/**
 * Determine whether raw trajectory steps have called `swarm_wait` to enter board standby state (with no subsequent user prompt or system wakeup message).
 *
 * @param {Array<object>} [rawSteps=[]]
 * @returns {boolean}
 */
export function isParkedOnSwarmWait(rawSteps = []) {
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) return false;
  let lastIdx = rawSteps.length - 1;
  while (lastIdx > 0 && isAuxiliaryMetaStep(rawSteps[lastIdx]) && isRawStepComplete(rawSteps[lastIdx])) {
    lastIdx--;
  }
  let lastPlannerIdx = -1;
  for (let i = lastIdx; i >= 0; i--) {
    const st = rawSteps[i];
    const t = String(st?.type || '').trim().toUpperCase();
    if (t.includes('USER_INPUT') || t.includes('SYSTEM_MESSAGE') || isCheckpointStep(st)) {
      return false;
    }
    if (isPlannerStep(st)) {
      lastPlannerIdx = i;
      break;
    }
  }
  if (lastPlannerIdx < 0) return false;

  const pTools = getStepPlannerToolCalls(rawSteps[lastPlannerIdx]);
  if (
    pTools.some((tc) => {
      const n = String(tc?.name || tc?.toolName || tc?.function?.name || '')
        .trim()
        .toLowerCase()
        .replace(/^default_api:/, '');
      return n === 'swarm_wait';
    })
  ) {
    return true;
  }

  for (let k = lastPlannerIdx + 1; k <= lastIdx; k++) {
    const st = rawSteps[k];
    const toolName = String(st?.metadata?.toolCall?.name || '')
      .trim()
      .toLowerCase()
      .replace(/^default_api:/, '');
    if (toolName === 'swarm_wait') return true;
    const rawContent = String(st?.content || '').trim();
    if (/Waiting for a message that calls on you|Waiting for any message posted after/i.test(rawContent)) {
      return true;
    }
  }
  return false;
}

function parseSwarmToolArgs(rawToolCall) {
  if (!rawToolCall || typeof rawToolCall !== 'object') return null;
  const direct = rawToolCall.args || rawToolCall.arguments;
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) {
    return direct;
  }
  const rawJson =
    typeof rawToolCall.argumentsJson === 'string'
      ? rawToolCall.argumentsJson
      : typeof direct === 'string'
        ? direct
        : typeof rawToolCall.function?.arguments === 'string'
          ? rawToolCall.function.arguments
          : '';
  if (!rawJson.trim()) return null;
  try {
    const parsed = JSON.parse(rawJson);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeSwarmToolName(rawToolCall) {
  return String(
    rawToolCall?.name || rawToolCall?.toolName || rawToolCall?.function?.name || ''
  )
    .trim()
    .toLowerCase()
    .replace(/^default_api:/, '');
}

function isSwarmStepCompletedSuccess(step) {
  const st = typeof step?.status === 'string' ? step.status.trim().toUpperCase() : '';
  if (st) {
    if (!LIVE_TERMINAL_STATUSES.has(st)) {
      return false;
    }
    if (st.includes('ERROR') || st.includes('CANCEL') || st.includes('FAIL')) {
      return false;
    }
  }
  const tcSt =
    typeof step?.metadata?.toolCall?.status === 'string'
      ? step.metadata.toolCall.status.trim().toUpperCase()
      : '';
  if (tcSt) {
    if (
      tcSt.includes('ERROR') ||
      tcSt.includes('CANCEL') ||
      tcSt.includes('FAIL') ||
      /(?:WAIT|PEND|RUN|GENERAT|IN_PROGRESS|STREAM)/i.test(tcSt)
    ) {
      return false;
    }
  }
  return true;
}

function extractSwarmCallIntent(rawToolCall) {
  const args = parseSwarmToolArgs(rawToolCall);
  if (!args || typeof args.action !== 'string') return null;
  const action = args.action.trim().toLowerCase();
  if (action === 'title') {
    if (typeof args.title !== 'string') return null;
    const nextTitle = args.title.trim();
    if (!nextTitle) return null;
    return { action: 'title', value: nextTitle, sig: `title:${nextTitle}` };
  }
  if (action === 'kill') {
    if (typeof args.name !== 'string') return null;
    const member = args.name.trim().replace(/^@+/, '').toLowerCase();
    if (!member) return null;
    return { action: 'kill', value: member, sig: `kill:${member}` };
  }
  return null;
}

/**
 * Extract Native Swarm metadata from raw trajectory RPC steps (pure RPC parsing, no need to read remote `members.json` on disk):
 * - `title`: swarm title set by the latest successful `swarm(action: "title")` call;
 * - `killedMembers`: map of worker member names (lowercase without `@`) terminated by `swarm(action: "kill")` to their termination timestamps.
 *
 * @param {Array<object>} [rawSteps=[]]
 * @returns {{ title?: string, killedMembers?: Record<string, number> } | null}
 */
export function extractSwarmMetaFromSteps(rawSteps = []) {
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) return null;

  const executedToolCallIds = new Set();
  for (const st of rawSteps) {
    const tc = st?.metadata?.toolCall;
    if (!tc || normalizeSwarmToolName(tc) !== 'swarm') continue;
    const tcId = String(tc.id || tc.toolCallId || '').trim();
    if (tcId) {
      executedToolCallIds.add(tcId);
    }
  }

  let title = '';
  const killedMap = new Map();

  const applyIntent = (intent, stepMs) => {
    if (!intent) return;
    if (intent.action === 'title') {
      title = intent.value;
    } else if (intent.action === 'kill') {
      const prevMs = killedMap.get(intent.value);
      killedMap.set(intent.value, prevMs === undefined ? stepMs : Math.max(prevMs, stepMs));
    }
  };

  for (let i = 0; i < rawSteps.length; i++) {
    const st = rawSteps[i];
    if (!st || typeof st !== 'object') continue;
    const stepMs =
      parseIsoMs(st?.metadata?.completedAt || st?.metadata?.createdAt || st?.created_at) || 0;

    const execTc = st?.metadata?.toolCall;
    if (execTc && normalizeSwarmToolName(execTc) === 'swarm') {
      if (isSwarmStepCompletedSuccess(st)) {
        applyIntent(extractSwarmCallIntent(execTc), stepMs);
      }
      continue;
    }

    if (!isSwarmStepCompletedSuccess(st)) continue;
    const plannerCalls = getStepPlannerToolCalls(st);
    if (plannerCalls.length === 0) continue;

    // Collect signatures of execution steps without toolCall.id in the same turn to prevent failed or in-progress ID-less execution steps from falsely triggering planner proposals
    let turnIdlessExecCounts = null;
    for (const tc of plannerCalls) {
      if (normalizeSwarmToolName(tc) !== 'swarm') continue;
      const tcId = String(tc?.id || tc?.toolCallId || '').trim();
      if (tcId && executedToolCallIds.has(tcId)) {
        continue;
      }
      const intent = extractSwarmCallIntent(tc);
      if (!intent) continue;
      if (!tcId) {
        if (!turnIdlessExecCounts) {
          turnIdlessExecCounts = new Map();
          for (let j = i + 1; j < rawSteps.length; j++) {
            const nextSt = rawSteps[j];
            if (!nextSt || typeof nextSt !== 'object') continue;
            const nt = String(nextSt.type || '').trim().toUpperCase();
            if (
              isPlannerStep(nextSt) ||
              nt.includes('USER_INPUT') ||
              nt.includes('SYSTEM_MESSAGE') ||
              isCheckpointStep(nextSt)
            ) {
              break;
            }
            const nextExecTc = nextSt?.metadata?.toolCall;
            if (!nextExecTc || normalizeSwarmToolName(nextExecTc) !== 'swarm') continue;
            const nextExecId = String(nextExecTc.id || nextExecTc.toolCallId || '').trim();
            if (nextExecId) continue;
            const nextIntent = extractSwarmCallIntent(nextExecTc);
            if (!nextIntent) continue;
            turnIdlessExecCounts.set(
              nextIntent.sig,
              (turnIdlessExecCounts.get(nextIntent.sig) || 0) + 1
            );
          }
        }
        const matchedCount = turnIdlessExecCounts.get(intent.sig) || 0;
        if (matchedCount > 0) {
          turnIdlessExecCounts.set(intent.sig, matchedCount - 1);
          continue;
        }
      }
      applyIntent(intent, stepMs);
    }
  }

  if (!title && killedMap.size === 0) return null;
  let killedMembers = null;
  if (killedMap.size > 0) {
    killedMembers = {};
    for (const [member, killMs] of killedMap.entries()) {
      Object.defineProperty(killedMembers, member, {
        value: killMs,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  return {
    ...(title ? { title } : {}),
    ...(killedMembers ? { killedMembers } : {}),
  };
}


