import { ASSETS } from "./coingecko.mjs";

export const FORECAST_SCHEMA_VERSION = "forecast-artifact/1.0";
export const FORECAST_ARTIFACT_TYPE = "relative_hourly_forecast";
export const MODEL_ARTIFACTS_STORE = "model-artifacts";
export const LATEST_FORECAST_KEY = "forecast/latest.json";
export const PREVIOUS_FORECAST_KEY = "forecast/previous.json";
export const FORECAST_HORIZON_HOURS = 48;
export const FORECAST_STEP_HOURS = 1;
export const FORECAST_FLAT_THRESHOLD = 0.005;
export const FORECAST_CONFIDENCE_METHOD = "rolling_origin_48h_residuals";

const ARTIFACT_VERSION_PATTERN =
  /^(\d{8}T\d{6}Z)-([0-9a-f]{7,40})-(gh[0-9]+-[0-9]+|local[0-9a-f]{32})$/;
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/;
const OFFSET_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?[+-]\d{2}:\d{2}$/;
const MAX_SOURCE_AGE_MS = 12 * 60 * 60 * 1_000;
const MAX_REFERENCE_SKEW_MS = 60 * 60 * 1_000;
const VALID_FOR_MS = 36 * 60 * 60 * 1_000;
const EXPIRES_AFTER_MS = 72 * 60 * 60 * 1_000;

const ARTIFACT_FIELDS = [
  "schema_version",
  "artifact_version",
  "artifact_type",
  "generated_at",
  "data_through",
  "valid_until",
  "expires_at",
  "timezone",
  "currency",
  "horizon_hours",
  "step_hours",
  "direction_policy",
  "producer",
  "assets",
];

export class ForecastContractError extends TypeError {}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isPositiveNumber(value) {
  return isFiniteNumber(value) && value > 0;
}

function requireExactObject(value, fields, label) {
  if (!isRecord(value)) {
    throw new ForecastContractError(`${label} must be an object.`);
  }

  const actual = Object.keys(value);
  const missing = fields.filter((field) => !Object.hasOwn(value, field));
  const unknown = actual.filter((field) => !fields.includes(field));

  if (missing.length > 0 || unknown.length > 0) {
    throw new ForecastContractError(`${label} fields are invalid.`);
  }

  return value;
}

function parseTimestamp(value, label, pattern = ISO_TIMESTAMP_PATTERN) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new ForecastContractError(
      `${label} must be an ISO-8601 timestamp with an explicit offset.`,
    );
  }

  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new ForecastContractError(`${label} must be a valid timestamp.`);
  }

  return milliseconds;
}

function mexicoCityOffset(milliseconds) {
  const timeZoneName = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Mexico_City",
    timeZoneName: "longOffset",
  })
    .formatToParts(new Date(milliseconds))
    .find(({ type }) => type === "timeZoneName")?.value;
  return timeZoneName?.replace("GMT", "") || "+00:00";
}

function parseMexicoCityTimestamp(value, label) {
  const milliseconds = parseTimestamp(value, label, OFFSET_TIMESTAMP_PATTERN);
  if (!value.endsWith(mexicoCityOffset(milliseconds))) {
    throw new ForecastContractError(
      `${label} offset does not match America/Mexico_City.`,
    );
  }
  return milliseconds;
}

function compactUtcTimestamp(milliseconds) {
  return new Date(milliseconds)
    .toISOString()
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replace(".000", "");
}

function directionFor(terminalReturn) {
  if (terminalReturn >= FORECAST_FLAT_THRESHOLD) return "up";
  if (terminalReturn <= -FORECAST_FLAT_THRESHOLD) return "down";
  return "flat";
}

