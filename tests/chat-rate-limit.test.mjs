import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CHAT_RATE_LIMIT_KEY,
  CHAT_RATE_LIMIT_SCHEMA_VERSION,
  SESSION_REQUEST_LIMIT,
  SESSION_WINDOW_MS,
  assertValidRateLimitState,
  estimateChatTokenCost,
  reserveChatQuota,
  sessionHash,
} from "../netlify/lib/chat-rate-limit.mjs";
import { makeCasStore } from "./chat-fixtures.mjs";

const SESSION_A = "123e4567-e89b-42d3-a456-426614174000";
const SESSION_B = "123e4567-e89b-42d3-b456-426614174001";
const NOW = new Date("2026-07-21T18:00:30.000Z");

function storedState(store) {
  return store.blobs.get(CHAT_RATE_LIMIT_KEY)?.value;
}

test("quota stores only a hash and reserves session plus global tokens atomically", async () => {
  const store = makeCasStore();
  const decision = await reserveChatQuota({
    store,
    sessionId: SESSION_A,
    tokenCost: 1_000,
    now: NOW,
  });
  assert.equal(decision.allowed, true);
  const state = assertValidRateLimitState(storedState(store));
  assert.equal(state.global.minute_tokens, 1_000);
  assert.equal(state.global.day_tokens, 1_000);
  assert.equal(state.sessions[sessionHash(SESSION_A)].requests, 1);
  assert.equal(JSON.stringify(state).includes(SESSION_A), false);
});

test("session layer allows its whole allowance and blocks the next without draining global quota", async () => {
  const store = makeCasStore();
  for (let index = 0; index < SESSION_REQUEST_LIMIT; index += 1) {
    const result = await reserveChatQuota({ store, sessionId: SESSION_A, tokenCost: 500, now: NOW });
    assert.equal(result.allowed, true);
  }
  const writesBefore = store.writes;
  const blocked = await reserveChatQuota({ store, sessionId: SESSION_A, tokenCost: 500, now: NOW });
  assert.deepEqual(blocked.layer, "session");
  assert.equal(blocked.allowed, false);
  assert.equal(storedState(store).global.day_tokens, 500 * SESSION_REQUEST_LIMIT);
  assert.equal(store.writes, writesBefore);
});

test("global minute layer blocks rotating sessions using token budget", async () => {
  const store = makeCasStore();
  const limits = { sessionRequests: 10, minuteTokens: 2_000, dayTokens: 10_000 };
  assert.equal((await reserveChatQuota({ store, sessionId: SESSION_A, tokenCost: 1_000, now: NOW, limits })).allowed, true);
  assert.equal((await reserveChatQuota({ store, sessionId: SESSION_B, tokenCost: 1_000, now: NOW, limits })).allowed, true);
  const blocked = await reserveChatQuota({
    store,
    sessionId: "123e4567-e89b-42d3-8456-426614174002",
    tokenCost: 1_000,
    now: NOW,
    limits,
  });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.layer, "global");
  assert.ok(blocked.retryAfterSeconds <= 60);
});

test("global day layer survives minute rollover", async () => {
  const store = makeCasStore();
  const limits = { sessionRequests: 10, minuteTokens: 5_000, dayTokens: 1_500 };
  assert.equal((await reserveChatQuota({ store, sessionId: SESSION_A, tokenCost: 1_000, now: NOW, limits })).allowed, true);
  const later = new Date(NOW.getTime() + 61_000);
  const blocked = await reserveChatQuota({ store, sessionId: SESSION_B, tokenCost: 1_000, now: later, limits });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.layer, "global");
  assert.equal(storedState(store).global.day_tokens, 1_000);
});

test("session and global minute windows reset while daily tokens remain", async () => {
  const store = makeCasStore();
  const limits = { sessionRequests: 1, minuteTokens: 2_000, dayTokens: 5_000 };
  await reserveChatQuota({ store, sessionId: SESSION_A, tokenCost: 1_000, now: NOW, limits });
  const later = new Date(NOW.getTime() + SESSION_WINDOW_MS + 1);
  const result = await reserveChatQuota({ store, sessionId: SESSION_A, tokenCost: 1_000, now: later, limits });
  assert.equal(result.allowed, true);
  assert.equal(storedState(store).global.minute_tokens, 1_000);
  assert.equal(storedState(store).global.day_tokens, 2_000);
  assert.equal(storedState(store).sessions[sessionHash(SESSION_A)].requests, 1);
});

test("CAS conflict re-reads and preserves a concurrent session reservation", async () => {
  const otherHash = sessionHash(SESSION_B);
  const concurrent = {
    schema_version: CHAT_RATE_LIMIT_SCHEMA_VERSION,
    global: {
      minute_bucket: Math.floor(NOW.getTime() / 60_000) * 60_000,
      minute_tokens: 500,
      day_bucket: "2026-07-21",
      day_tokens: 500,
    },
    sessions: {
      [otherHash]: { window_started_at: NOW.getTime(), requests: 1 },
    },
  };
  const store = makeCasStore(null, {
    onFirstRead: (blobs, nextEtag) => {
      blobs.set(CHAT_RATE_LIMIT_KEY, { value: concurrent, etag: nextEtag() });
    },
  });
  const result = await reserveChatQuota({ store, sessionId: SESSION_A, tokenCost: 1_000, now: NOW });
  assert.equal(result.allowed, true);
  const state = storedState(store);
  assert.equal(state.global.day_tokens, 1_500);
  assert.equal(state.sessions[otherHash].requests, 1);
  assert.equal(state.sessions[sessionHash(SESSION_A)].requests, 1);
});

