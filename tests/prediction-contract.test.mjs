import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  appendPredictions,
  assertValidAccuracy,
  assertValidPredictionRecord,
  buildPredictionRecords,
  isValidAccuracy,
  predictionId,
  unavailableAccuracy,
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

function wholeSecond(ms) {
  return Math.floor(ms / 1000) * 1000;
}

// Builds a contract-valid anchored snapshot using the repo's own Phase 2 code.
function anchoredSnapshot({ now = wholeSecond(Date.now()) } = {}) {
  const generated = wholeSecond(now - HOUR);
  const runId = 'local' + 'a'.repeat(32);
  const revision = 'a1b2c3d';
  const version = `${new Date(generated).toISOString().replaceAll('-', '').replaceAll(':', '').replace('.000', '')}-${revision}-${runId}`;
  const makeAsset = (id, symbol, terminal) => {
    const forecast = Array.from({ length: 48 }, (_, i) => ({
      offset_hours: i + 1,
      return_factor: 1 + (terminal * (i + 1)) / 48,
    }));
    const terminalReturn = forecast[47].return_factor - 1;
    return {
      id, symbol,
      reference: { price: 100, observed_at: formatMexicoCityTimestamp(new Date(generated - 30 * 60 * 1000)) },
      forecast,
      summary: {
        terminal_return: terminalReturn,
        direction: terminalReturn >= 0.005 ? 'up' : terminalReturn <= -0.005 ? 'down' : 'flat',
        confidence: { value: 60, status: 'available', method: 'rolling_origin_48h_residuals', sample_size: 30 },
      },
    };
  };
  const artifact = {
    schema_version: 'forecast-artifact/1.0',
    artifact_version: version,
    artifact_type: 'relative_hourly_forecast',
    generated_at: formatMexicoCityTimestamp(new Date(generated)),
    data_through: formatMexicoCityTimestamp(new Date(generated - 30 * 60 * 1000)),
    valid_until: formatMexicoCityTimestamp(new Date(generated + 36 * HOUR)),
    expires_at: formatMexicoCityTimestamp(new Date(generated + 72 * HOUR)),
    timezone: 'America/Mexico_City',
    currency: 'usd',
    horizon_hours: 48,
    step_hours: 1,
    direction_policy: { horizon_hours: 48, flat_threshold_return: 0.005 },
    producer: { model_id: 'test', code_revision: revision, run_id: runId },
    assets: { btc: makeAsset('bitcoin', 'BTC', 0.02), eth: makeAsset('ethereum', 'ETH', -0.02) },
  };
  const prices = {
    btc: { price: 64000, sourceUpdatedAt: new Date(now - 60000).toISOString() },
    eth: { price: 1800, sourceUpdatedAt: new Date(now - 60000).toISOString() },
  };
  const base = createFreshSnapshot(prices, new Date(now));
  const status = forecastArtifactStatus(artifact, new Date(now));
  const forecast = anchorForecast(artifact, status, base, formatMexicoCityTimestamp);
  return createFreshSnapshot(prices, new Date(now), forecast);
}

test('buildPredictionRecords emits one record per asset from a fresh forecast', () => {
  const snapshot = anchoredSnapshot();
  const records = buildPredictionRecords(snapshot);
  assert.equal(records.length, 2);
  const btc = records.find((r) => r.asset === 'btc');
  assert.equal(btc.horizon_h, 48);
  assert.equal(btc.direction, 'up');
  assert.equal(btc.anchor_price, 64000);
  assert.equal(btc.predicted, snapshot.forecast.assets.btc.points[47].price);
  assert.equal(btc.target_at, snapshot.forecast.assets.btc.points[47].target_at);
  assert.equal(btc.actual, null);
  assert.equal(btc.hit, null);
  assert.doesNotThrow(() => assertValidPredictionRecord(btc));
});

test('buildPredictionRecords returns nothing without a fresh forecast', () => {
  assert.deepEqual(buildPredictionRecords({ forecast: { status: 'unavailable' } }), []);
  assert.deepEqual(buildPredictionRecords({}), []);
});

test('prediction ids are hour-stable so re-recording is idempotent', () => {
  const madeAt = Date.parse('2026-07-21T18:20:00Z');
  const sameHour = Date.parse('2026-07-21T18:59:00Z');
  const nextHour = Date.parse('2026-07-21T19:00:00Z');
  assert.equal(predictionId('btc', madeAt, 48), predictionId('btc', sameHour, 48));
  assert.notEqual(predictionId('btc', madeAt, 48), predictionId('btc', nextHour, 48));
  assert.equal(predictionId('btc', madeAt, 48), 'btc:2026-07-21T18:00:00Z:48');
});

test('appendPredictions dedupes by id and preserves existing entries', () => {
  const [btc] = buildPredictionRecords(anchoredSnapshot());
  const log = appendPredictions([], [btc]);
  assert.equal(log.length, 1);
  const again = appendPredictions(log, [btc]);
  assert.equal(again.length, 1, 'a duplicate id must not be appended twice');
});

