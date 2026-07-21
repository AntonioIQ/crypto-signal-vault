import { ASSETS } from "./coingecko.mjs";
import {
  isOneDecimalPercent,
  isPositiveNumber,
  isRecord,
  parseMexicoCityTimestamp,
  requireExactObject,
} from "./contract-helpers.mjs";

export const PREDICTION_SCHEMA_VERSION = "prediction-log/1.0";
export const PREDICTIONS_STORE = "predictions";
export const LOG_CURRENT_KEY = "log/current.json";
export const ACCURACY_KEY = "metrics/accuracy.json";
export const HEALTH_KEY = "metrics/health.json";
export const PREDICTION_HORIZON_HOURS = 48;
export const ACCURACY_WINDOW_DAYS = 7;
// Below this many resolved, hit-bearing predictions the rolling accuracy is not
// trustworthy enough to publish a number; the card stays honestly blank.
export const MIN_ACCURACY_SAMPLES = 20;
export const FLAT_THRESHOLD = 0.005;
const HOUR_MS = 60 * 60 * 1_000;

const RECORD_FIELDS = [
  "id",
  "made_at",
  "asset",
  "horizon_h",
  "artifact_version",
  "anchor_price",
  "predicted",
  "direction",
  "target_at",
  "actual",
  "resolved_at",
  "hit",
];
const DIRECTIONS = ["up", "down", "flat"];

export class PredictionContractError extends TypeError {}

function assert(condition, message) {
  if (!condition) throw new PredictionContractError(message);
}

// A stable, hour-resolution id so recording the same asset/hour/horizon is
// idempotent even though predict.mjs runs four times an hour.
export function utcHourBucket(milliseconds) {
  return new Date(Math.floor(milliseconds / HOUR_MS) * HOUR_MS)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");
}

export function predictionId(asset, madeAtMs, horizon = PREDICTION_HORIZON_HOURS) {
  return `${asset}:${utcHourBucket(madeAtMs)}:${horizon}`;
}

export function directionFor(relativeReturn) {
  if (relativeReturn >= FLAT_THRESHOLD) return "up";
  if (relativeReturn <= -FLAT_THRESHOLD) return "down";
  return "flat";
}

export function assertValidPredictionRecord(record) {
  const item = requireExactObject(record, RECORD_FIELDS, "prediction", PredictionContractError);

  assert(Object.hasOwn(ASSETS, item.asset), "prediction.asset is unsupported.");
  assert(item.horizon_h === PREDICTION_HORIZON_HOURS, "prediction.horizon_h is invalid.");
  assert(
    typeof item.artifact_version === "string" && item.artifact_version.length > 0,
    "prediction.artifact_version is invalid.",
  );
  assert(isPositiveNumber(item.anchor_price), "prediction.anchor_price must be positive.");
  assert(isPositiveNumber(item.predicted), "prediction.predicted must be positive.");
  assert(DIRECTIONS.includes(item.direction), "prediction.direction is invalid.");
  // The recorded direction must be the one implied by the predicted move, so a
  // mislabelled prediction can never be published as valid.
  assert(
    item.direction === directionFor(item.predicted / item.anchor_price - 1),
    "prediction.direction does not match predicted vs anchor.",
  );

  const madeAt = parseMexicoCityTimestamp(item.made_at, "prediction.made_at", PredictionContractError);
  const targetAt = parseMexicoCityTimestamp(item.target_at, "prediction.target_at", PredictionContractError);
  assert(
    targetAt === madeAt + item.horizon_h * HOUR_MS,
    "prediction.target_at must equal made_at plus the horizon.",
  );
  assert(
    item.id === predictionId(item.asset, madeAt, item.horizon_h),
    "prediction.id does not match its asset, hour and horizon.",
  );

  // Resolution states: unresolved (all null), resolved-without-data (a
  // resolved_at but no real price, hit null), or resolved-with-data.
  if (item.resolved_at === null) {
    assert(
      item.actual === null && item.hit === null,
      "an unresolved prediction must have null actual and hit.",
    );
    return item;
  }

  const resolvedAt = parseMexicoCityTimestamp(item.resolved_at, "prediction.resolved_at", PredictionContractError);
  // A prediction cannot be resolved before its own target time has arrived.
  assert(resolvedAt >= targetAt, "prediction.resolved_at cannot precede target_at.");
  if (item.actual === null) {
    assert(item.hit === null, "a prediction resolved without data must have null hit.");
  } else {
    assert(isPositiveNumber(item.actual), "prediction.actual must be positive when present.");
    assert(typeof item.hit === "boolean", "prediction.hit must be boolean when actual is present.");
    // hit must be the truth: did the real move land in the predicted direction?
    assert(
      item.hit === (directionFor(item.actual / item.anchor_price - 1) === item.direction),
      "prediction.hit does not match the real move against anchor.",
    );
  }
  return item;
}

