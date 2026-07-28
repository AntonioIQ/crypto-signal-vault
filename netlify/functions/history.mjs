import { getStore } from "@netlify/blobs";

import { ASSETS } from "../lib/coingecko.mjs";
import { isValidHistoryDocument } from "../lib/market-contract.mjs";
import { MARKET_DATA_STORE } from "./predict.mjs";
import { historyKey } from "./refresh-history.mjs";

const JSON_HEADERS = Object.freeze({
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
});

export async function readHistory(asset, { getStoreFn = getStore } = {}) {
  try {
    const store = getStoreFn(MARKET_DATA_STORE);
    const document = await store.get(historyKey(asset), {
      consistency: "strong",
      type: "json",
    });

    if (isValidHistoryDocument(document, asset)) {
      return document;
    }
  } catch {
    // Falling through to 404 lets the client serve the versioned build seed.
  }

  return null;
}

// The stored window is 90 days because the model needs it, but the dashboard
// only draws 30 and loads every asset at once — shipping the whole window to a
// browser would trade ~1.5 MB for pixels nobody sees. Callers that need all of
// it (the training workflow) ask for it explicitly with ?days=full.
export const DEFAULT_RESPONSE_DAYS = 30;

export function trimHistory(document, days) {
  const points = document?.points ?? [];
  if (days === "full" || !points.length) return document;

  const newest = Date.parse(points[points.length - 1].timestamp);
  if (!Number.isFinite(newest)) return document;

  const cutoff = newest - days * 24 * 60 * 60 * 1000;
  const trimmed = points.filter((point) => Date.parse(point.timestamp) >= cutoff);

  // Never answer with an empty series just because timestamps looked odd.
  return trimmed.length ? { ...document, points: trimmed } : document;
}

function requestedDays(url) {
  const raw = url.searchParams.get("days");
  if (raw === "full") return "full";
  const parsed = Number.parseInt(raw ?? "", 10);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  return DEFAULT_RESPONSE_DAYS;
}

export function createHistoryHandler(dependencies = {}) {
  return async function historyHandler(request) {
    if (request.method !== "GET") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: { ...JSON_HEADERS, allow: "GET" },
      });
    }

    const url = new URL(request.url);
    const asset = url.searchParams.get("asset");

    if (!asset || !Object.hasOwn(ASSETS, asset)) {
      return new Response(JSON.stringify({ error: "Unknown asset" }), {
        status: 400,
        headers: JSON_HEADERS,
      });
    }

    const document = await readHistory(asset, dependencies);

    // No blob yet (or a corrupt one): 404 tells the frontend to use the seed
    // shipped with the build rather than render an empty chart.
    if (!document) {
      return new Response(JSON.stringify({ error: "History unavailable" }), {
        status: 404,
        headers: JSON_HEADERS,
      });
    }

    return new Response(JSON.stringify(trimHistory(document, requestedDays(url))), {
      status: 200,
      headers: JSON_HEADERS,
    });
  };
}

export default createHistoryHandler();
