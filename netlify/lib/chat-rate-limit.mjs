import { createHash } from "node:crypto";

import { updateJsonWithRetry } from "./blob-log.mjs";

export const CHAT_RATE_LIMIT_STORE = "chat-rate-limit";
export const CHAT_RATE_LIMIT_KEY = "limits/current.json";
export const CHAT_RATE_LIMIT_SCHEMA_VERSION = "chat-rate-limit/1.0";
export const SESSION_WINDOW_MS = 10 * 60 * 1_000;
// A conversation is many short turns, not a handful of standalone questions.
// At 8 per window a real back-and-forth hit the wall around the third follow-up.
export const SESSION_REQUEST_LIMIT = 20;
// These budgets are spent in units of estimateChatTokenCost.
// Reference point: the Groq free tier allows 30k tokens/min and 14,400
// requests/day, so these stay well inside it. Re-check them in the Groq console
// before raising anything here — they are their numbers, not ours.
export const GLOBAL_TOKENS_PER_MINUTE = 30_000;
export const GLOBAL_TOKENS_PER_DAY = 1_000_000;
export const CHAT_MESSAGE_OVERHEAD_TOKENS = 64;
// UTF-8 bytes per token. Counting every byte as a token was a true upper bound
// but a ruinous one: with the 11-coin prompt it priced a single question at
// ~8.4k against a 30k minute, which is three questions per minute for the whole
// site — before any conversation history existed. Spanish prose and this JSON
// context both sit near 4 bytes per token, so 3 keeps a wide margin without
// charging for air. It is a calibrated estimate, not a hard ceiling; the daily
// budget is what backstops a bad estimate.
export const CHAT_BYTES_PER_TOKEN = 3;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return isRecord(value) && Object.keys(value).sort().join("|") === [...keys].sort().join("|");
}

function minuteBucket(nowMs) {
  return Math.floor(nowMs / 60_000) * 60_000;
}