function validateConfidence(value, label) {
  // `scenarios` is optional and additive; the shape stays exact otherwise so no
  // other unknown field can slip through.
  const fields = isRecord(value) && Object.hasOwn(value, "scenarios")
    ? ["value", "status", "method", "sample_size", "scenarios"]
    : ["value", "status", "method", "sample_size"];
  const confidence = requireExactObject(value, fields, label);

  if (
    confidence.method !== FORECAST_CONFIDENCE_METHOD ||
    !Number.isInteger(confidence.sample_size) ||
    confidence.sample_size < 0
  ) {
    throw new ForecastContractError(`${label} metadata is invalid.`);
  }

  if (Object.hasOwn(confidence, "scenarios")) {
    if (
      !Array.isArray(confidence.scenarios) ||
      confidence.scenarios.length !== confidence.sample_size ||
      !confidence.scenarios.every(isFiniteNumber)
    ) {
      throw new ForecastContractError(`${label}.scenarios is invalid.`);
    }
  }

  if (confidence.sample_size < 20) {
    if (
      confidence.status !== "insufficient_validation" ||
      confidence.value !== null
    ) {
      throw new ForecastContractError(`${label} status is inconsistent.`);
    }
    return confidence;
  }

  if (
    confidence.status !== "available" ||
    !isFiniteNumber(confidence.value) ||
    confidence.value < 0 ||
    confidence.value > 100 ||
    Number(confidence.value.toFixed(1)) !== confidence.value
  ) {
    throw new ForecastContractError(`${label} status is inconsistent.`);
  }

  return confidence;
}

// The measured hit rates: how often the published direction was right, next to
// the two baselines it has to beat to be worth anything.
function validateDirectionalValidation(value, label) {
  const block = requireExactObject(
    value,
    [
      "origins",
      "hit_rate_percent",
      "naive_hit_rate_percent",
      "momentum_hit_rate_percent",
      "sign_folds",
      "sign_hit_rate_percent",
      "mean_absolute_error_percent",
      "naive_mean_absolute_error_percent",
      "reliability",
    ],
    label,
  );

  if (!Number.isInteger(block.origins) || block.origins < 1) {
    throw new ForecastContractError(`${label}.origins must be a positive integer.`);
  }
  if (
    !Number.isInteger(block.sign_folds) ||
    block.sign_folds < 0 ||
    block.sign_folds > block.origins
  ) {
    throw new ForecastContractError(`${label}.sign_folds must fit inside origins.`);
  }

  for (const key of [
    "hit_rate_percent",
    "naive_hit_rate_percent",
    "momentum_hit_rate_percent",
    "sign_hit_rate_percent",
  ]) {
    const rate = block[key];
    // Only the signed rate may be null, and only when nothing was scored.
    if (rate === null) {
      if (key !== "sign_hit_rate_percent" || block.sign_folds !== 0) {
        throw new ForecastContractError(`${label}.${key} must be a percentage.`);
      }
      continue;
    }
    if (!isFiniteNumber(rate) || rate < 0 || rate > 100) {
      throw new ForecastContractError(`${label}.${key} must be a percentage.`);
    }
    if (Math.round(rate * 10) / 10 !== rate) {
      throw new ForecastContractError(`${label}.${key} must not exceed one decimal.`);
    }
  }

  for (const key of ["mean_absolute_error_percent", "naive_mean_absolute_error_percent"]) {
    const error = block[key];
    if (!isFiniteNumber(error) || error < 0) {
      throw new ForecastContractError(`${label}.${key} must be a non-negative number.`);
    }
    if (Math.round(error * 100) / 100 !== error) {
      throw new ForecastContractError(`${label}.${key} must not exceed two decimals.`);
    }
  }

  // Whether a bigger predicted move is actually more often right.
  const bands = ["small", "medium", "large"];
  if (!Array.isArray(block.reliability) || block.reliability.length !== bands.length) {
    throw new ForecastContractError(`${label}.reliability must list every band once.`);
  }
  let counted = 0;
  block.reliability.forEach((value_, index) => {
    const entry = requireExactObject(
      value_,
      ["band", "folds", "sign_folds", "sign_hit_rate_percent"],
      `${label}.reliability[${index}]`,
    );
    if (entry.band !== bands[index]) {
      throw new ForecastContractError(
        `${label}.reliability[${index}].band must be "${bands[index]}".`,
      );
    }
    if (!Number.isInteger(entry.folds) || entry.folds < 0) {
      throw new ForecastContractError(`${label}.reliability[${index}].folds must be an integer.`);
    }
    if (
      !Number.isInteger(entry.sign_folds) ||
      entry.sign_folds < 0 ||
      entry.sign_folds > entry.folds
    ) {
      throw new ForecastContractError(
        `${label}.reliability[${index}].sign_folds must fit inside folds.`,
      );
    }
    const rate = entry.sign_hit_rate_percent;
    if (rate === null) {
      if (entry.sign_folds !== 0) {
        throw new ForecastContractError(
          `${label}.reliability[${index}].sign_hit_rate_percent must be a percentage.`,
        );
      }
    } else if (!isFiniteNumber(rate) || rate < 0 || rate > 100 || Math.round(rate * 10) / 10 !== rate) {
      throw new ForecastContractError(
        `${label}.reliability[${index}].sign_hit_rate_percent must be a percentage.`,
      );
    }
    counted += entry.folds;
  });
  if (counted !== block.origins) {
    throw new ForecastContractError(`${label}.reliability must account for every origin.`);
  }
}

