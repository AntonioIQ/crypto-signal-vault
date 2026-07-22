import { getStore } from "@netlify/blobs";

import { buildAnalystContext } from "../lib/analyst-context.mjs";
import {
  ANALYST_INTENTS,
  classifyAnalystQuestion,
  finalizeAnalystResponse,
  templateAnswer,
} from "../lib/analyst-fallback.mjs";
import {
  MAX_ANALYST_SYSTEM_PROMPT_BYTES,
  buildAnalystSystemPrompt,
} from "../lib/analyst-prompt.mjs";
import {
  CHAT_RATE_LIMIT_STORE,
  estimateChatTokenCost,
  reserveChatQuota,
} from "../lib/chat-rate-limit.mjs";
import {
  GROQ_MAX_OUTPUT_TOKENS,
  createGroqClient,
} from "../lib/groq-client.mjs";
import { createSeedSnapshot } from "../lib/market-contract.mjs";
import { readLatestSnapshot } from "./latest.mjs";

export const MAX_QUESTION_CHARACTERS = 400;
export const MAX_REQUEST_BYTES = 2_048;
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

export function validateChatPayload(payload) {
  if (!exactKeys(payload, ["question", "sessionId"])) {
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
  return { question, sessionId: payload.sessionId.toLowerCase() };
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

    let quota;
    try {
      const store = getStoreFn(CHAT_RATE_LIMIT_STORE);
      quota = await reserveQuotaFn({
        store,
        sessionId: input.sessionId,
        tokenCost: estimateChatTokenCost(input.question, {
          maxSystemPromptBytes: MAX_ANALYST_SYSTEM_PROMPT_BYTES,
          maxOutputTokens: GROQ_MAX_OUTPUT_TOKENS,
        }),
        now: nowFn(),
      });
    } catch {
      const context = await safeContext(readSnapshotFn);
      return jsonResponse(
        { answer: templateAnswer(input.question, context), degraded: true },
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
    const intent = classifyAnalystQuestion(input.question);
    if (intent !== ANALYST_INTENTS.EXPLANATION) {
      return jsonResponse(
        { answer: templateAnswer(input.question, context, intent), degraded: false },
        { origin },
      );
    }

    try {
      const systemPrompt = buildAnalystSystemPrompt(context);
      const rawAnswer = await completeFn({
        systemPrompt,
        question: input.question,
      });
      const result = finalizeAnalystResponse(rawAnswer, {
        question: input.question,
        context,
      });
      return jsonResponse(
        { answer: result.answer, degraded: result.replaced },
        { origin },
      );
    } catch {
      return jsonResponse(
        { answer: templateAnswer(input.question, context), degraded: true },
        { origin },
      );
    }
  };
}

export default createChatHandler();
