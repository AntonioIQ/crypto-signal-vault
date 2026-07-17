import { getStore } from "@netlify/blobs";

import { fetchCurrentPrices } from "../lib/coingecko.mjs";
import {
  MODEL_ARTIFACTS_STORE,
  anchorForecast,
  readUsableForecastArtifact,
} from "../lib/forecast-contract.mjs";
import {
  createFreshSnapshot,
  createSeedSnapshot,
  createStaleSnapshot,
  formatMexicoCityTimestamp,
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
    const anchoredAt = clock();
    snapshot = createFreshSnapshot(prices, anchoredAt);

    try {
      const modelStore = getStoreFn(MODEL_ARTIFACTS_STORE);
      const selected = await readUsableForecastArtifact(modelStore, anchoredAt);
      if (selected) {
        const forecast = anchorForecast(
          selected.artifact,
          selected.status,
          snapshot,
          formatMexicoCityTimestamp,
        );
        snapshot = createFreshSnapshot(prices, anchoredAt, forecast);
      }
    } catch {
      // Forecast storage and validation are isolated from live market ingestion.
    }

    status = "fresh";
  } catch {
    snapshot = previousSnapshot
      ? createStaleSnapshot(previousSnapshot, clock())
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