test("corrupt state and storage outage fail closed", async () => {
  const corrupt = makeCasStore({ schema_version: CHAT_RATE_LIMIT_SCHEMA_VERSION });
  await assert.rejects(() => reserveChatQuota({
    store: corrupt,
    sessionId: SESSION_A,
    tokenCost: 1_000,
    now: NOW,
  }));
  assert.equal(corrupt.writes, 0);

  await assert.rejects(() => reserveChatQuota({
    store: makeCasStore(null, { fail: true }),
    sessionId: SESSION_A,
    tokenCost: 1_000,
    now: NOW,
  }));
});

test("token reservation is tied to the bounded system prompt, UTF-8 question, and output", () => {
  const ascii = estimateChatTokenCost("a".repeat(400), {
    maxSystemPromptBytes: 2_200,
    maxOutputTokens: 180,
  });
  const emoji = estimateChatTokenCost("🔒".repeat(400), {
    maxSystemPromptBytes: 2_200,
    maxOutputTokens: 180,
  });
  assert.equal(ascii, 2_844);
  assert.equal(emoji, 4_044);
  assert.ok(emoji > ascii);
});

// Concurrency here is about compare-and-swap losing no update, so it stays
// within the retry budget of updateJsonWithRetry; the session cap itself is
// covered by the sequential test above.
test("concurrent reservations lose no update", async () => {
  const store = makeCasStore();
  const attempts = 5;
  assert.ok(attempts <= SESSION_REQUEST_LIMIT, "keep every attempt inside the session cap");
  const decisions = await Promise.all(Array.from({ length: attempts }, () => reserveChatQuota({
    store,
    sessionId: SESSION_A,
    tokenCost: 500,
    now: NOW,
  })));
  assert.equal(decisions.filter((item) => item.allowed).length, attempts);
  assert.equal(storedState(store).global.day_tokens, 500 * attempts);
  assert.equal(storedState(store).sessions[sessionHash(SESSION_A)].requests, attempts);
});

test("UTC day rollover resets the daily budget", async () => {
  const store = makeCasStore();
  const limits = { sessionRequests: 10, minuteTokens: 5_000, dayTokens: 1_000 };
  await reserveChatQuota({ store, sessionId: SESSION_A, tokenCost: 1_000, now: NOW, limits });
  const tomorrow = new Date("2026-07-22T00:00:01.000Z");
  const result = await reserveChatQuota({ store, sessionId: SESSION_B, tokenCost: 1_000, now: tomorrow, limits });
  assert.equal(result.allowed, true);
  assert.equal(storedState(store).global.day_bucket, "2026-07-22");
  assert.equal(storedState(store).global.day_tokens, 1_000);
});

// Regression guard. The prompt budget grew from 2,200 to 7,000 bytes when the
// site went from 2 coins to 11, which pushed the estimated cost of a single
// question (7,294) past the 5,000 token-per-minute budget — so every caller,
// including the first one of any minute, was refused with 429 and the chat was
// dead in production while every unit test still passed. The budgets and the
// estimator must be checked against each other, not just in isolation.
test("a single worst-case question fits inside the global budgets", async () => {
  const { MAX_ANALYST_SYSTEM_PROMPT_BYTES } = await import(
    "../netlify/lib/analyst-prompt.mjs"
  );
  const { GROQ_MAX_OUTPUT_TOKENS } = await import("../netlify/lib/groq-client.mjs");
  const {
    GLOBAL_TOKENS_PER_MINUTE,
    GLOBAL_TOKENS_PER_DAY,
    SESSION_REQUEST_LIMIT,
  } = await import("../netlify/lib/chat-rate-limit.mjs");

  const worstCase = estimateChatTokenCost("x".repeat(400), {
    maxSystemPromptBytes: MAX_ANALYST_SYSTEM_PROMPT_BYTES,
    maxOutputTokens: GROQ_MAX_OUTPUT_TOKENS,
  });

  assert.ok(
    worstCase <= GLOBAL_TOKENS_PER_MINUTE,
    `one question costs ${worstCase} tokens but the minute budget is ${GLOBAL_TOKENS_PER_MINUTE}: every request would be refused`,
  );
  // One visitor exhausting their session must not exhaust the whole minute.
  assert.ok(
    worstCase * SESSION_REQUEST_LIMIT > GLOBAL_TOKENS_PER_MINUTE,
    "the session limit should be the first thing a single visitor meets",
  );
  assert.ok(
    GLOBAL_TOKENS_PER_DAY >= worstCase * 100,
    `the daily budget only allows ${Math.floor(GLOBAL_TOKENS_PER_DAY / worstCase)} questions for the whole site`,
  );
});

test("a fresh session is served rather than refused on its first question", async () => {
  const { MAX_ANALYST_SYSTEM_PROMPT_BYTES } = await import(
    "../netlify/lib/analyst-prompt.mjs"
  );
  const { GROQ_MAX_OUTPUT_TOKENS } = await import("../netlify/lib/groq-client.mjs");
  const store = makeCasStore();

  const decision = await reserveChatQuota({
    store,
    sessionId: SESSION_A,
    tokenCost: estimateChatTokenCost("¿Qué espera el modelo?", {
      maxSystemPromptBytes: MAX_ANALYST_SYSTEM_PROMPT_BYTES,
      maxOutputTokens: GROQ_MAX_OUTPUT_TOKENS,
    }),
    now: NOW,
  });

  assert.equal(decision.allowed, true, "the first question of a new session must go through");
});
