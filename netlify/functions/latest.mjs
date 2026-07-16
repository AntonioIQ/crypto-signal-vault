import { getStore } from "@netlify/blobs";

import {
  createSeedSnapshot,
  isValidSnapshot,
} from "../lib/market-contract.mjs";
import {
  LATEST_SNAPSHOT_KEY,
  MARKET_DATA_STORE,
} from "./predict.mjs";

const JSON_HEADERS = Object.freeze({
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
});

export async function readLatestSnapshot({
  getStoreFn = getStore,
  seedFactory = createSeedSnapshot,
} = {}) {
  try {
    const store = getStoreFn(MARKET_DATA_STORE);
    const snapshot = await store.get(LATEST_SNAPSHOT_KEY, {
      consistency: "strong",
      type: "json",
    });

    if (isValidSnapshot(snapshot)) {
      return snapshot;
    }
  } catch {
    // A versioned seed keeps the public endpoint available before Blob setup.
  }

  return seedFactory();
}

export function createLatestHandler(dependencies = {}) {
  return async function latestHandler(request) {
    if (request.method !== "GET") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: { ...JSON_HEADERS, allow: "GET" },
      });
    }

    const snapshot = await readLatestSnapshot(dependencies);
    return new Response(JSON.stringify(snapshot), {
      status: 200,
      headers: JSON_HEADERS,
    });
  };
}

export default createLatestHandler();
