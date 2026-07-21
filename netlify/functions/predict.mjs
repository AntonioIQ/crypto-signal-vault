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
import {
  PREDICTIONS_STORE,
  unavailableAccuracy,
} from "../lib/prediction-contract.mjs";
import { readAccuracyBlock, recordPredictions } from "../lib/prediction-store.mjs";

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
  logger = console,
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

    // Last measured accuracy, isolated: building or reading the predictions
    // store must never affect the price, so the store factory itself is inside
    // the guard and accuracy defaults to `unavailable`.
    let predictionsStore = null;
    let accuracy = unavailableAccuracy();
    try {
      predictionsStore = getStoreFn(PREDICTIONS_STORE);
      accuracy = await readAccuracyBlock(predictionsStore);
    } catch {
      predictionsStore = null;
      logger.warn(
        "Accuracy read skipped; fresh market data remains available.",
      );
    }

    let forecast;
    try {
      const modelStore = getStoreFn(MODEL_ARTIFACTS_STORE);
      const baseSnapshot = createFreshSnapshot(prices, anchoredAt);
      const selected = await readUsableForecastArtifact(modelStore, anchoredAt);
      if (selected) {
        forecast = anchorForecast(
          selected.artifact,
          selected.status,
          baseSnapshot,
          formatMexicoCityTimestamp,
        );
      }
    } catch {
      logger.warn(
        "Forecast anchoring skipped; fresh market data remains available.",
      );
    }

    snapshot = createFreshSnapshot(prices, anchoredAt, forecast, accuracy);

    // Record this anchor's predictions for later evaluation, isolated so a
    // logging failure never blocks the price snapshot. Skipped entirely if the
    // predictions store could not be built above.
    if (predictionsStore) {
      try {
        await recordPredictions(predictionsStore, snapshot);
      } catch {
        logger.warn(
          "Prediction logging skipped; the price snapshot is unaffected.",
        );
      }
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