test('a resolved record requires consistent actual, resolved_at and hit', () => {
  const [btc] = buildPredictionRecords(anchoredSnapshot());
  const resolvedAt = formatMexicoCityTimestamp(new Date(Date.parse(btc.target_at) + HOUR));
  assert.doesNotThrow(() =>
    assertValidPredictionRecord({ ...btc, actual: 65000, resolved_at: resolvedAt, hit: true }),
  );
  // resolved without data: hit must be null
  assert.doesNotThrow(() =>
    assertValidPredictionRecord({ ...btc, actual: null, resolved_at: resolvedAt, hit: null }),
  );
  // actual present but hit null is contradictory
  assert.throws(() =>
    assertValidPredictionRecord({ ...btc, actual: 65000, resolved_at: resolvedAt, hit: null }),
  );
  // resolved_at null but hit set is contradictory
  assert.throws(() => assertValidPredictionRecord({ ...btc, hit: true }));
});

test('unknown fields and wrong horizon are rejected', () => {
  const [btc] = buildPredictionRecords(anchoredSnapshot());
  assert.throws(() => assertValidPredictionRecord({ ...btc, surprise: 1 }));
  assert.throws(() => assertValidPredictionRecord({ ...btc, horizon_h: 24 }));
});

test('the contract enforces semantic truth, not just shape', () => {
  const [btc] = buildPredictionRecords(anchoredSnapshot()); // direction up, anchor 64000
  const afterTarget = formatMexicoCityTimestamp(new Date(Date.parse(btc.target_at) + HOUR));
  const beforeTarget = formatMexicoCityTimestamp(new Date(Date.parse(btc.target_at) - HOUR));

  // direction must match predicted vs anchor: labelling an up move "down" fails
  assert.throws(() => assertValidPredictionRecord({ ...btc, direction: 'down' }));

  // hit must be the truth: up predicted, real price BELOW anchor is not a hit
  assert.throws(() =>
    assertValidPredictionRecord({ ...btc, actual: 60000, resolved_at: afterTarget, hit: true }),
  );
  // ...and the honest version passes
  assert.doesNotThrow(() =>
    assertValidPredictionRecord({ ...btc, actual: 60000, resolved_at: afterTarget, hit: false }),
  );

  // a prediction cannot be resolved before its target time has arrived
  assert.throws(() =>
    assertValidPredictionRecord({ ...btc, actual: 66000, resolved_at: beforeTarget, hit: true }),
  );
});

test('accuracy block: available requires one-decimal percents and matching status', () => {
  const good = {
    status: 'available',
    window_days: 7,
    measured_through: formatMexicoCityTimestamp(new Date()),
    assets: {
      btc: { status: 'available', hit_rate: 58.3, sample_size: 96 },
      eth: { status: 'insufficient_data', hit_rate: null, sample_size: 11 },
    },
  };
  const withBtc = (btc) => ({ ...good, assets: { ...good.assets, btc } });
  assert.doesNotThrow(() => assertValidAccuracy(good));
  assert.ok(isValidAccuracy(unavailableAccuracy()));
  // hit_rate with two decimals is rejected
  assert.equal(isValidAccuracy(withBtc({ status: 'available', hit_rate: 58.33, sample_size: 96 })), false);
  // available status with null hit_rate is rejected
  assert.equal(isValidAccuracy(withBtc({ status: 'available', hit_rate: null, sample_size: 96 })), false);
  // insufficient_data must carry a null hit_rate
  assert.equal(isValidAccuracy({ ...good, assets: { ...good.assets, eth: { status: 'insufficient_data', hit_rate: 40.0, sample_size: 11 } } }), false);
});

test('accuracy block: the 20-sample threshold and 7-day window are enforced', () => {
  const measured_through = formatMexicoCityTimestamp(new Date());
  const build = (btc, window_days = 7) => ({
    status: 'available',
    window_days,
    measured_through,
    assets: { btc, eth: { status: 'insufficient_data', hit_rate: null, sample_size: 0 } },
  });
  // 20 samples: available is allowed
  assert.ok(isValidAccuracy(build({ status: 'available', hit_rate: 50.0, sample_size: 20 })));
  // 19 samples cannot be available (this is the regression Codex reproduced)
  assert.equal(isValidAccuracy(build({ status: 'available', hit_rate: 77.7, sample_size: 19 })), false);
  assert.equal(isValidAccuracy(build({ status: 'available', hit_rate: 77.7, sample_size: 1 })), false);
  // 20+ samples cannot be insufficient_data
  assert.equal(isValidAccuracy(build({ status: 'insufficient_data', hit_rate: null, sample_size: 25 })), false);
  // window must be exactly 7 days
  assert.equal(isValidAccuracy(build({ status: 'available', hit_rate: 50.0, sample_size: 96 }, 30)), false);
});
