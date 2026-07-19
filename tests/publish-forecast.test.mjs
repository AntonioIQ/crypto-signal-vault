import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import {
  ForecastPublicationError,
  LATEST_FORECAST_KEY,
  PREVIOUS_FORECAST_KEY,
  cliErrorMessage,
  createArtifactStore,
  publishForecast,
  validateForecastPayload,
  versionKey,
} from '../scripts/publish-forecast.mjs';


function artifactPayload({
  generatedAt = '2026-07-17T01:00:00-06:00',
  revision = 'a1b2c3d',
  runId = 'gh987654321-1',
} = {}) {
  const generated = new Date(generatedAt);
  const compact = generated
    .toISOString()
    .replaceAll('-', '')
    .replaceAll(':', '')
    .replace('.000', '');
  const forecast = Array.from({ length: 48 }, (_, index) => ({
    offset_hours: index + 1,
    return_factor: 1 + (index + 1) / 4800,
  }));
  const asset = (id, symbol, price) => ({
    id,
    symbol,
    reference: {
      price,
      observed_at: '2026-07-17T00:00:00-06:00',
    },
    forecast,
    summary: {
      terminal_return: forecast[47].return_factor - 1,
      direction: 'up',
      confidence: {
        value: 75,
        status: 'available',
        method: 'rolling_origin_48h_residuals',
        sample_size: 20,
      },
    },
  });
  return `${JSON.stringify({
    schema_version: 'forecast-artifact/1.0',
    artifact_version: `${compact}-${revision}-${runId}`,
    artifact_type: 'relative_hourly_forecast',
    generated_at: generatedAt,
    data_through: '2026-07-17T00:00:00-06:00',
    valid_until: '2026-07-18T13:00:00-06:00',
    expires_at: '2026-07-20T01:00:00-06:00',
    timezone: 'America/Mexico_City',
    currency: 'usd',
    horizon_hours: 48,
    step_hours: 1,
    direction_policy: {
      horizon_hours: 48,
      flat_threshold_return: 0.005,
    },
    producer: {
      model_id: 'test-model',
      code_revision: revision,
      run_id: runId,
    },
    assets: {
      btc: asset('bitcoin', 'BTC', 65000),
      eth: asset('ethereum', 'ETH', 3500),
    },
  }, null, 2)}\n`;
}


function makeStore(seed = {}, {
  failGetKey = null,
  failSetKey = null,
  skipWriteKey = null,
  writeDifferentBytesKey = null,
} = {}) {
  const blobs = new Map(Object.entries(seed));
  const calls = [];
  return {
    blobs,
    calls,
    async get(key, options) {
      calls.push(['get', key, options]);
      if (key === failGetKey) throw new Error('injected storage read failure');
      return blobs.get(key) ?? null;
    },
    async set(key, value, options = {}) {
      calls.push(['set', key, value, options]);
      if (key === failSetKey) throw new Error('injected storage failure');
      if (options.onlyIfNew && blobs.has(key)) return { modified: false };
      if (key !== skipWriteKey) {
        blobs.set(key, key === writeDifferentBytesKey ? 'different bytes' : value);
      }
      return { modified: true, etag: `etag-${calls.length}` };
    },
  };
}


test('publishes immutable version, previous, and byte-identical latest in order', async () => {
  const prior = artifactPayload({ runId: 'gh987654320-1' });
  const payload = artifactPayload();
  const artifact = validateForecastPayload(payload);
  const store = makeStore({ [LATEST_FORECAST_KEY]: prior });

  const result = await publishForecast({ payload, store });

  assert.equal(store.blobs.get(versionKey(artifact.artifact_version)), payload);
  assert.equal(store.blobs.get(PREVIOUS_FORECAST_KEY), prior);
  assert.equal(store.blobs.get(LATEST_FORECAST_KEY), payload);
  assert.equal(result.previousSaved, true);
  assert.deepEqual(
    store.calls.map(([operation, key]) => [operation, key]),
    [
      ['set', versionKey(artifact.artifact_version)],
      ['get', versionKey(artifact.artifact_version)],
      ['get', LATEST_FORECAST_KEY],
      ['set', PREVIOUS_FORECAST_KEY],
      ['set', LATEST_FORECAST_KEY],
    ],
  );
  assert.deepEqual(store.calls[0][3], { onlyIfNew: true });
});


test('first publication skips previous and promotes latest', async () => {
  const payload = artifactPayload();
  const artifact = validateForecastPayload(payload);
  const store = makeStore();

  const result = await publishForecast({ payload, store });

  assert.equal(result.previousSaved, false);
  assert.equal(store.blobs.has(PREVIOUS_FORECAST_KEY), false);
  assert.equal(store.blobs.get(versionKey(artifact.artifact_version)), payload);
  assert.equal(store.blobs.get(LATEST_FORECAST_KEY), payload);
});