function validateArtifactAsset(value, asset, generatedAt) {
  const item = requireExactObject(
    value,
    ["id", "symbol", "reference", "forecast", "summary"],
    `assets.${asset}`,
  );
  const canonical = ASSETS[asset];

  if (
    typeof item.id !== "string" ||
    item.id.length === 0 ||
    typeof item.symbol !== "string" ||
    item.symbol.length === 0 ||
    (canonical && (item.id !== canonical.id || item.symbol !== canonical.symbol))
  ) {
    throw new ForecastContractError(`assets.${asset} identity is invalid.`);
  }

  const reference = requireExactObject(
    item.reference,
    ["price", "observed_at"],
    `assets.${asset}.reference`,
  );
  const observedAt = parseTimestamp(
    reference.observed_at,
    `assets.${asset}.reference.observed_at`,
  );
  if (
    !isPositiveNumber(reference.price) ||
    observedAt > generatedAt ||
    generatedAt - observedAt > MAX_SOURCE_AGE_MS
  ) {
    throw new ForecastContractError(`assets.${asset}.reference is invalid.`);
  }

  if (!Array.isArray(item.forecast) || item.forecast.length !== 48) {
    throw new ForecastContractError(
      `assets.${asset}.forecast must contain exactly 48 points.`,
    );
  }

  item.forecast.forEach((valueAtOffset, index) => {
    const point = requireExactObject(
      valueAtOffset,
      ["offset_hours", "return_factor"],
      `assets.${asset}.forecast[${index}]`,
    );
    if (
      point.offset_hours !== index + 1 ||
      !isPositiveNumber(point.return_factor)
    ) {
      throw new ForecastContractError(
        `assets.${asset}.forecast[${index}] is invalid.`,
      );
    }
  });

  // validation is optional and additive: artifacts published before the
  // measured hit rates existed stay valid.
  const summaryFields = ["terminal_return", "direction", "confidence"];
  const summary = requireExactObject(
    item.summary,
    isRecord(item.summary) && Object.hasOwn(item.summary, "validation")
      ? [...summaryFields, "validation"]
      : summaryFields,
    `assets.${asset}.summary`,
  );
  const expectedTerminal = item.forecast[47].return_factor - 1;
  if (
    !isFiniteNumber(summary.terminal_return) ||
    Math.abs(summary.terminal_return - expectedTerminal) > 1e-12 ||
    summary.direction !== directionFor(expectedTerminal)
  ) {
    throw new ForecastContractError(`assets.${asset}.summary is inconsistent.`);
  }
  validateConfidence(summary.confidence, `assets.${asset}.summary.confidence`);
  if (Object.hasOwn(summary, "validation")) {
    validateDirectionalValidation(
      summary.validation,
      `assets.${asset}.summary.validation`,
    );
  }

  return observedAt;
}

