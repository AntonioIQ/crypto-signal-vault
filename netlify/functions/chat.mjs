import { getStore } from "@netlify/blobs";

import { buildAnalystContext } from "../lib/analyst-context.mjs";
import {
  ANALYST_INTENTS,
  classifyAnalystQuestion,
  finalizeAnalystResponse,
  threadIsAboutAuthor,
  templateAnswer,
} from "../lib/analyst-fallback.mjs";
import {
  MAX_ANALYST_SYSTEM_PROMPT_BYTES,
  buildAnalystSystemPrompt,
} from "../lib/analyst-prompt.mjs";
import { glossaryMatches, serializeGlossary } from "../lib/analyst-glossary.mjs";
import { serializeAuthorProfile } from "../lib/analyst-author.mjs";
import {
  CHAT_RATE_LIMIT_STORE,
  estimateChatTokenCost,
  reserveChatQuota,
} from "../lib/chat-rate-limit.mjs";
import {
  GROQ_MAX_OUTPUT_TOKENS,
  createGroqClient,
} from "../lib/groq-client.mjs";
import { ASSETS } from "../lib/coingecko.mjs";
import { createSeedSnapshot } from "../lib/market-contract.mjs";
import { readLatestSnapshot } from "./latest.mjs";

export const MAX_QUESTION_CHARACTERS = 400;
// The body now carries the conversation, so it needs room for it: six turns of
// up to 600 characters plus the question. The history itself has its own,
// tighter envelope below.
export const MAX_REQUEST_BYTES = 6_144;
export const MAX_HISTORY_TURNS = 6;
export const MAX_HISTORY_TURN_CHARACTERS = 600;
export const MAX_HISTORY_BYTES = 3_072;
export const PRODUCTION_ORIGIN = "https://likelycoin.netlify.app";

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return isRecord(value) && Object.keys(value).sort().join("|") === [...keys].sort().join("|");
}

function normalizedOrigin(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function chatAllowedOrigins(env = {}) {
  return new Set(
    [PRODUCTION_ORIGIN, env.URL, env.DEPLOY_URL, env.DEPLOY_PRIME_URL]
      .map(normalizedOrigin)
      .filter(Boolean),
  );
}

export function isChatEnabled(env = {}) {
  return env.CHAT_ENABLED === "true";
}

function baseHeaders(origin = null) {
  const headers = {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    vary: "Origin",
  };
  if (origin) headers["access-control-allow-origin"] = origin;
  return headers;
}

function jsonResponse(payload, { status = 200, origin = null, headers = {} } = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...baseHeaders(origin), ...headers },
  });
}

function errorResponse(code, message, options = {}) {
  return jsonResponse({ error: { code, message } }, options);
}

function historyByteLength(history) {
  return new TextEncoder().encode(history.map((turn) => turn.text).join("\n")).byteLength;
}

// The conversation the reader's browser is holding. It is validated for shape
// and size only — its *content* cannot be validated, because a modified client
// can put anything here, including turns the analyst never said. That is the
// accepted cost of keeping the thread out of our storage (docs/08_CONVERSACION.md
// §2). What contains it is downstream: the thread is sent as messages with their
// own roles, never inside the system block, and every answer still goes through
// the output guards.
export function validateChatHistory(value) {
  if (!Array.isArray(value)) throw new TypeError("Invalid history.");
  const turns = value.map((turn) => {
    if (!exactKeys(turn, ["role", "text"])) throw new TypeError("Invalid history turn.");
    if (turn.role !== "user" && turn.role !== "analyst") {
      throw new TypeError("Invalid history role.");
    }
    if (typeof turn.text !== "string") throw new TypeError("Invalid history text.");
    const text = turn.text.trim();
    const characters = [...text].length;
    if (characters < 1 || characters > MAX_HISTORY_TURN_CHARACTERS) {
      throw new TypeError("Invalid history length.");
    }
    return { role: turn.role, text };
  });

  // A malformed thread is a bug in our client and fails loudly; a long one is
  // the product working as intended, so it is trimmed to the newest turns
  // instead of rejected.
  let kept = turns.slice(-MAX_HISTORY_TURNS);
  while (kept.length > 0 && historyByteLength(kept) > MAX_HISTORY_BYTES) {
    kept = kept.slice(1);
  }
  return kept;
}

