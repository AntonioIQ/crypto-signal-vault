import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createLatestHandler } from '../netlify/functions/latest.mjs';
import { runPrediction, LATEST_SNAPSHOT_KEY } from '../netlify/functions/predict.mjs';
import { createFreshSnapshot } from '../netlify/lib/market-contract.mjs';

const SAMPLE_PRICES = {
  btc: { price: 65000.25, sourceUpdatedAt: '2026-07-15T17:59:31.000Z' },
  eth: { price: 1900.5, sourceUpdatedAt: '2026-07-15T17:59:31.000Z' },
};

function makeStore(initialSnapshot = null, { failReads = false } = {}) {
  const writes = [];
  return {
    writes,
    async get() {
      if (failReads) throw new Error('blob storage down');
      return initialSnapshot;
    },
    async setJSON(key, value) {
      writes.push([key, value]);
    },
  };
}

test('GET /api/latest returns the stored snapshot', async () => {
  const snapshot = createFreshSnapshot(SAMPLE_PRICES);
  const handler = createLatestHandler({ getStoreFn: () => makeStore(snapshot) });
  const response = await handler(new Request('http://localhost/api/latest'));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.assets.btc.price, SAMPLE_PRICES.btc.price);
});

test('GET /api/latest falls back to the seed when storage fails', async () => {
  const handler = createLatestHandler({
    getStoreFn: () => makeStore(null, { failReads: true }),
  });
  const response = await handler(new Request('http://localhost/api/latest'));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.stale, true);
  assert.equal(body.assets.btc.price, null);
});

test('non-GET methods are rejected with 405', async () => {
  const handler = createLatestHandler({ getStoreFn: () => makeStore(null) });
  const response = await handler(
    new Request('http://localhost/api/latest', { method: 'POST' }),
  );
  assert.equal(response.status, 405);
});

test('runPrediction stores a fresh snapshot on success', async () => {
  const store = makeStore(null);
  const { status } = await runPrediction({
    getStoreFn: () => store,
    fetchPrices: async () => SAMPLE_PRICES,
  });
  assert.equal(status, 'fresh');
  const [key, value] = store.writes.at(-1);
  assert.equal(key, LATEST_SNAPSHOT_KEY);
  assert.equal(value.stale, false);
});

test('runPrediction keeps the previous snapshot marked stale on ingestion failure', async () => {
  const previous = createFreshSnapshot(SAMPLE_PRICES);
  const store = makeStore(previous);
  const { status, snapshot } = await runPrediction({
    getStoreFn: () => store,
    fetchPrices: async () => {
      throw new Error('provider down');
    },
  });
  assert.equal(status, 'stale');
  assert.equal(snapshot.stale, true);
  assert.equal(snapshot.assets.btc.price, previous.assets.btc.price);
  assert.equal(snapshot.generated_at, previous.generated_at);
});

test('runPrediction serves the seed when there is no previous snapshot', async () => {
  const store = makeStore(null);
  const { status, snapshot } = await runPrediction({
    getStoreFn: () => store,
    fetchPrices: async () => {
      throw new Error('provider down');
    },
  });
  assert.equal(status, 'stale');
  assert.equal(snapshot.assets.btc.price, null);
});