export function assertValidForecastArtifact(artifact) {
  const document = requireExactObject(artifact, ARTIFACT_FIELDS, "artifact");

  if (
    document.schema_version !== FORECAST_SCHEMA_VERSION ||
    document.artifact_type !== FORECAST_ARTIFACT_TYPE ||
    document.timezone !== "America/Mexico_City" ||
    document.currency !== "usd" ||
    document.horizon_hours !== FORECAST_HORIZON_HOURS ||
    document.step_hours !== FORECAST_STEP_HOURS
  ) {
    throw new ForecastContractError("Forecast artifact contract is unsupported.");
  }

  const versionMatch =
    typeof document.artifact_version === "string"
      ? document.artifact_version.match(ARTIFACT_VERSION_PATTERN)
      : null;
  if (!versionMatch) {
    throw new ForecastContractError("artifact_version is invalid.");
  }

  const policy = requireExactObject(
    document.direction_policy,
    ["horizon_hours", "flat_threshold_return"],
    "direction_policy",
  );
  if (
    policy.horizon_hours !== FORECAST_HORIZON_HOURS ||
    policy.flat_threshold_return !== FORECAST_FLAT_THRESHOLD
  ) {
    throw new ForecastContractError("direction_policy is unsupported.");
  }

  const producer = requireExactObject(
    document.producer,
    ["model_id", "code_revision", "run_id"],
    "producer",
  );
  if (
    typeof producer.model_id !== "string" ||
    producer.model_id.length === 0 ||
    producer.code_revision !== versionMatch[2] ||
    producer.run_id !== versionMatch[3]
  ) {
    throw new ForecastContractError(
      "artifact_version does not match producer identity.",
    );
  }

  const generatedAt = parseTimestamp(document.generated_at, "generated_at");
  const dataThrough = parseTimestamp(document.data_through, "data_through");
  const validUntil = parseTimestamp(document.valid_until, "valid_until");
  const expiresAt = parseTimestamp(document.expires_at, "expires_at");
  if (
    compactUtcTimestamp(generatedAt) !== versionMatch[1] ||
    dataThrough > generatedAt ||
    generatedAt - dataThrough > MAX_SOURCE_AGE_MS ||
    validUntil !== generatedAt + VALID_FOR_MS ||
    expiresAt !== generatedAt + EXPIRES_AFTER_MS
  ) {
    throw new ForecastContractError("Forecast artifact timestamps are inconsistent.");
  }

  if (!isRecord(document.assets)) {
    throw new ForecastContractError("assets must be an object.");
  }
  const assetEntries = Object.entries(document.assets);
  const assetKeys = Object.keys(ASSETS);
  const missing = assetKeys.filter((asset) => !Object.hasOwn(document.assets, asset));
  if (missing.length > 0 || assetEntries.some(([asset]) => asset.length === 0)) {
    throw new ForecastContractError(`assets must contain: ${assetKeys.join(", ")}.`);
  }

  const referenceTimes = new Map(
    assetEntries.map(([asset, value]) => [
      asset,
      validateArtifactAsset(value, asset, generatedAt),
    ]),
  );
  // Every asset must have been observed within the same hour: the widest gap
  // across all of them stays under the skew budget.
  const refValues = assetKeys.map((asset) => referenceTimes.get(asset));
  if (Math.max(...refValues) - Math.min(...refValues) > MAX_REFERENCE_SKEW_MS) {
    throw new ForecastContractError(
      "asset references differ by more than one hour.",
    );
  }

  return artifact;
}

export function isValidForecastArtifact(artifact) {
  try {
    assertValidForecastArtifact(artifact);
    return true;
  } catch {
    return false;
  }
}

