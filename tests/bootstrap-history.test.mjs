import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  bootstrapHistory,
  HISTORY_DAYS,
} from "../scripts/bootstrap-history.mjs";

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
    [
      ["bitcoin", { days: HISTORY_DAYS }],
      ["ethereum", { days: HISTORY_DAYS }],
    ],
  );
  assert.deepEqual(Object.keys(documents).sort(), ["btc", "eth"]);

  for (const [asset, coinId] of [
    ["btc", "bitcoin"],
    ["eth", "ethereum"],
  ]) {
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
