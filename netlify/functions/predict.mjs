import { getStore } from "@netlify/blobs";

import { fetchCurrentPrices } from "../lib/coingecko.mjs";
import {
  createFreshSnapshot,
  createSeedSnapshot,
  createStaleSnapshot,
  isValidSnapshot,
} from "../lib/market-contract.mjs";

export const MARKET_DATA_STORE = "market-data";
export const LATEST_SNAPSHOT_KEY = "latest.json";

export async function readPreviousSnapshot(store) {
  const snapshot = await store.get(LATEST_SNAPSHOT_KEY, {
    consistency: "strong",
    type: "json",
  });

  return isValidSnapshot(snapshot) ? snapshot : null;
}

export async function runPrediction({
  getStoreFn = getStore,
  fetchPrices = fetchCurrentPrices,
  clock = () => new Date(),
  seedFactory = createSeedSnapshot,
} = {}) {
  const store = getStoreFn(MARKET_DATA_STORE);
  let previousSnapshot = null;

  try {
    previousSnapshot = await readPreviousSnapshot(store);
  } catch {
    previousSnapshot = null;
  }

  let snapshot;
  let status;

  try {
    const prices = await fetchPrices();
    snapshot = createFreshSnapshot(prices, clock());
    status = "fresh";
  } catch {
    snapshot = previousSnapshot
      ? createStaleSnapshot(previousSnapshot)
      : seedFactory();
    status = "stale";
  }

  await store.setJSON(LATEST_SNAPSHOT_KEY, snapshot);
  return { snapshot, status };
}

export function createPredictHandler(dependencies = {}) {
  return async function predictHandler() {
    try {
      const result = await runPrediction(dependencies);

      if (result.status === "stale") {
        console.warn("Market ingestion failed; the previous snapshot remains stale.");
      }

      return new Response(null, { status: 200 });
    } catch {
      console.error("Scheduled market refresh failed.");
      return new Response(null, { status: 500 });
    }
  };
}

export default createPredictHandler();