export function forecastArtifactStatus(artifact, now = new Date()) {
  assertValidForecastArtifact(artifact);
  const nowMilliseconds = new Date(now).getTime();
  if (!Number.isFinite(nowMilliseconds)) {
    throw new ForecastContractError("A valid forecast clock is required.");
  }

  if (nowMilliseconds <= Date.parse(artifact.valid_until)) return "fresh";
  if (nowMilliseconds <= Date.parse(artifact.expires_at)) return "stale";
  return "unavailable";
}

export async function readUsableForecastArtifact(store, now = new Date()) {
  if (!store || typeof store.get !== "function") return null;

  for (const key of [LATEST_FORECAST_KEY, PREVIOUS_FORECAST_KEY]) {
    let rawArtifact;
    try {
      rawArtifact = await store.get(key, {
        consistency: "strong",
        type: "text",
      });
    } catch {
      // A storage outage is different from a corrupt document: if the read
      // itself is unavailable, a second key in the same store is not a safe
      // recovery path.
      return null;
    }

    if (rawArtifact === null || rawArtifact === undefined) continue;

    let artifact;
    try {
      artifact = typeof rawArtifact === "string"
        ? JSON.parse(rawArtifact)
        : rawArtifact;
    } catch {
      // Malformed latest bytes must not prevent recovery from previous.
      continue;
    }

    try {
      assertValidForecastArtifact(artifact);
    } catch {
      continue;
    }

    const status = forecastArtifactStatus(artifact, now);
    if (status !== "unavailable") {
      return { artifact, status, key };
    }
  }

  return null;
}

export function unavailableForecast() {
  return { status: "unavailable" };
}

function validatePublicForecastAsset(value, asset, anchoredAt) {
  const publicFields = ["direction", "terminal_return", "confidence", "points"];
  const item = requireExactObject(
    value,
    isRecord(value) && Object.hasOwn(value, "validation")
      ? [...publicFields, "validation"]
      : publicFields,
    `forecast.assets.${asset}`,
  );
  if (Object.hasOwn(item, "validation")) {
    validateDirectionalValidation(item.validation, `forecast.assets.${asset}.validation`);
  }
  if (
    !["up", "down", "flat"].includes(item.direction) ||
    !isFiniteNumber(item.terminal_return) ||
    item.terminal_return <= -1 ||
    item.direction !== directionFor(item.terminal_return)
  ) {
    throw new ForecastContractError(`forecast.assets.${asset} summary is invalid.`);
  }
  validateConfidence(item.confidence, `forecast.assets.${asset}.confidence`);

  if (!Array.isArray(item.points) || item.points.length !== 48) {
    throw new ForecastContractError(
      `forecast.assets.${asset}.points must contain exactly 48 points.`,
    );
  }
  item.points.forEach((valueAtOffset, index) => {
    const point = requireExactObject(
      valueAtOffset,
      ["offset_hours", "target_at", "price"],
      `forecast.assets.${asset}.points[${index}]`,
    );
    const targetAt = parseMexicoCityTimestamp(
      point.target_at,
      `forecast.assets.${asset}.points[${index}].target_at`,
    );
    if (
      point.offset_hours !== index + 1 ||
      targetAt !== anchoredAt + (index + 1) * 60 * 60 * 1_000 ||
      !isPositiveNumber(point.price)
    ) {
      throw new ForecastContractError(
        `forecast.assets.${asset}.points[${index}] is invalid.`,
      );
    }
  });
}

