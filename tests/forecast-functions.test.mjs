import assert from "node:assert/strict";
import { test } from "node:test";

import {
  LATEST_FORECAST_KEY,
  MODEL_ARTIFACTS_STORE,
  PREVIOUS_FORECAST_KEY,
  anchorForecast,
  assertValidForecastArtifact,
  forecastArtifactStatus,
  readUsableForecastArtifact,
} from "../netlify/lib/forecast-contract.mjs";
import {
  createFreshSnapshot,
  createSeedSnapshot,
  formatMexicoCityTimestamp,
  isValidSnapshot,
} from "../netlify/lib/market-contract.mjs";
import {
  MARKET_DATA_STORE,
  runPrediction,
} from "../netlify/functions/predict.mjs";

const SAMPLE_PRICES = {
  btc: { price: 65000.25, sourceUpdatedAt: "2026-07-17T08:14:31.000Z" },
  eth: { price: 3500.75, sourceUpdatedAt: "2026-07-17T08:14:29.000Z" },
};

function directionFor(value) {
  if (value >= 0.005) return "up";
  if (value <= -0.005) return "down";
  return "flat";
}

function artifactFixture({
  generatedAt = "2026-07-17T01:00:00-06:00",
  revision = "a1b2c3d",
  runId = "gh987654321-1",
} = {}) {
  const generated = new Date(generatedAt);
  const artifactVersion = `${generated
    .toISOString()
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replace(".000", "")}-${revision}-${runId}`;
  const makeAsset = (id, symbol, price, factorAt) => {
    const forecast = Array.from({ length: 48 }, (_, index) => ({
      offset_hours: index + 1,
      return_factor: factorAt(index + 1),
    }));
    const terminalReturn = forecast[47].return_factor - 1;
    const confidence = symbol === "BTC"
      ? {
          value: 72.5,
          status: "available",
          method: "rolling_origin_48h_residuals",
          sample_size: 40,
        }
      : {
          value: null,
          status: "insufficient_validation",
          method: "rolling_origin_48h_residuals",
          sample_size: 12,
        };
    return {
      id,
      symbol,
      reference: {
        price,
        observed_at: formatMexicoCityTimestamp(
          new Date(generated.getTime() - 60 * 60 * 1_000),
        ),
      },
      forecast,
      summary: {
        terminal_return: terminalReturn,
        direction: directionFor(terminalReturn),
        confidence,
      },
    };
  };

  return {
    schema_version: "forecast-artifact/1.0",
    artifact_version: artifactVersion,
    artifact_type: "relative_hourly_forecast",
    generated_at: formatMexicoCityTimestamp(generated),
    data_through: formatMexicoCityTimestamp(
      new Date(generated.getTime() - 60 * 60 * 1_000),
    ),
    valid_until: formatMexicoCityTimestamp(
      new Date(generated.getTime() + 36 * 60 * 60 * 1_000),
    ),
    expires_at: formatMexicoCityTimestamp(
      new Date(generated.getTime() + 72 * 60 * 60 * 1_000),
    ),
    timezone: "America/Mexico_City",
    currency: "usd",
    horizon_hours: 48,
    step_hours: 1,
    direction_policy: {
      horizon_hours: 48,
      flat_threshold_return: 0.005,
    },
    producer: {
      model_id: "opaque-test-model",
      code_revision: revision,
      run_id: runId,
    },
    assets: {
      btc: makeAsset("bitcoin", "BTC", 64000, (offset) => 1 + offset / 4800),
      eth: makeAsset("ethereum", "ETH", 3400, (offset) => 1 - offset / 9600),
    },
  };
}

function makeModelStore(values = {}, { failReads = false } = {}) {
  const calls = [];
  return {
    calls,
    async get(key, options) {
      calls.push([key, options]);
      if (failReads) throw new Error("model store unavailable");
      const value = values[key];
      if (value === undefined || value === null) return null;
      if (options?.type === "text" && typeof value !== "string") {
        return JSON.stringify(value);
      }
      return value;
    },
  };
}

function makeMarketStore(initialSnapshot = null) {
  const writes = [];
  return {
    writes,
    async get() {
      return initialSnapshot;
    },
    async setJSON(key, value) {
      writes.push([key, value]);
    },
  };
}