export function validateChatPayload(payload) {
  // `asset` says which coin the page is showing; `history` carries the
  // conversation so far. Anything else is rejected.
  if (!isRecord(payload)) throw new TypeError("Invalid request shape.");
  const allowed = new Set(["question", "sessionId", "asset", "history"]);
  const keys = Object.keys(payload);
  if (!keys.includes("question") || !keys.includes("sessionId")) {
    throw new TypeError("Invalid request shape.");
  }
  if (keys.some((key) => !allowed.has(key))) {
    throw new TypeError("Invalid request shape.");
  }
  if (typeof payload.question !== "string" || typeof payload.sessionId !== "string") {
    throw new TypeError("Invalid request fields.");
  }
  const question = payload.question.trim();
  const characterCount = [...question].length;
  if (characterCount < 1 || characterCount > MAX_QUESTION_CHARACTERS) {
    throw new TypeError("Invalid question length.");
  }
  if (!UUID_V4_PATTERN.test(payload.sessionId)) {
    throw new TypeError("Invalid session identifier.");
  }
  const validated = { question, sessionId: payload.sessionId.toLowerCase() };
  if (Object.hasOwn(payload, "asset")) {
    if (typeof payload.asset !== "string" || !Object.hasOwn(ASSETS, payload.asset)) {
      throw new TypeError("Invalid asset.");
    }
    validated.asset = payload.asset;
  }
  validated.history = Object.hasOwn(payload, "history")
    ? validateChatHistory(payload.history)
    : [];
  return validated;
}

async function parseChatRequest(request) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    throw new TypeError("JSON is required.");
  }
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    throw new TypeError("Request body is too large.");
  }
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_REQUEST_BYTES) {
    throw new TypeError("Request body is too large.");
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new TypeError("Invalid JSON.");
  }
  return validateChatPayload(payload);
}

async function safeContext(readSnapshotFn) {
  let snapshot;
  try {
    snapshot = await readSnapshotFn();
    return buildAnalystContext(snapshot);
  } catch {
    return buildAnalystContext(createSeedSnapshot());
  }
}