test('corrupt prior latest is not copied to previous', async () => {
  const payload = artifactPayload();
  const store = makeStore({ [LATEST_FORECAST_KEY]: '{"corrupt":true}' });

  const result = await publishForecast({ payload, store });

  assert.equal(result.previousSaved, false);
  assert.equal(store.blobs.has(PREVIOUS_FORECAST_KEY), false);
  assert.equal(store.blobs.get(LATEST_FORECAST_KEY), payload);
});


test('immutable version collision is rejected before latest changes', async () => {
  const payload = artifactPayload();
  const artifact = validateForecastPayload(payload);
  const prior = artifactPayload({ runId: 'gh987654320-1' });
  const immutableKey = versionKey(artifact.artifact_version);
  const store = makeStore({
    [immutableKey]: 'existing immutable bytes',
    [LATEST_FORECAST_KEY]: prior,
  });

  await assert.rejects(
    publishForecast({ payload, store }),
    (error) => error instanceof ForecastPublicationError
      && error.message === 'artifact_version already exists',
  );
  assert.equal(store.blobs.get(immutableKey), 'existing immutable bytes');
  assert.equal(store.blobs.get(LATEST_FORECAST_KEY), prior);
  assert.equal(store.calls.length, 1);
});


test('modified true without a persisted immutable blob aborts before latest', async () => {
  const payload = artifactPayload();
  const artifact = validateForecastPayload(payload);
  const prior = artifactPayload({ runId: 'gh987654320-1' });
  const immutableKey = versionKey(artifact.artifact_version);
  const store = makeStore(
    { [LATEST_FORECAST_KEY]: prior },
    { skipWriteKey: immutableKey },
  );

  await assert.rejects(
    publishForecast({ payload, store }),
    /immutable artifact verification failed/,
  );

  assert.equal(store.blobs.has(immutableKey), false);
  assert.equal(store.blobs.get(LATEST_FORECAST_KEY), prior);
  assert.deepEqual(store.calls.map(([, key]) => key), [immutableKey, immutableKey]);
});


test('different immutable bytes abort before latest rotation', async () => {
  const payload = artifactPayload();
  const artifact = validateForecastPayload(payload);
  const prior = artifactPayload({ runId: 'gh987654320-1' });
  const immutableKey = versionKey(artifact.artifact_version);
  const store = makeStore(
    { [LATEST_FORECAST_KEY]: prior },
    { writeDifferentBytesKey: immutableKey },
  );

  await assert.rejects(
    publishForecast({ payload, store }),
    /immutable artifact verification failed/,
  );

  assert.equal(store.blobs.get(immutableKey), 'different bytes');
  assert.equal(store.blobs.get(LATEST_FORECAST_KEY), prior);
  assert.equal(store.blobs.has(PREVIOUS_FORECAST_KEY), false);
});


test('strong-read failure aborts before latest rotation', async () => {
  const payload = artifactPayload();
  const artifact = validateForecastPayload(payload);
  const prior = artifactPayload({ runId: 'gh987654320-1' });
  const immutableKey = versionKey(artifact.artifact_version);
  const store = makeStore(
    { [LATEST_FORECAST_KEY]: prior },
    { failGetKey: immutableKey },
  );

  await assert.rejects(
    publishForecast({ payload, store }),
    /injected storage read failure/,
  );

  assert.equal(store.blobs.get(LATEST_FORECAST_KEY), prior);
  assert.equal(store.blobs.has(PREVIOUS_FORECAST_KEY), false);
  assert.deepEqual(store.calls[1][2], { consistency: 'strong', type: 'text' });
});


test('invalid artifact performs no blob operations', async () => {
  const store = makeStore();

  await assert.rejects(
    publishForecast({ payload: '{"schema_version":"wrong"}', store }),
    ForecastPublicationError,
  );
  assert.equal(store.calls.length, 0);
  assert.equal(store.blobs.size, 0);
});


test('validator rejects unknown fields at every canonical object layer', () => {
  const mutations = [
    (artifact) => { artifact.unexpected = true; },
    (artifact) => { artifact.producer.unexpected = true; },
    (artifact) => { artifact.direction_policy.unexpected = true; },
    (artifact) => { artifact.assets.btc.unexpected = true; },
    (artifact) => { artifact.assets.btc.reference.unexpected = true; },
    (artifact) => { artifact.assets.btc.forecast[0].unexpected = true; },
    (artifact) => { artifact.assets.btc.summary.unexpected = true; },
    (artifact) => { artifact.assets.btc.summary.confidence.accuracy = 99; },
  ];

  for (const mutate of mutations) {
    const artifact = JSON.parse(artifactPayload());
    mutate(artifact);
    assert.throws(
      () => validateForecastPayload(JSON.stringify(artifact)),
      /fields are invalid/,
    );
  }
});