test("selects a fresh latest artifact with a strong JSON read", async () => {
  const latest = artifactFixture();
  const store = makeModelStore({ [LATEST_FORECAST_KEY]: latest });

  const selected = await readUsableForecastArtifact(
    store,
    new Date("2026-07-17T02:15:00-06:00"),
  );

  assert.deepEqual(selected.artifact, latest);
  assert.equal(selected.status, "fresh");
  assert.equal(selected.key, LATEST_FORECAST_KEY);
  assert.deepEqual(store.calls, [[LATEST_FORECAST_KEY, {
    consistency: "strong",
    type: "text",
  }]]);
});

test("keeps a stale but usable latest artifact without reading previous", async () => {
  const latest = artifactFixture();
  const previous = artifactFixture({ runId: "gh987654320-1" });
  const store = makeModelStore({
    [LATEST_FORECAST_KEY]: latest,
    [PREVIOUS_FORECAST_KEY]: previous,
  });

  const selected = await readUsableForecastArtifact(
    store,
    new Date("2026-07-19T00:00:00-06:00"),
  );

  assert.deepEqual(selected.artifact, latest);
  assert.equal(selected.status, "stale");
  assert.deepEqual(store.calls.map(([key]) => key), [LATEST_FORECAST_KEY]);
});

test("falls back from corrupt latest to a usable previous artifact", async () => {
  const previous = artifactFixture({ runId: "gh987654320-1" });
  const store = makeModelStore({
    [LATEST_FORECAST_KEY]: { schema_version: "forecast-artifact/1.0" },
    [PREVIOUS_FORECAST_KEY]: previous,
  });

  const selected = await readUsableForecastArtifact(
    store,
    new Date("2026-07-17T02:15:00-06:00"),
  );

  assert.deepEqual(selected.artifact, previous);
  assert.equal(selected.key, PREVIOUS_FORECAST_KEY);
  assert.deepEqual(store.calls.map(([key]) => key), [
    LATEST_FORECAST_KEY,
    PREVIOUS_FORECAST_KEY,
  ]);
});

test("falls back from malformed latest JSON bytes to a usable previous", async () => {
  const previous = artifactFixture({ runId: "gh987654320-1" });
  const store = makeModelStore({
    [LATEST_FORECAST_KEY]: '{"schema_version":',
    [PREVIOUS_FORECAST_KEY]: previous,
  });

  const selected = await readUsableForecastArtifact(
    store,
    new Date("2026-07-17T02:15:00-06:00"),
  );

  assert.deepEqual(selected.artifact, previous);
  assert.equal(selected.key, PREVIOUS_FORECAST_KEY);
  assert.deepEqual(store.calls.map(([key]) => key), [
    LATEST_FORECAST_KEY,
    PREVIOUS_FORECAST_KEY,
  ]);
});

test("falls back from expired latest to a usable previous artifact", async () => {
  const latest = artifactFixture({ generatedAt: "2026-07-10T01:00:00-06:00" });
  const previous = artifactFixture({
    generatedAt: "2026-07-17T01:00:00-06:00",
    runId: "gh987654320-1",
  });
  const store = makeModelStore({
    [LATEST_FORECAST_KEY]: latest,
    [PREVIOUS_FORECAST_KEY]: previous,
  });

  const selected = await readUsableForecastArtifact(
    store,
    new Date("2026-07-17T02:15:00-06:00"),
  );

  assert.deepEqual(selected.artifact, previous);
  assert.equal(selected.status, "fresh");
});

test("returns unavailable when latest and previous are unusable", async () => {
  const expired = artifactFixture({ generatedAt: "2026-07-10T01:00:00-06:00" });
  const store = makeModelStore({
    [LATEST_FORECAST_KEY]: expired,
    [PREVIOUS_FORECAST_KEY]: { schema_version: "unsupported" },
  });

  const selected = await readUsableForecastArtifact(
    store,
    new Date("2026-07-17T02:15:00-06:00"),
  );

  assert.equal(selected, null);
});

test("a model store read outage does not substitute previous", async () => {
  const previous = artifactFixture({ runId: "gh987654320-1" });
  const store = makeModelStore(
    { [PREVIOUS_FORECAST_KEY]: previous },
    { failReads: true },
  );

  const selected = await readUsableForecastArtifact(
    store,
    new Date("2026-07-17T02:15:00-06:00"),
  );

  assert.equal(selected, null);
  assert.deepEqual(store.calls.map(([key]) => key), [LATEST_FORECAST_KEY]);
});

