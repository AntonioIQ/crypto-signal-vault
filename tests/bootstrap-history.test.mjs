import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  bootstrapHistory,
  HISTORY_DAYS,
} from "../scripts/bootstrap-history.mjs";
import { ASSETS } from "../netlify/lib/coingecko.mjs";

test("bootstrapHistory creates valid BTC and ETH documents and files", async (t) => {
  const outputDirectory = await mkdtemp(
    path.join(tmpdir(), "crypto-signal-vault-history-"),
  );
  t.after(() => rm(outputDirectory, { recursive: true, force: true }));

  const calls = [];
  const pointsByCoin = {
    bitcoin: [
      { timestamp: "2026-07-16T02:00:00.000Z", price: 65_100 },
      { timestamp: "2026-07-16T01:00:00.000Z", price: 65_000 },
    ],
    ethereum: [
      { timestamp: "2026-07-16T02:00:00.000Z", price: 3_510 },
      { timestamp: "2026-07-16T01:00:00.000Z", price: 3_500 },
    ],
  };
  // Every other configured coin gets generic points so bootstrap covers them all.
  for (const meta of Object.values(ASSETS)) {
    if (!pointsByCoin[meta.id]) {
      pointsByCoin[meta.id] = [
        { timestamp: "2026-07-16T02:00:00.000Z", price: 12 },
        { timestamp: "2026-07-16T01:00:00.000Z", price: 10 },
      ];
    }
  }
  const fetchChart = async (coinId, options) => {
    calls.push([coinId, options]);
    return pointsByCoin[coinId];
  };

  const documents = await bootstrapHistory({
    fetchChart,
    outputDirectory,
    clock: () => new Date("2026-07-16T12:00:00.000Z"),
  });

  assert.deepEqual(
    calls.sort(([left], [right]) => left.localeCompare(right)),
    Object.values(ASSETS)
      .map((meta) => [meta.id, { days: HISTORY_DAYS }])
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  assert.deepEqual(
    Object.keys(documents).sort(),
    Object.keys(ASSETS).slice().sort(),
  );

  for (const [asset, coinId] of Object.entries(ASSETS).map(([a, m]) => [a, m.id])) {
    const filePath = path.join(outputDirectory, `${asset}.json`);
    const fileDocument = JSON.parse(await readFile(filePath, "utf8"));

    assert.deepEqual(fileDocument, documents[asset]);
    assert.equal(fileDocument.schema_version, "1.0");
    assert.equal(fileDocument.asset, asset);
    assert.equal(fileDocument.coin_id, coinId);
    assert.equal(fileDocument.currency, "usd");
    assert.equal(fileDocument.generated_at, "2026-07-16T06:00:00-06:00");
    assert.equal(fileDocument.points.length, 2);
    assert.deepEqual(fileDocument.points, [...pointsByCoin[coinId]].reverse());
  }
});