export function assertValidPublicForecast(forecast) {
  if (!isRecord(forecast)) {
    throw new ForecastContractError("forecast must be an object.");
  }
  if (forecast.status === "unavailable") {
    requireExactObject(forecast, ["status"], "forecast");
    return forecast;
  }

  const document = requireExactObject(
    forecast,
    [
      "status",
      "artifact_version",
      "anchored_at",
      "valid_until",
      "expires_at",
      "assets",
    ],
    "forecast",
  );
  if (
    !["fresh", "stale"].includes(document.status) ||
    typeof document.artifact_version !== "string" ||
    !ARTIFACT_VERSION_PATTERN.test(document.artifact_version)
  ) {
    throw new ForecastContractError("forecast status or version is invalid.");
  }

  const anchoredAt = parseMexicoCityTimestamp(
    document.anchored_at,
    "forecast.anchored_at",
  );
  const validUntil = parseMexicoCityTimestamp(
    document.valid_until,
    "forecast.valid_until",
  );
  const expiresAt = parseMexicoCityTimestamp(
    document.expires_at,
    "forecast.expires_at",
  );
  if (
    expiresAt - validUntil !== VALID_FOR_MS ||
    anchoredAt > expiresAt
  ) {
    throw new ForecastContractError("forecast timestamps are inconsistent.");
  }

  const assetKeys = Object.keys(ASSETS);
  requireExactObject(document.assets, assetKeys, "forecast.assets");
  for (const asset of assetKeys) {
    validatePublicForecastAsset(document.assets[asset], asset, anchoredAt);
  }
  return forecast;
}

export function anchorForecast(artifact, status, marketSnapshot, formatTimestamp) {
  assertValidForecastArtifact(artifact);
  if (!["fresh", "stale"].includes(status)) {
    throw new ForecastContractError("A usable artifact status is required.");
  }
  if (typeof formatTimestamp !== "function") {
    throw new ForecastContractError("A timestamp formatter is required.");
  }

  const anchoredAt = Date.parse(marketSnapshot?.generated_at);
  if (!Number.isFinite(anchoredAt) || marketSnapshot?.stale !== false) {
    throw new ForecastContractError("A fresh market snapshot is required.");
  }

  const forecast = {
    status,
    artifact_version: artifact.artifact_version,
    anchored_at: marketSnapshot.generated_at,
    valid_until: formatTimestamp(new Date(artifact.valid_until)),
    expires_at: formatTimestamp(new Date(artifact.expires_at)),
    assets: Object.fromEntries(
      Object.keys(ASSETS).map((asset) => {
        const livePrice = marketSnapshot.assets?.[asset]?.price;
        const modelAsset = artifact.assets[asset];
        if (!isPositiveNumber(livePrice) || !modelAsset) {
          throw new ForecastContractError(`Fresh ${asset} market data is required.`);
        }

        return [
          asset,
          {
            direction: modelAsset.summary.direction,
            terminal_return: modelAsset.summary.terminal_return,
            confidence: clone(modelAsset.summary.confidence),
            // Carried through so the page can say whether the model beat doing
            // nothing, which is the only thing that makes a hit rate mean
            // something. Absent on artifacts published before it existed.
            ...(Object.hasOwn(modelAsset.summary, "validation")
              ? { validation: clone(modelAsset.summary.validation) }
              : {}),
            points: modelAsset.forecast.map((point) => ({
              offset_hours: point.offset_hours,
              target_at: formatTimestamp(
                new Date(anchoredAt + point.offset_hours * 60 * 60 * 1_000),
              ),
              price: livePrice * point.return_factor,
            })),
          },
        ];
      }),
    ),
  };

  assertValidPublicForecast(forecast);
  return forecast;
}

export function agePublicForecast(forecast, now = new Date()) {
  if (forecast === undefined) return unavailableForecast();
  assertValidPublicForecast(forecast);
  if (forecast.status === "unavailable") return unavailableForecast();

  const nowMilliseconds = new Date(now).getTime();
  if (!Number.isFinite(nowMilliseconds)) {
    throw new ForecastContractError("A valid forecast clock is required.");
  }
  if (nowMilliseconds > Date.parse(forecast.expires_at)) {
    return unavailableForecast();
  }

  const aged = clone(forecast);
  if (nowMilliseconds > Date.parse(forecast.valid_until)) {
    aged.status = "stale";
  }
  assertValidPublicForecast(aged);
  return aged;
}