test("artifact status uses valid_until and expires_at boundaries", () => {
  const artifact = artifactFixture();
  assert.equal(forecastArtifactStatus(artifact, artifact.valid_until), "fresh");
  assert.equal(
    forecastArtifactStatus(
      artifact,
      new Date(Date.parse(artifact.valid_until) + 1),
    ),
    "stale",
  );
  assert.equal(forecastArtifactStatus(artifact, artifact.expires_at), "stale");
  assert.equal(
    forecastArtifactStatus(
      artifact,
      new Date(Date.parse(artifact.expires_at) + 1),
    ),
    "unavailable",
  );
});

test("fresh ingestion anchors exactly 48 future points to live prices", async () => {
  const artifact = artifactFixture();
  const marketStore = makeMarketStore();
  const modelStore = makeModelStore({ [LATEST_FORECAST_KEY]: artifact });
  const anchoredAt = new Date("2026-07-17T02:15:00-06:00");

  const { status, snapshot } = await runPrediction({
    getStoreFn: (name) => name === MARKET_DATA_STORE ? marketStore : modelStore,
    fetchPrices: async () => SAMPLE_PRICES,
    clock: () => anchoredAt,
  });

  assert.equal(status, "fresh");
  assert.equal(snapshot.forecast.status, "fresh");
  assert.equal(snapshot.forecast.anchored_at, "2026-07-17T02:15:00-06:00");
  for (const asset of ["btc", "eth"]) {
    const output = snapshot.forecast.assets[asset];
    assert.equal(output.points.length, 48);
    assert.deepEqual(output.confidence, artifact.assets[asset].summary.confidence);
    assert.equal(output.terminal_return, artifact.assets[asset].summary.terminal_return);
    assert.equal(output.direction, artifact.assets[asset].summary.direction);
    output.points.forEach((point, index) => {
      const modelPoint = artifact.assets[asset].forecast[index];
      assert.equal(point.offset_hours, index + 1);
      assert.equal(
        point.target_at,
        formatMexicoCityTimestamp(
          new Date(anchoredAt.getTime() + (index + 1) * 60 * 60 * 1_000),
        ),
      );
      assert.equal(
        point.price,
        SAMPLE_PRICES[asset].price * modelPoint.return_factor,
      );
      assert.equal(Object.hasOwn(point, "return_factor"), false);
    });
    assert.equal(Object.hasOwn(output, "reference"), false);
  }
});

test("model store outage never breaks fresh market prices", async () => {
  const marketStore = makeMarketStore();
  const storesRequested = [];
  const warnings = [];

  const { status, snapshot } = await runPrediction({
    getStoreFn: (name) => {
      storesRequested.push(name);
      if (name === MODEL_ARTIFACTS_STORE) throw new Error("model store down");
      return marketStore;
    },
    fetchPrices: async () => SAMPLE_PRICES,
    clock: () => new Date("2026-07-17T02:15:00-06:00"),
    logger: { warn: (message) => warnings.push(message) },
  });

  assert.equal(status, "fresh");
  assert.equal(snapshot.stale, false);
  assert.equal(snapshot.assets.btc.price, SAMPLE_PRICES.btc.price);
  assert.deepEqual(snapshot.forecast, { status: "unavailable" });
  assert.deepEqual(storesRequested, [MARKET_DATA_STORE, MODEL_ARTIFACTS_STORE]);
  assert.deepEqual(warnings, [
    "Forecast anchoring skipped; fresh market data remains available.",
  ]);
});

