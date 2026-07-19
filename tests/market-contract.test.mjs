import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  assertValidSnapshot,
  createFreshSnapshot,
  createSeedSnapshot,
  createStaleSnapshot,
  createHistoryDocument,
  isValidSnapshot,
} from '../netlify/lib/market-contract.mjs';

const SAMPLE_PRICES = {
  btc: { price: 65000.25, sourceUpdatedAt: '2026-07-15T17:59:31.000Z' },
  eth: { price: 1900.5, sourceUpdatedAt: '2026-07-15T17:59:31.000Z' },
};

test('seed snapshot is valid and stale with null prices', () => {
  const seed = createSeedSnapshot();
  assert.doesNotThrow(() => assertValidSnapshot(seed));
  assert.equal(seed.stale, true);
  assert.equal(seed.assets.btc.price, null);
  assert.equal(seed.assets.eth.price, null);
  assert.deepEqual(seed.forecast, { status: 'unavailable' });
});

test('fresh snapshot passes contract validation', () => {
  const snapshot = createFreshSnapshot(SAMPLE_PRICES);
  assert.equal(snapshot.stale, false);
  assert.equal(snapshot.assets.btc.price, SAMPLE_PRICES.btc.price);
  assert.ok(isValidSnapshot(snapshot));
});

test('stale snapshot keeps prices and generated_at of the previous one', () => {
  const fresh = createFreshSnapshot(SAMPLE_PRICES);
  const stale = createStaleSnapshot(fresh);
  assert.equal(stale.stale, true);
  assert.equal(stale.generated_at, fresh.generated_at);
  assert.equal(stale.assets.btc.price, fresh.assets.btc.price);
});

test('non-stale snapshot with null price is rejected', () => {
  const broken = createFreshSnapshot(SAMPLE_PRICES);
  broken.assets.btc.price = null;
  assert.equal(isValidSnapshot(broken), false);
});

test('versioned seed fixture data/latest.json honors the contract', async () => {
  const fixture = JSON.parse(await readFile('data/latest.json', 'utf8'));
  assert.doesNotThrow(() => assertValidSnapshot(fixture));
  assert.equal(fixture.stale, true);
});

test('history document sorts points and validates them', () => {
  const document = createHistoryDocument({
    asset: 'btc',
    points: [
      { timestamp: '2026-07-15T02:00:00.000Z', price: 65100 },
      { timestamp: '2026-07-15T01:00:00.000Z', price: 65000 },
    ],
  });
  assert.equal(document.points[0].price, 65000);
  assert.equal(document.points.length, 2);
  assert.throws(() =>
    createHistoryDocument({ asset: 'btc', points: [{ timestamp: 'nope', price: -1 }] }),
  );
});
