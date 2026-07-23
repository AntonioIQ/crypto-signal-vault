import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  accuracyView,
  artifactGeneratedAt,
  forecastView,
} from "../public/js/forecast-ui.js";

test("accuracy card shows a percentage only when measured and sufficient", () => {
  const base = {
    status: "available",
    window_days: 7,
    measured_through: "2026-07-21T01:30:00-06:00",
    assets: {
      btc: { status: "available", hit_rate: 58.3, sample_size: 96 },
      eth: { status: "insufficient_data", hit_rate: null, sample_size: 11 },
    },
  };
  const btc = accuracyView({ accuracy: base }, "btc");
  assert.equal(btc.available, true);
  assert.equal(btc.label, "58 %");
  assert.match(btc.status, /96/);

  const eth = accuracyView({ accuracy: base }, "eth");
  assert.equal(eth.available, false);
  assert.equal(eth.label, "—");
  assert.match(eth.status, /11/);

  // No accuracy block, or an unavailable one, leaves the card blank.
  assert.equal(accuracyView({}, "btc").label, "—");
  assert.equal(accuracyView({ accuracy: { status: "unavailable" } }, "btc").available, false);
});

function snapshotFixture({
  status = "fresh",
  direction = "up",
  confidence = {
    value: 72.5,
    status: "available",
    method: "rolling_origin_48h_residuals",
    sample_size: 40,
  },
} = {}) {
  const anchoredAt = "2026-07-17T02:15:00-06:00";
  const anchorMs = Date.parse(anchoredAt);
  const makeAsset = (price) => ({
    direction,
    terminal_return: direction === "up" ? 0.018 : direction === "down" ? -0.018 : 0.002,
    confidence,
    points: Array.from({ length: 48 }, (_, index) => ({
      offset_hours: index + 1,
      target_at: new Date(anchorMs + (index + 1) * 3_600_000).toISOString(),
      price: price * (1 + (index + 1) / 4_800),
    })),
  });

  return {
    schema_version: "1.0",
    generated_at: anchoredAt,
    assets: {
      btc: { name: "Bitcoin", price: 65_000 },
      eth: { name: "Ethereum", price: 3_500 },
    },
    forecast: {
      status,
      artifact_version: "20260717T070000Z-a1b2c3d-gh987654321-1",
      anchored_at: anchoredAt,
      valid_until: "2026-07-18T13:00:00-06:00",
      expires_at: "2026-07-20T01:00:00-06:00",
      assets: {
        btc: makeAsset(65_000),
        eth: makeAsset(3_500),
      },
    },
  };
}

test("legacy snapshots without forecast render an honest unavailable state", () => {
  const view = forecastView({ assets: { btc: { price: 65_000 } } }, "btc");

  assert.equal(view.available, false);
  assert.equal(view.confidenceLabel, "Sin medición");
  assert.equal(view.points.length, 0);
});

test("fresh forecast exposes simple direction and measured confidence copy", () => {
  const view = forecastView(snapshotFixture(), "btc");

  assert.equal(view.available, true);
  assert.equal(view.status, "fresh");
  assert.equal(view.directionLabel, "Probablemente suba");
  assert.equal(view.confidenceLabel, "73 %");
  assert.equal(view.points.length, 48);
});

test("insufficient validation never becomes a made-up percentage", () => {
  const snapshot = snapshotFixture({
    direction: "flat",
    confidence: {
      value: null,
      status: "insufficient_validation",
      method: "rolling_origin_48h_residuals",
      sample_size: 12,
    },
  });
  const view = forecastView(snapshot, "eth");

  assert.equal(view.available, true);
  assert.equal(view.directionLabel, "Probablemente se mantenga");
  assert.equal(view.confidenceAvailable, false);
  assert.equal(view.confidenceLabel, "Aún no medible");
});

test("stale downward forecasts remain visible with an update warning state", () => {
  const view = forecastView(
    snapshotFixture({ status: "stale", direction: "down" }),
    "btc",
  );

  assert.equal(view.available, true);
  assert.equal(view.status, "stale");
  assert.equal(view.directionLabel, "Probablemente baje");
  assert.equal(view.tone, "down");
});

test("partial forecasts degrade to unavailable instead of drawing a line", () => {
  const snapshot = snapshotFixture();
  snapshot.forecast.assets.btc.points.pop();

  assert.equal(forecastView(snapshot, "btc").available, false);
});

test("artifact version exposes its UTC generation timestamp", () => {
  assert.equal(
    artifactGeneratedAt("20260717T070000Z-a1b2c3d-gh987654321-1").toISOString(),
    "2026-07-17T07:00:00.000Z",
  );
  assert.equal(artifactGeneratedAt("not-a-version"), null);
});

test("initial HTML does not parser-block on Chart.js and declares a favicon", async () => {
  const html = await readFile("public/index.html", "utf8");

  assert.doesNotMatch(html, /<script[^>]+(?:chart(?:\.umd)?|vendor)/i);
  assert.match(html, /<link rel="icon" href="favicon\.svg"/);
});
