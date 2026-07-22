import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CHAT_RATE_LIMIT_KEY,
  CHAT_RATE_LIMIT_SCHEMA_VERSION,
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

test("session layer allows four questions and blocks the fifth without draining global quota", async () => {
  const store = makeCasStore();
  for (let index = 0; index < 4; index += 1) {
    const result = await reserveChatQuota({ store, sessionId: SESSION_A, tokenCost: 500, now: NOW });
    assert.equal(result.allowed, true);
  }
  const writesBefore = store.writes;
  const blocked = await reserveChatQuota({ store, sessionId: SESSION_A, tokenCost: 500, now: NOW });
  assert.deepEqual(blocked.layer, "session");
  assert.equal(blocked.allowed, false);
  assert.equal(storedState(store).global.day_tokens, 2_000);
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

test("five concurrent reservations keep the exact session and global limits", async () => {
  const store = makeCasStore();
  const decisions = await Promise.all(Array.from({ length: 5 }, () => reserveChatQuota({
    store,
    sessionId: SESSION_A,
    tokenCost: 500,
    now: NOW,
  })));
  assert.equal(decisions.filter((item) => item.allowed).length, 4);
  assert.equal(decisions.filter((item) => !item.allowed).length, 1);
  assert.equal(storedState(store).global.day_tokens, 2_000);
  assert.equal(storedState(store).sessions[sessionHash(SESSION_A)].requests, 4);
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
