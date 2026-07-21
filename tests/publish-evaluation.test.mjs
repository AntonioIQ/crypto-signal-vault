import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EvaluationPublicationError,
  downloadLog,
  publishEvaluation,
} from '../scripts/publish-evaluation.mjs';
import {
  ACCURACY_KEY,
  HEALTH_KEY,
  LOG_CURRENT_KEY,
  buildPredictionRecords,
} from '../netlify/lib/prediction-contract.mjs';
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

function records(now = w(Date.now())) {
  const generated = w(now - HOUR);
  const runId = 'local' + 'c'.repeat(32);
  const rev = 'abc1234';
  const ver = `${new Date(generated).toISOString().replaceAll('-', '').replaceAll(':', '').replace('.000', '')}-${rev}-${runId}`;
  const asset = (id, symbol) => {
    const forecast = Array.from({ length: 48 }, (_, i) => ({ offset_hours: i + 1, return_factor: 1 + (0.02 * (i + 1)) / 48 }));
    const tr = forecast[47].return_factor - 1;
    return { id, symbol, reference: { price: 100, observed_at: formatMexicoCityTimestamp(new Date(generated - 1800000)) }, forecast, summary: { terminal_return: tr, direction: 'up', confidence: { value: 60, status: 'available', method: 'rolling_origin_48h_residuals', sample_size: 30 } } };
  };
  const artifact = {
    schema_version: 'forecast-artifact/1.0', artifact_version: ver, artifact_type: 'relative_hourly_forecast',
    generated_at: formatMexicoCityTimestamp(new Date(generated)), data_through: formatMexicoCityTimestamp(new Date(generated - 1800000)),
    valid_until: formatMexicoCityTimestamp(new Date(generated + 36 * HOUR)), expires_at: formatMexicoCityTimestamp(new Date(generated + 72 * HOUR)),
    timezone: 'America/Mexico_City', currency: 'usd', horizon_hours: 48, step_hours: 1,
    direction_policy: { horizon_hours: 48, flat_threshold_return: 0.005 }, producer: { model_id: 't', code_revision: rev, run_id: runId },
    assets: { btc: asset('bitcoin', 'BTC'), eth: asset('ethereum', 'ETH') },
  };
  const prices = { btc: { price: 64000, sourceUpdatedAt: new Date(now - 60000).toISOString() }, eth: { price: 1800, sourceUpdatedAt: new Date(now - 60000).toISOString() } };
  const base = createFreshSnapshot(prices, new Date(now));
  const fc = anchorForecast(artifact, forecastArtifactStatus(artifact, new Date(now)), base, formatMexicoCityTimestamp);
  return buildPredictionRecords(createFreshSnapshot(prices, new Date(now), fc));
}

const GOOD_ACCURACY = {
  status: 'available', window_days: 7, measured_through: formatMexicoCityTimestamp(new Date()),
  assets: { btc: { status: 'available', hit_rate: 55.0, sample_size: 40 }, eth: { status: 'insufficient_data', hit_rate: null, sample_size: 3 } },
};
const HEALTH = { measured_at: formatMexicoCityTimestamp(new Date()), assets: {} };

function fakeStore(seed = {}) {
  const blobs = new Map();
  let etag = 1;
  for (const [k, v] of Object.entries(seed)) blobs.set(k, { value: v, etag: String(etag++) });
  return {
    blobs, writes: [],
    async get(key) { return blobs.get(key)?.value ?? null; },
    async getWithMetadata(key) { const e = blobs.get(key); return e ? { data: e.value, etag: e.etag } : null; },
    async setJSON(key, value, opts = {}) {
      const e = blobs.get(key);
      if (opts.onlyIfNew && e) return { modified: false };
      if (opts.onlyIfMatch && (!e || e.etag !== opts.onlyIfMatch)) return { modified: false };
      this.writes.push(key); blobs.set(key, { value, etag: String(etag++) }); return { modified: true };
    },
  };
}

function reader(files) {
  return async (path) => {
    if (!(path in files)) throw new Error(`unexpected path ${path}`);
    return typeof files[path] === 'string' ? files[path] : JSON.stringify(files[path]);
  };
}

test('publishEvaluation writes log, accuracy and health', async () => {
  const store = fakeStore();
  const log = records();
  const result = await publishEvaluation({
    store, logPath: 'log', accuracyPath: 'acc', healthPath: 'hea', baselinePath: 'base',
    readFileFn: reader({ log, acc: GOOD_ACCURACY, hea: HEALTH, base: [] }),
  });
  assert.equal(result.accuracyStatus, 'available');
  assert.ok(store.writes.includes(LOG_CURRENT_KEY));
  assert.ok(store.writes.includes(ACCURACY_KEY));
  assert.ok(store.writes.includes(HEALTH_KEY));
  assert.equal(store.blobs.get(LOG_CURRENT_KEY).value.length, log.length);
});

test('a malformed accuracy block is rejected before any blob is written', async () => {
  const store = fakeStore();
  await assert.rejects(
    publishEvaluation({
      store, logPath: 'log', accuracyPath: 'acc', healthPath: 'hea',
      readFileFn: reader({ log: records(), acc: { status: 'available', window_days: 7, measured_through: formatMexicoCityTimestamp(new Date()), assets: { btc: { status: 'available', hit_rate: 77.7, sample_size: 1 }, eth: { status: 'insufficient_data', hit_rate: null, sample_size: 0 } } }, hea: HEALTH }),
    }),
  );
  assert.equal(store.writes.length, 0, 'no blob may be written when accuracy is invalid');
});

test('a semantically false resolved record is rejected', async () => {
  const store = fakeStore();
  const log = records();
  const bad = { ...log[0], actual: 1.0, resolved_at: formatMexicoCityTimestamp(new Date(Date.parse(log[0].target_at) + HOUR)), hit: true }; // up predicted, actual far below anchor, hit true is a lie
  await assert.rejects(
    publishEvaluation({ store, logPath: 'log', accuracyPath: 'acc', healthPath: 'hea', readFileFn: reader({ log: [bad], acc: GOOD_ACCURACY, hea: HEALTH }) }),
    EvaluationPublicationError,
  );
  assert.equal(store.writes.length, 0);
});

test('a concurrent append not in the baseline is preserved through publish', async () => {
  const log = records();
  const concurrent = { ...records(w(Date.now() + 3 * HOUR))[0] }; // a later-hour btc prediction predict.mjs added mid-job
  const store = fakeStore({ [LOG_CURRENT_KEY]: [...log, concurrent] });
  await publishEvaluation({
    store, logPath: 'log', accuracyPath: 'acc', healthPath: 'hea', baselinePath: 'base',
    readFileFn: reader({ log, acc: GOOD_ACCURACY, hea: HEALTH, base: log }), // baseline = what evaluate downloaded (without the concurrent one)
  });
  const finalIds = store.blobs.get(LOG_CURRENT_KEY).value.map((r) => r.id);
  assert.ok(finalIds.includes(concurrent.id), 'the mid-job append must survive the daily republish');
});

test('downloadLog returns an empty array when no blob exists yet', async () => {
  const store = fakeStore();
  let written = null;
  const count = await downloadLog({ store, outPath: 'out.json', writeFileFn: async (_p, data) => { written = data; } });
  assert.equal(count, 0);
  assert.equal(written, '[]');
});