export function isValidPredictionRecord(record) {
  try {
    assertValidPredictionRecord(record);
    return true;
  } catch {
    return false;
  }
}

// Build one prediction per asset from a freshly anchored snapshot. Returns []
// unless the snapshot carries a `fresh` forecast, so a stale or absent forecast
// never produces a record.
export function buildPredictionRecords(snapshot) {
  const forecast = snapshot?.forecast;
  if (!isRecord(forecast) || forecast.status !== "fresh") return [];

  const madeAtMs = Date.parse(forecast.anchored_at);
  if (!Number.isFinite(madeAtMs)) return [];

  const records = [];
  for (const asset of Object.keys(ASSETS)) {
    const anchorPrice = snapshot?.assets?.[asset]?.price;
    const modelAsset = forecast.assets?.[asset];
    const terminal = modelAsset?.points?.[PREDICTION_HORIZON_HOURS - 1];
    if (!isPositiveNumber(anchorPrice) || !modelAsset || !terminal) continue;

    records.push(
      assertValidPredictionRecord({
        id: predictionId(asset, madeAtMs, PREDICTION_HORIZON_HOURS),
        made_at: forecast.anchored_at,
        asset,
        horizon_h: PREDICTION_HORIZON_HOURS,
        artifact_version: forecast.artifact_version,
        anchor_price: anchorPrice,
        predicted: terminal.price,
        direction: modelAsset.direction,
        target_at: terminal.target_at,
        actual: null,
        resolved_at: null,
        hit: null,
      }),
    );
  }
  return records;
}

// Append new records to a log, keeping the first entry seen for any id so a
// racing double-invocation cannot create duplicates. Returns a new array.
export function appendPredictions(log, records) {
  const existing = Array.isArray(log) ? log : [];
  const seen = new Set(existing.map((entry) => entry?.id));
  const additions = [];
  for (const record of records) {
    assertValidPredictionRecord(record);
    if (!seen.has(record.id)) {
      seen.add(record.id);
      additions.push(record);
    }
  }
  return [...existing, ...additions];
}

function validateAccuracyAsset(value, label) {
  const item = requireExactObject(value, ["status", "hit_rate", "sample_size"], label, PredictionContractError);
  assert(
    Number.isInteger(item.sample_size) && item.sample_size >= 0,
    `${label}.sample_size must be a non-negative integer.`,
  );
  // The sample threshold is part of the contract, not just a producer
  // convention: a percentage may only ride on `available` with enough
  // resolved samples, so a hand-built block can never leak a fake number.
  if (item.status === "available") {
    assert(
      item.sample_size >= MIN_ACCURACY_SAMPLES,
      `${label} cannot be available below ${MIN_ACCURACY_SAMPLES} samples.`,
    );
    assert(isOneDecimalPercent(item.hit_rate), `${label}.hit_rate must be a one-decimal percent.`);
  } else if (item.status === "insufficient_data") {
    assert(
      item.sample_size < MIN_ACCURACY_SAMPLES,
      `${label} with ${MIN_ACCURACY_SAMPLES}+ samples must be available.`,
    );
    assert(item.hit_rate === null, `${label}.hit_rate must be null without enough samples.`);
  } else {
    throw new PredictionContractError(`${label}.status is invalid.`);
  }
  return item;
}

export function assertValidAccuracy(accuracy) {
  if (!isRecord(accuracy)) {
    throw new PredictionContractError("accuracy must be an object.");
  }
  if (accuracy.status === "unavailable") {
    return requireExactObject(accuracy, ["status"], "accuracy", PredictionContractError);
  }

  const document = requireExactObject(
    accuracy,
    ["status", "window_days", "measured_through", "assets"],
    "accuracy",
    PredictionContractError,
  );
  assert(document.status === "available", "accuracy.status is invalid.");
  assert(
    document.window_days === ACCURACY_WINDOW_DAYS,
    `accuracy.window_days must be ${ACCURACY_WINDOW_DAYS}.`,
  );
  parseMexicoCityTimestamp(document.measured_through, "accuracy.measured_through", PredictionContractError);
  requireExactObject(document.assets, ["btc", "eth"], "accuracy.assets", PredictionContractError);
  validateAccuracyAsset(document.assets.btc, "accuracy.assets.btc");
  validateAccuracyAsset(document.assets.eth, "accuracy.assets.eth");
  return accuracy;
}

export function isValidAccuracy(accuracy) {
  try {
    assertValidAccuracy(accuracy);
    return true;
  } catch {
    return false;
  }
}

export function unavailableAccuracy() {
  return { status: "unavailable" };
}