test("CoinGecko failure preserves anchor and points while forecast ages", async () => {
  const artifact = artifactFixture();
  const anchoredAt = new Date("2026-07-17T02:15:00-06:00");
  const freshMarket = createFreshSnapshot(SAMPLE_PRICES, anchoredAt);
  const forecast = anchorForecast(
    artifact,
    "fresh",
    freshMarket,
    formatMexicoCityTimestamp,
  );
  const previous = createFreshSnapshot(SAMPLE_PRICES, anchoredAt, forecast);
  const originalPoints = structuredClone(previous.forecast.assets.btc.points);
  let modelStoreRequested = false;

  const staleStore = makeMarketStore(previous);
  const staleResult = await runPrediction({
    getStoreFn: (name) => {
      if (name === MODEL_ARTIFACTS_STORE) modelStoreRequested = true;
      return staleStore;
    },
    fetchPrices: async () => { throw new Error("CoinGecko down"); },
    clock: () => new Date("2026-07-19T00:00:00-06:00"),
  });

  assert.equal(staleResult.snapshot.stale, true);
  assert.equal(staleResult.snapshot.generated_at, previous.generated_at);
  assert.equal(staleResult.snapshot.forecast.status, "stale");
  assert.equal(staleResult.snapshot.forecast.anchored_at, previous.forecast.anchored_at);
  assert.deepEqual(staleResult.snapshot.forecast.assets.btc.points, originalPoints);
  assert.equal(modelStoreRequested, false);

  const expiredStore = makeMarketStore(staleResult.snapshot);
  const expiredResult = await runPrediction({
    getStoreFn: () => expiredStore,
    fetchPrices: async () => { throw new Error("CoinGecko still down"); },
    clock: () => new Date("2026-07-20T02:00:00-06:00"),
  });
  assert.deepEqual(expiredResult.snapshot.forecast, { status: "unavailable" });
  assert.equal(expiredResult.snapshot.generated_at, previous.generated_at);
  assert.equal(expiredResult.snapshot.assets.btc.price, previous.assets.btc.price);
});

test("new fresh snapshots default to an unavailable forecast", () => {
  const snapshot = createFreshSnapshot(
    SAMPLE_PRICES,
    new Date("2026-07-17T02:15:00-06:00"),
  );
  assert.deepEqual(snapshot.forecast, { status: "unavailable" });
  assert.equal(isValidSnapshot(snapshot), true);
});

test("new seed snapshots include an explicit unavailable forecast", () => {
  const snapshot = createSeedSnapshot();
  assert.deepEqual(snapshot.forecast, { status: "unavailable" });
  assert.equal(isValidSnapshot(snapshot), true);
});

test("strict artifact validator rejects semantic and structural invalids", () => {
  const mutations = [
    (artifact) => { artifact.unexpected = true; },
    (artifact) => { artifact.assets.btc.reference.unexpected = true; },
    (artifact) => { artifact.assets.btc.forecast.pop(); },
    (artifact) => { artifact.assets.btc.forecast[0].offset_hours = 2; },
    (artifact) => { artifact.assets.btc.forecast[0].return_factor = 0; },
    (artifact) => { artifact.assets.btc.summary.terminal_return = 0; },
    (artifact) => { artifact.assets.btc.summary.confidence.accuracy = 99; },
    (artifact) => { artifact.valid_until = artifact.expires_at; },
    (artifact) => { artifact.schema_version = "forecast-artifact/2.0"; },
  ];

  for (const mutate of mutations) {
    const artifact = artifactFixture();
    mutate(artifact);
    assert.throws(() => assertValidForecastArtifact(artifact));
  }
});

test("snapshot validator rejects leaked model internals and malformed public points", () => {
  const artifact = artifactFixture();
  const market = createFreshSnapshot(
    SAMPLE_PRICES,
    new Date("2026-07-17T02:15:00-06:00"),
  );
  const forecast = anchorForecast(
    artifact,
    "fresh",
    market,
    formatMexicoCityTimestamp,
  );
  const snapshot = createFreshSnapshot(
    SAMPLE_PRICES,
    new Date("2026-07-17T02:15:00-06:00"),
    forecast,
  );

  const leakedFactor = structuredClone(snapshot);
  leakedFactor.forecast.assets.btc.points[0].return_factor = 1.1;
  assert.equal(isValidSnapshot(leakedFactor), false);

  const leakedReference = structuredClone(snapshot);
  leakedReference.forecast.assets.eth.reference = { price: 3400 };
  assert.equal(isValidSnapshot(leakedReference), false);

  const partial = structuredClone(snapshot);
  partial.forecast.assets.btc.points.pop();
  assert.equal(isValidSnapshot(partial), false);

  const wrongDirection = structuredClone(snapshot);
  wrongDirection.forecast.assets.btc.direction = "down";
  assert.equal(isValidSnapshot(wrongDirection), false);

  const wrongTimezoneOffset = structuredClone(snapshot);
  wrongTimezoneOffset.forecast.assets.btc.points[0].target_at =
    new Date(wrongTimezoneOffset.forecast.assets.btc.points[0].target_at).toISOString();
  assert.equal(isValidSnapshot(wrongTimezoneOffset), false);
});