function dayBucket(nowMs) {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function emptyState(nowMs) {
  return {
    schema_version: CHAT_RATE_LIMIT_SCHEMA_VERSION,
    global: {
      minute_bucket: minuteBucket(nowMs),
      minute_tokens: 0,
      day_bucket: dayBucket(nowMs),
      day_tokens: 0,
    },
    sessions: {},
  };
}

export function assertValidRateLimitState(state) {
  if (!exactKeys(state, ["schema_version", "global", "sessions"])) {
    throw new TypeError("Invalid chat rate-limit document.");
  }
  if (state.schema_version !== CHAT_RATE_LIMIT_SCHEMA_VERSION) {
    throw new TypeError("Unsupported chat rate-limit document.");
  }
  if (!exactKeys(state.global, ["minute_bucket", "minute_tokens", "day_bucket", "day_tokens"])) {
    throw new TypeError("Invalid global chat rate-limit state.");
  }
  if (
    !Number.isInteger(state.global.minute_bucket) ||
    !Number.isInteger(state.global.minute_tokens) || state.global.minute_tokens < 0 ||
    typeof state.global.day_bucket !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(state.global.day_bucket) ||
    !Number.isInteger(state.global.day_tokens) || state.global.day_tokens < 0 ||
    !isRecord(state.sessions)
  ) {
    throw new TypeError("Invalid global chat rate-limit counters.");
  }
  for (const [hash, session] of Object.entries(state.sessions)) {
    if (
      !/^[0-9a-f]{64}$/.test(hash) ||
      !exactKeys(session, ["window_started_at", "requests"]) ||
      !Number.isInteger(session.window_started_at) ||
      !Number.isInteger(session.requests) || session.requests < 0
    ) {
      throw new TypeError("Invalid session chat rate-limit state.");
    }
  }
  return state;
}

export function sessionHash(sessionId) {
  return createHash("sha256").update(sessionId).digest("hex");
}

// The cost is now measured against the prompt that was actually built — system
// block, conversation history and question — rather than against the cap the
// prompt was allowed to reach. Charging the cap meant that widening the envelope
// (for more coins, or for a glossary) silently raised the price of every single
// question until none of them fit in a minute.
export function estimateChatTokenCost({
  promptBytes,
  historyBytes = 0,
  question,
  maxOutputTokens,
}) {
  if (
    typeof question !== "string" ||
    !Number.isInteger(promptBytes) || promptBytes < 0 ||
    !Number.isInteger(historyBytes) || historyBytes < 0 ||
    !Number.isInteger(maxOutputTokens) || maxOutputTokens < 0
  ) {
    throw new TypeError("A measured prompt and output budget are required.");
  }
  const questionBytes = new TextEncoder().encode(question).byteLength;
  const inputBytes = promptBytes + historyBytes + questionBytes;
  const inputTokens = Math.ceil(inputBytes / CHAT_BYTES_PER_TOKEN);
  const total = inputTokens + maxOutputTokens + CHAT_MESSAGE_OVERHEAD_TOKENS;
  if (total <= 0) throw new TypeError("A chat request always costs something.");
  return total;
}

function normalizedState(current, nowMs) {
  const state = current === null ? emptyState(nowMs) : structuredClone(assertValidRateLimitState(current));
  const currentMinute = minuteBucket(nowMs);
  const currentDay = dayBucket(nowMs);
  if (state.global.minute_bucket !== currentMinute) {
    state.global.minute_bucket = currentMinute;
    state.global.minute_tokens = 0;
  }
  if (state.global.day_bucket !== currentDay) {
    state.global.day_bucket = currentDay;
    state.global.day_tokens = 0;
  }
  for (const [hash, session] of Object.entries(state.sessions)) {
    if (nowMs - session.window_started_at >= SESSION_WINDOW_MS) {
      delete state.sessions[hash];
    }
  }
  return state;
}

export async function reserveChatQuota({
  store,
  sessionId,
  tokenCost,
  now = new Date(),
  limits = {},
}) {
  const nowMs = new Date(now).getTime();
  if (!Number.isFinite(nowMs) || !Number.isInteger(tokenCost) || tokenCost <= 0) {
    throw new TypeError("A valid quota clock and token cost are required.");
  }
  const sessionLimit = limits.sessionRequests ?? SESSION_REQUEST_LIMIT;
  const minuteLimit = limits.minuteTokens ?? GLOBAL_TOKENS_PER_MINUTE;
  const dayLimit = limits.dayTokens ?? GLOBAL_TOKENS_PER_DAY;
  const hash = sessionHash(sessionId);
  let decision;

  await updateJsonWithRetry(store, CHAT_RATE_LIMIT_KEY, (current) => {
    const state = normalizedState(current, nowMs);
    const session = state.sessions[hash] ?? { window_started_at: nowMs, requests: 0 };

    if (session.requests >= sessionLimit) {
      decision = {
        allowed: false,
        layer: "session",
        retryAfterSeconds: Math.max(1, Math.ceil(
          (session.window_started_at + SESSION_WINDOW_MS - nowMs) / 1_000,
        )),
      };
      return undefined;
    }
    if (state.global.minute_tokens + tokenCost > minuteLimit) {
      decision = {
        allowed: false,
        layer: "global",
        retryAfterSeconds: Math.max(1, Math.ceil(
          (state.global.minute_bucket + 60_000 - nowMs) / 1_000,
        )),
      };
      return undefined;
    }
    if (state.global.day_tokens + tokenCost > dayLimit) {
      const nextDay = Date.parse(`${state.global.day_bucket}T00:00:00.000Z`) + 86_400_000;
      decision = {
        allowed: false,
        layer: "global",
        retryAfterSeconds: Math.max(1, Math.ceil((nextDay - nowMs) / 1_000)),
      };
      return undefined;
    }

    state.sessions[hash] = {
      window_started_at: session.window_started_at,
      requests: session.requests + 1,
    };
    state.global.minute_tokens += tokenCost;
    state.global.day_tokens += tokenCost;
    decision = { allowed: true, layer: null, retryAfterSeconds: 0 };
    return state;
  });

  if (!decision) throw new Error("Chat quota could not be evaluated.");
  return decision;
}