export function createChatHandler(dependencies = {}) {
  const env = dependencies.env ?? process.env;
  const getStoreFn = dependencies.getStoreFn ?? getStore;
  const nowFn = dependencies.nowFn ?? (() => new Date());
  const reserveQuotaFn = dependencies.reserveQuotaFn ?? reserveChatQuota;
  const readSnapshotFn = dependencies.readSnapshotFn ?? (() =>
    readLatestSnapshot({ getStoreFn }));
  const completeFn = dependencies.completeFn ?? ((input) =>
    createGroqClient({ apiKey: env.GROQ_API_KEY }).complete(input));

  return async function chatHandler(request) {
    const requestOrigin = request.headers.get("origin");
    const allowedOrigins = chatAllowedOrigins(env);
    // The page that calls this function is served from the same host, so its
    // own origin is allowed whatever context it is deployed in. The env vars
    // this used to rely on (URL/DEPLOY_URL/DEPLOY_PRIME_URL) are build-time
    // values and are not in the function runtime, so on a deploy preview the
    // chat answered 403 to its own page and the section never appeared — the
    // feature could not be reviewed anywhere except production. Cross-origin
    // callers are still refused, which is the whole point of the check.
    const selfOrigin = normalizedOrigin(request.url);
    if (selfOrigin) allowedOrigins.add(selfOrigin);
    const origin = normalizedOrigin(requestOrigin);
    const originAllowed = origin !== null && allowedOrigins.has(origin);

    if (requestOrigin !== null && !originAllowed) {
      return errorResponse("origin_not_allowed", "Origen no permitido.", { status: 403 });
    }

    if (request.method === "OPTIONS") {
      if (!originAllowed) {
        return errorResponse("origin_not_allowed", "Origen no permitido.", { status: 403 });
      }
      return new Response(null, {
        status: 204,
        headers: {
          ...baseHeaders(origin),
          "access-control-allow-headers": "content-type",
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-max-age": "600",
        },
      });
    }

    if (request.method === "GET") {
      return jsonResponse({ enabled: isChatEnabled(env) }, { origin: originAllowed ? origin : null });
    }

    if (request.method !== "POST") {
      return errorResponse("method_not_allowed", "Método no permitido.", {
        status: 405,
        origin: originAllowed ? origin : null,
        headers: { allow: "GET, POST, OPTIONS" },
      });
    }

    if (!originAllowed) {
      return errorResponse("origin_required", "Origen no permitido.", { status: 403 });
    }

    if (!isChatEnabled(env)) {
      return errorResponse("chat_disabled", "El analista no está disponible.", {
        status: 404,
        origin,
      });
    }

    let input;
    try {
      input = await parseChatRequest(request);
    } catch {
      return errorResponse(
        "invalid_request",
        "Envía una sola pregunta de hasta 400 caracteres.",
        { status: 400, origin },
      );
    }

    // Quota is reserved before any other work, so a refused request costs
    // nothing beyond the reservation itself — no snapshot read, no provider
    // call. The price is the prompt envelope plus the conversation this request
    // actually carries; the envelope is charged rather than the built prompt
    // precisely so that nothing has to be built to know the price.
    let quota;
    try {
      const store = getStoreFn(CHAT_RATE_LIMIT_STORE);
      quota = await reserveQuotaFn({
        store,
        sessionId: input.sessionId,
        tokenCost: estimateChatTokenCost({
          promptBytes: MAX_ANALYST_SYSTEM_PROMPT_BYTES,
          historyBytes: historyByteLength(input.history),
          question: input.question,
          maxOutputTokens: GROQ_MAX_OUTPUT_TOKENS,
        }),
        now: nowFn(),
      });
    } catch {
      const context = await safeContext(readSnapshotFn);
      return jsonResponse(
        { answer: templateAnswer(input.question, context, undefined, input.asset), degraded: true },
        { origin },
      );
    }

    if (!quota.allowed) {
      return errorResponse(
        "rate_limited",
        "Alcanzamos el límite temporal. Intenta de nuevo más tarde.",
        {
          status: 429,
          origin,
          headers: { "retry-after": String(quota.retryAfterSeconds) },
        },
      );
    }

    const context = await safeContext(readSnapshotFn);
    const intent = classifyAnalystQuestion(input.question, input.asset, {
      authorThread: threadIsAboutAuthor(input.history),
    });

    // Investment advice and attempts to steer the analyst off its instructions
    // are answered by fixed templates and never reach the provider: neither may
    // depend on a model behaving itself. Everything else — our data, concepts,
    // and now any other subject — goes to the analyst, and comes back through
    // the guards in finalizeAnalystResponse.
    if (intent === ANALYST_INTENTS.ADVICE || intent === ANALYST_INTENTS.PROMPT_ATTACK) {
      return jsonResponse(
        {
          answer: templateAnswer(input.question, context, intent, input.asset),
          degraded: false,
        },
        { origin },
      );
    }

    let systemPrompt;
    try {
      systemPrompt = buildAnalystSystemPrompt(context, input.asset, {
        glossary: intent === ANALYST_INTENTS.CONCEPT
          ? serializeGlossary(glossaryMatches(input.question))
          : "",
        author: intent === ANALYST_INTENTS.AUTHOR ? serializeAuthorProfile() : "",
      });
    } catch {
      // Over its byte envelope: answer deterministically rather than send a
      // prompt nobody bounded.
      return jsonResponse(
        {
          answer: templateAnswer(input.question, context, intent, input.asset),
          degraded: true,
        },
        { origin },
      );
    }

    try {
      const rawAnswer = await completeFn({
        systemPrompt,
        question: input.question,
        history: input.history,
      });
      const result = finalizeAnalystResponse(rawAnswer, {
        question: input.question,
        context,
        asset: input.asset,
        intent,
      });
      return jsonResponse(
        { answer: result.answer, degraded: result.replaced },
        { origin },
      );
    } catch {
      return jsonResponse(
        {
          answer: templateAnswer(input.question, context, undefined, input.asset),
          degraded: true,
        },
        { origin },
      );
    }
  };
}

export default createChatHandler();
