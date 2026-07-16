import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createHistoryHandler, readHistory } from '../netlify/functions/history.mjs';
import {
  createRefreshHistoryHandler,
  runHistoryRefresh,
  historyKey,
  HISTORY_DAYS,
} from '../netlify/functions/refresh-history.mjs';
import {
  createHistoryDocument,
  isValidHistoryDocument,
} from '../netlify/lib/market-contract.mjs';

const POINTS = [
  { timestamp: '2026-07-15T01:00:00.000Z', price: 64000 },
  { timestamp: '2026-07-15T02:00:00.000Z', price: 64500 },
];

function makeStore(seed = {}, { failReads = false, failWrites = false } = {}) {
  const blobs = new Map(Object.entries(seed));
  return {
    blobs,
    async get(key) {
      if (failReads) throw new Error('blob storage down');
      return blobs.get(key) ?? null;
    },
    async setJSON(key, value) {
      if (failWrites) throw new Error('blob storage down');
      blobs.set(key, value);
    },
  };
}

test('refresh stores a 30-day window per asset', async () => {
  const store = makeStore();
  const calls = [];
  const results = await runHistoryRefresh({
    getStoreFn: () => store,
    fetchChart: async (coinId, { days }) => {
      calls.push([coinId, days]);
      return POINTS;
    },
  });

  assert.equal(results.btc.status, 'refreshed');
  assert.equal(results.eth.status, 'refreshed');
  assert.deepEqual(calls.sort(), [['bitcoin', HISTORY_DAYS], ['ethereum', HISTORY_DAYS]]);
  assert.ok(isValidHistoryDocument(store.blobs.get(historyKey('btc')), 'btc'));
  assert.ok(isValidHistoryDocument(store.blobs.get(historyKey('eth')), 'eth'));
});

test('one failing asset does not drop the other', async () => {
  const store = makeStore();
  const results = await runHistoryRefresh({
    getStoreFn: () => store,
    fetchChart: async (coinId) => {
      if (coinId === 'ethereum') throw new Error('provider down');
      return POINTS;
    },
  });

  assert.equal(results.btc.status, 'refreshed');
  assert.equal(results.eth.status, 'failed');
  assert.ok(store.blobs.has(historyKey('btc')));
  assert.equal(store.blobs.has(historyKey('eth')), false);
});

test('refresh keeps the previous window when the provider is down', async () => {
  const previous = createHistoryDocument({ asset: 'btc', points: POINTS });
  const store = makeStore({ [historyKey('btc')]: previous });
  await runHistoryRefresh({
    getStoreFn: () => store,
    fetchChart: async () => {
      throw new Error('provider down');
    },
  });

  assert.deepEqual(store.blobs.get(historyKey('btc')), previous);
});

test('handler reports 500 only when every asset fails', async () => {
  const allFailed = createRefreshHistoryHandler({
    getStoreFn: () => makeStore(),
    fetchChart: async () => {
      throw new Error('provider down');
    },
  });
  assert.equal((await allFailed()).status, 500);

  // A partial refresh still moved the window forward, so it is not an error.
  const partial = createRefreshHistoryHandler({
    getStoreFn: () => makeStore(),
    fetchChart: async (coinId) => {
      if (coinId === 'ethereum') throw new Error('provider down');
      return POINTS;
    },
  });
  assert.equal((await partial()).status, 200);
});

test('GET /api/history returns the stored window', async () => {
  const document = createHistoryDocument({ asset: 'btc', points: POINTS });
  const handler = createHistoryHandler({
    getStoreFn: () => makeStore({ [historyKey('btc')]: document }),
  });

  const response = await handler(new Request('http://localhost/api/history?asset=btc'));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), document);
});

test('GET /api/history 404s when there is no blob yet, so the client uses the seed', async () => {
  const handler = createHistoryHandler({ getStoreFn: () => makeStore() });
  const response = await handler(new Request('http://localhost/api/history?asset=btc'));
  assert.equal(response.status, 404);
});

test('GET /api/history 404s on a corrupt blob rather than serving it', async () => {
  const handler = createHistoryHandler({
    getStoreFn: () => makeStore({ [historyKey('btc')]: { asset: 'btc', points: 'nope' } }),
  });
  const response = await handler(new Request('http://localhost/api/history?asset=btc'));
  assert.equal(response.status, 404);
});

test('GET /api/history rejects an unknown or missing asset', async () => {
  const handler = createHistoryHandler({ getStoreFn: () => makeStore() });
  assert.equal(
    (await handler(new Request('http://localhost/api/history?asset=doge'))).status,
    400,
  );
  assert.equal((await handler(new Request('http://localhost/api/history'))).status, 400);
});

test('non-GET methods are rejected with 405', async () => {
  const handler = createHistoryHandler({ getStoreFn: () => makeStore() });
  const response = await handler(
    new Request('http://localhost/api/history?asset=btc', { method: 'POST' }),
  );
  assert.equal(response.status, 405);
});

test('readHistory survives a storage outage', async () => {
  const document = await readHistory('btc', {
    getStoreFn: () => makeStore({}, { failReads: true }),
  });
  assert.equal(document, null);
});

test('a foreign asset document is not served under the wrong key', () => {
  const ethDocument = createHistoryDocument({ asset: 'eth', points: POINTS });
  assert.equal(isValidHistoryDocument(ethDocument, 'btc'), false);
  assert.ok(isValidHistoryDocument(ethDocument, 'eth'));
});
