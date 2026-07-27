import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ASSETS,
  fetchCurrentPrices,
  fetchJsonWithRetry,
} from "../netlify/lib/coingecko.mjs";

// A CoinGecko /simple/price payload covering every configured asset, with btc
// and eth carrying the specific values the assertions below check.
function simplePricePayload() {
  const payload = {};
  for (const [asset, meta] of Object.entries(ASSETS)) {
    const usd = asset === "btc" ? 65_000.25 : asset === "eth" ? 3_500.75 : 10;
    const last = asset === "btc" ? 1_752_599_971 : asset === "eth" ? 1_752_599_969 : 1_752_599_900;
    payload[meta.id] = { usd, last_updated_at: last };
  }
  return payload;
}

test("fetchJsonWithRetry makes exactly three attempts with maxRetries set to two", async () => {
  let attempts = 0;
  const sleepCalls = [];

  await assert.rejects(
    fetchJsonWithRetry("https://example.test/prices", {
      apiKey: null,
      maxRetries: 2,
      fetchImpl: async () => {
        attempts += 1;
        return { ok: false, status: 503 };
      },
      sleep: async (milliseconds) => {
        sleepCalls.push(milliseconds);
      },
    }),
    /failed after 3 attempts/,
  );

  assert.equal(attempts, 3);
  assert.deepEqual(sleepCalls, [250, 500]);
});

test("fetchJsonWithRetry sends the demo API key header only when an API key exists", async () => {
  const observedHeaders = [];
  const fetchImpl = async (_url, { headers }) => {
    observedHeaders.push(headers);
    return {
      ok: true,
      async json() {
        return { success: true };
      },
    };
  };

  await fetchJsonWithRetry("https://example.test/keyless", {
    apiKey: null,
    fetchImpl,
  });
  await fetchJsonWithRetry("https://example.test/authenticated", {
    apiKey: "demo-secret",
    fetchImpl,
  });

  assert.equal("x-cg-demo-api-key" in observedHeaders[0], false);
  assert.equal(observedHeaders[1]["x-cg-demo-api-key"], "demo-secret");
});

test("fetchCurrentPrices maps valid Bitcoin and Ethereum data", async () => {
  let requestedUrl;
  const prices = await fetchCurrentPrices({
    apiKey: null,
    fetchImpl: async (url) => {
      requestedUrl = new URL(url);
      return {
        ok: true,
        async json() {
          return simplePricePayload();
        },
      };
    },
  });

  assert.equal(requestedUrl.pathname, "/api/v3/simple/price");
  assert.equal(
    requestedUrl.searchParams.get("ids"),
    Object.values(ASSETS).map((m) => m.id).join(","),
  );
  assert.equal(requestedUrl.searchParams.get("vs_currencies"), "usd");
  assert.equal(requestedUrl.searchParams.get("include_last_updated_at"), "true");
  assert.equal(Object.keys(prices).length, Object.keys(ASSETS).length);
  assert.deepEqual(prices.btc, {
    id: "bitcoin",
    symbol: "BTC",
    name: "Bitcoin",
    price: 65_000.25,
    sourceUpdatedAt: new Date(1_752_599_971_000).toISOString(),
  });
  assert.deepEqual(prices.eth, {
    id: "ethereum",
    symbol: "ETH",
    name: "Ethereum",
    price: 3_500.75,
    sourceUpdatedAt: new Date(1_752_599_969_000).toISOString(),
  });
});

test("fetchCurrentPrices rejects invalid data for either required asset", async () => {
  await assert.rejects(
    fetchCurrentPrices({
      apiKey: null,
      fetchImpl: async () => ({
        ok: true,
        async json() {
          return {
            bitcoin: { usd: 65_000.25, last_updated_at: 1_752_599_971 },
            ethereum: { usd: 0, last_updated_at: 1_752_599_969 },
          };
        },
      }),
    }),
    /invalid for ethereum/,
  );
});
