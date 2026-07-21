import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readAccuracyBlock, recordPredictions } from '../netlify/lib/prediction-store.mjs';
import { LOG_CURRENT_KEY, ACCURACY_KEY } from '../netlify/lib/prediction-contract.mjs';
import {
  anchorForecast,
  forecastArtifactStatus,
} from '../netlify/lib/forecast-contract.mjs';
import {
  createFreshSnapshot,
  formatMexicoCityTimestamp,
} from '../netlify/lib/market-contract.mjs';

const HOUR = 60 * 60 * 1000;
const w = (ms) => Math.floor(ms / 1000) * 1000;

function anchoredSnapshot(now = w(Date.now())) {
  const generated = w(now - HOUR);
  const runId = 'local' + 'b'.repeat(32);
  const revision = 'abc1234';
  const version = `${new Date(generated).toISOString().replaceAll('-', '').replaceAll(':', '').replace('.000', '')}-${revision}-${runId}`;
  const asset = (id, symbol) => {
    const forecast = Array.from({ length: 48 }, (_, i) => ({ offset_hours: i + 1, return_factor: 1 + (0.02 * (i + 1)) / 48 }));
    const tr = forecast[47].return_factor - 1;
    return {
      id, symbol,
      reference: { price: 100, observed_at: formatMexicoCityTimestamp(new Date(generated - 30 * 60 * 1000)) },
      forecast,
      summary: { terminal_return: tr, direction: 'up', confidence: { value: 60, status: 'available', method: 'rolling_origin_48h_residuals', sample_size: 30 } },
    };
  };
  const artifact = {
    schema_version: 'forecast-artifact/1.0', artifact_version: version, artifact_type: 'relative_hourly_forecast',
    generated_at: formatMexicoCityTimestamp(new Date(generated)),
    data_through: formatMexicoCityTimestamp(new Date(generated - 30 * 60 * 1000)),
    valid_until: formatMexicoCityTimestamp(new Date(generated + 36 * HOUR)),
    expires_at: formatMexicoCityTimestamp(new Date(generated + 72 * HOUR)),
    timezone: 'America/Mexico_City', currency: 'usd', horizon_hours: 48, step_hours: 1,
    direction_policy: { horizon_hours: 48, flat_threshold_return: 0.005 },
    producer: { model_id: 'test', code_revision: revision, run_id: runId },
    assets: { btc: asset('bitcoin', 'BTC'), eth: asset('ethereum', 'ETH') },
  };
  const prices = { btc: { price: 64000, sourceUpdatedAt: new Date(now - 60000).toISOString() }, eth: { price: 1800, sourceUpdatedAt: new Date(now - 60000).toISOString() } };
  const base = createFreshSnapshot(prices, new Date(now));
  const forecast = anchorForecast(artifact, forecastArtifactStatus(artifact, new Date(now)), base, formatMexicoCityTimestamp);
  return createFreshSnapshot(prices, new Date(now), forecast);
}

function fakeStore(seed = {}, { failReads = false, failWrites = false } = {}) {
  const blobs = new Map(Object.entries(seed));
  return {
    blobs, writes: 0,
    async get(key) { if (failReads) throw new Error('down'); return blobs.get(key) ?? null; },
    async setJSON(key, value) { if (failWrites) throw new Error('down'); this.writes += 1; blobs.set(key, value); },
  };
}

test('recordPredictions appends two records on first run and writes once', async () => {
  const store = fakeStore();
  const added = await recordPredictions(store, anchoredSnapshot());
  assert.equal(added, 2);
  assert.equal(store.writes, 1);
  assert.equal(store.blobs.get(LOG_CURRENT_KEY).length, 2);
});

test('recordPredictions is idempotent within the same hour (no second write)', async () => {
  const snapshot = anchoredSnapshot();
  const store = fakeStore();
  await recordPredictions(store, snapshot);
  const writesAfterFirst = store.writes;
  const added = await recordPredictions(store, snapshot);
  assert.equal(added, 0);
  assert.equal(store.writes, writesAfterFirst, 'nothing new must not trigger a write');
});

test('recordPredictions does nothing without a fresh forecast', async () => {
  const store = fakeStore();
  const added = await recordPredictions(store, { forecast: { status: 'unavailable' } });
  assert.equal(added, 0);
  assert.equal(store.writes, 0);
});

test('a predictions-store read outage does not throw or write', async () => {
  const store = fakeStore({}, { failReads: true });
  const added = await recordPredictions(store, anchoredSnapshot());
  assert.equal(added, 0);
});

test('readAccuracyBlock returns the stored block or degrades to unavailable', async () => {
  const good = {
    status: 'available', window_days: 7, measured_through: formatMexicoCityTimestamp(new Date()),
    assets: { btc: { status: 'available', hit_rate: 55.0, sample_size: 40 }, eth: { status: 'insufficient_data', hit_rate: null, sample_size: 3 } },
  };
  assert.deepEqual(await readAccuracyBlock(fakeStore({ [ACCURACY_KEY]: good })), good);
  assert.deepEqual(await readAccuracyBlock(fakeStore()), { status: 'unavailable' });
  assert.deepEqual(await readAccuracyBlock(fakeStore({ [ACCURACY_KEY]: { status: 'available' } })), { status: 'unavailable' });
  assert.deepEqual(await readAccuracyBlock(fakeStore({}, { failReads: true })), { status: 'unavailable' });
});