test('validator enforces canonical BTC and ETH identities', () => {
  for (const [asset, field, value] of [
    ['btc', 'id', 'ethereum'],
    ['btc', 'symbol', 'btc'],
    ['eth', 'id', 'bitcoin'],
    ['eth', 'symbol', 'ETHEREUM'],
  ]) {
    const artifact = JSON.parse(artifactPayload());
    artifact.assets[asset][field] = value;
    assert.throws(
      () => validateForecastPayload(JSON.stringify(artifact)),
      /identity is invalid/,
    );
  }
});


test('validator rejects hidden accuracy and confidence beyond one decimal', () => {
  const withAccuracy = JSON.parse(artifactPayload());
  withAccuracy.assets.btc.summary.confidence.accuracy = 99;
  assert.throws(
    () => validateForecastPayload(JSON.stringify(withAccuracy)),
    /fields are invalid/,
  );

  const overPrecise = JSON.parse(artifactPayload());
  overPrecise.assets.btc.summary.confidence.value = 72.55;
  assert.throws(
    () => validateForecastPayload(JSON.stringify(overPrecise)),
    /status is inconsistent/,
  );
});


test('publisher applies the runtime timestamp contract', () => {
  const artifact = JSON.parse(artifactPayload());
  artifact.generated_at = 'not-an-iso-timestamp';

  assert.throws(
    () => validateForecastPayload(JSON.stringify(artifact)),
    (error) => error instanceof ForecastPublicationError
      && /ISO-8601 timestamp/.test(error.message),
  );
});


test('intermediate failure leaves latest unchanged', async () => {
  const prior = artifactPayload({ runId: 'gh987654320-1' });
  const payload = artifactPayload();
  const artifact = validateForecastPayload(payload);
  const store = makeStore(
    { [LATEST_FORECAST_KEY]: prior },
    { failSetKey: PREVIOUS_FORECAST_KEY },
  );

  await assert.rejects(publishForecast({ payload, store }), /injected storage failure/);

  assert.equal(store.blobs.get(LATEST_FORECAST_KEY), prior);
  assert.equal(store.blobs.get(versionKey(artifact.artifact_version)), payload);
  assert.equal(store.blobs.has(PREVIOUS_FORECAST_KEY), false);
});


test('failed final promotion also leaves latest bytes unchanged', async () => {
  const prior = artifactPayload({ runId: 'gh987654320-1' });
  const payload = artifactPayload();
  const store = makeStore(
    { [LATEST_FORECAST_KEY]: prior },
    { failSetKey: LATEST_FORECAST_KEY },
  );

  await assert.rejects(publishForecast({ payload, store }), /injected storage failure/);

  assert.equal(store.blobs.get(LATEST_FORECAST_KEY), prior);
  assert.equal(store.blobs.get(PREVIOUS_FORECAST_KEY), prior);
});


test('artifact store requires credentials and never passes different option names', () => {
  assert.throws(
    () => createArtifactStore({ siteID: '', token: '' }),
    /NETLIFY_SITE_ID and NETLIFY_AUTH_TOKEN are required/,
  );
  const calls = [];
  const fakeStore = {};
  const result = createArtifactStore({
    siteID: 'site-id',
    token: 'secret-token',
    getStoreFn: (options) => {
      calls.push(options);
      return fakeStore;
    },
  });
  assert.equal(result, fakeStore);
  assert.deepEqual(calls, [{
    name: 'model-artifacts',
    siteID: 'site-id',
    token: 'secret-token',
  }]);
});


test('CLI error formatting exposes only controlled validation messages', () => {
  assert.equal(
    cliErrorMessage(new ForecastPublicationError('artifact_version is invalid')),
    'Forecast publication failed: artifact_version is invalid',
  );
  const external = cliErrorMessage(new Error('request failed with token secret-token'));
  assert.equal(external, 'Forecast publication failed due to an external error.');
  assert.equal(external.includes('secret-token'), false);
});


test('daily workflow gates the job to the main branch', async () => {
  const workflow = await readFile(
    new URL('../.github/workflows/train.yml', import.meta.url),
    'utf8',
  );
  assert.match(workflow, /^\s{4}if: github\.ref == 'refs\/heads\/main'$/m);
});
