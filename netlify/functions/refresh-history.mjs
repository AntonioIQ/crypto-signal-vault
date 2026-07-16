import { getStore } from "@netlify/blobs";

import { ASSETS, fetchMarketChart } from "../lib/coingecko.mjs";
import { createHistoryDocument } from "../lib/market-contract.mjs";
import { MARKET_DATA_STORE } from "./predict.mjs";

export const HISTORY_DAYS = 30;

export function historyKey(asset) {
  return `history/${asset}.json`;
}

// Refetches the whole 30-day window instead of appending the newest point:
// overwriting is idempotent and self-healing, so a missed run leaves no gap to
// reconcile. Cost is ~240 CoinGecko calls/month against a 10k/month allowance.
export async function runHistoryRefresh({
  getStoreFn = getStore,
  fetchChart = fetchMarketChart,
  clock = () => new Date(),
} = {}) {
  const store = getStoreFn(MARKET_DATA_STORE);

  // Per-asset isolation: a failure on one asset must not drop the other.
  const entries = await Promise.all(
    Object.entries(ASSETS).map(async ([asset, metadata]) => {
      try {
        const points = await fetchChart(metadata.id, { days: HISTORY_DAYS });
        const document = createHistoryDocument({ asset, points, generatedAt: clock() });
        await store.setJSON(historyKey(asset), document);
        return [asset, { status: "refreshed", points: document.points.length }];
      } catch {
        return [asset, { status: "failed", points: 0 }];
      }
    }),
  );

  return Object.fromEntries(entries);
}

export function createRefreshHistoryHandler(dependencies = {}) {
  return async function refreshHistoryHandler() {
    try {
      const results = await runHistoryRefresh(dependencies);
      const failed = Object.entries(results)
        .filter(([, result]) => result.status === "failed")
        .map(([asset]) => asset);

      if (failed.length === Object.keys(results).length) {
        console.error("History refresh failed for every asset; the stored window is unchanged.");
        return new Response(null, { status: 500 });
      }

      if (failed.length > 0) {
        console.warn(`History refresh failed for: ${failed.join(", ")}.`);
      }

      return new Response(null, { status: 200 });
    } catch {
      console.error("Scheduled history refresh failed.");
      return new Response(null, { status: 500 });
    }
  };
}

export default createRefreshHistoryHandler();
