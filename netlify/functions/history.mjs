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

export function createHistoryHandler(dependencies = {}) {
  return async function historyHandler(request) {
    if (request.method !== "GET") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: { ...JSON_HEADERS, allow: "GET" },
      });
    }

    const asset = new URL(request.url).searchParams.get("asset");

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

    return new Response(JSON.stringify(document), {
      status: 200,
      headers: JSON_HEADERS,
    });
  };
}

export default createHistoryHandler();
