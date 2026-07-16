import { ASSETS } from "./coingecko.mjs";

export const SCHEMA_VERSION = "1.0";
export const TIMEZONE = "America/Mexico_City";
export const CURRENCY = "usd";
export const SEED_GENERATED_AT = "2026-07-15T00:00:00-06:00";

const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/;
const OFFSET_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?[+-]\d{2}:\d{2}$/;

export class ContractValidationError extends TypeError {}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPositiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isIsoTimestamp(value, pattern = ISO_TIMESTAMP_PATTERN) {
  return (
    typeof value === "string" &&
    pattern.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

export function formatMexicoCityTimestamp(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);

  if (!Number.isFinite(date.getTime())) {
    throw new RangeError("A valid date is required.");
  }

  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      timeZoneName: "longOffset",
    })
      .formatToParts(date)
      .filter(({ type }) => type !== "literal")
      .map(({ type, value: partValue }) => [type, partValue]),
  );

  const offset = parts.timeZoneName.replace("GMT", "") || "+00:00";
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;
}

function validateGeneratedAt(value) {
  if (!isIsoTimestamp(value, OFFSET_TIMESTAMP_PATTERN)) {
    throw new ContractValidationError(
      "generated_at must be an ISO-8601 timestamp with an offset.",
    );
  }

  const expectedOffset = formatMexicoCityTimestamp(new Date(value)).slice(-6);
  if (!value.endsWith(expectedOffset)) {
    throw new ContractValidationError(
      "generated_at offset does not match America/Mexico_City.",
    );
  }
}

export function assertValidSnapshot(snapshot) {
  if (!isRecord(snapshot)) {
    throw new ContractValidationError("Snapshot must be an object.");
  }

  if (snapshot.schema_version !== SCHEMA_VERSION) {
    throw new ContractValidationError("Unsupported snapshot schema_version.");
  }

  validateGeneratedAt(snapshot.generated_at);

  if (snapshot.timezone !== TIMEZONE || snapshot.currency !== CURRENCY) {
    throw new ContractValidationError("Snapshot timezone or currency is invalid.");
  }

  if (typeof snapshot.stale !== "boolean" || !isRecord(snapshot.assets)) {
    throw new ContractValidationError("Snapshot stale or assets field is invalid.");
  }

  for (const [asset, metadata] of Object.entries(ASSETS)) {
    const item = snapshot.assets[asset];

    if (
      !isRecord(item) ||
      item.id !== metadata.id ||
      item.symbol !== metadata.symbol ||
      item.name !== metadata.name
    ) {
      throw new ContractValidationError(`Snapshot metadata is invalid for ${asset}.`);
    }

    if (item.price === null) {
      if (!snapshot.stale || item.source_updated_at !== null) {
        throw new ContractValidationError(
          `Null price is only valid in a stale seed for ${asset}.`,
        );
      }
    } else if (
      !isPositiveNumber(item.price) ||
      !isIsoTimestamp(item.source_updated_at)
    ) {
      throw new ContractValidationError(`Snapshot market data is invalid for ${asset}.`);
    }
  }

  return snapshot;
}

export const validateSnapshot = assertValidSnapshot;

export function isValidSnapshot(snapshot) {
  try {
    assertValidSnapshot(snapshot);
    return true;
  } catch {
    return false;
  }
}

export function createSeedSnapshot() {
  return {
    schema_version: SCHEMA_VERSION,
    generated_at: SEED_GENERATED_AT,
    timezone: TIMEZONE,
    currency: CURRENCY,
    stale: true,
    assets: Object.fromEntries(
      Object.entries(ASSETS).map(([asset, metadata]) => [
        asset,
        {
          ...metadata,
          price: null,
          source_updated_at: null,
        },
      ]),
    ),
  };
}

export function createFreshSnapshot(prices, generatedAt = new Date()) {
  if (!isRecord(prices)) {
    throw new ContractValidationError("Prices must be an object.");
  }

  const snapshot = {
    schema_version: SCHEMA_VERSION,
    generated_at: formatMexicoCityTimestamp(generatedAt),
    timezone: TIMEZONE,
    currency: CURRENCY,
    stale: false,
    assets: Object.fromEntries(
      Object.entries(ASSETS).map(([asset, metadata]) => {
        const price = prices[asset];

        return [
          asset,
          {
            ...metadata,
            price: price?.price,
            source_updated_at: price?.sourceUpdatedAt,
          },
        ];
      }),
    ),
  };

  assertValidSnapshot(snapshot);
  return snapshot;
}

export function createStaleSnapshot(previousSnapshot) {
  assertValidSnapshot(previousSnapshot);

  const snapshot = clone(previousSnapshot);
  snapshot.stale = true;

  assertValidSnapshot(snapshot);
  return snapshot;
}

export function createHistoryDocument({ asset, points, generatedAt = new Date() }) {
  const metadata = ASSETS[asset];

  if (!metadata || !Array.isArray(points) || points.length === 0) {
    throw new ContractValidationError("History asset or points are invalid.");
  }

  const normalizedPoints = points.map((point) => {
    if (
      !isRecord(point) ||
      !isIsoTimestamp(point.timestamp) ||
      !isPositiveNumber(point.price)
    ) {
      throw new ContractValidationError(`History contains an invalid ${asset} point.`);
    }

    return { timestamp: point.timestamp, price: point.price };
  });

  normalizedPoints.sort((left, right) =>
    left.timestamp.localeCompare(right.timestamp),
  );

  return {
    schema_version: SCHEMA_VERSION,
    asset,
    coin_id: metadata.id,
    currency: CURRENCY,
    generated_at: formatMexicoCityTimestamp(generatedAt),
    points: normalizedPoints,
  };
}
