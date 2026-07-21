// Shared, dependency-free validation helpers for the data contracts. Kept
// small and generic on purpose: a single home for the primitives every
// contract needs, so new contracts do not re-invent (and quietly drift on)
// object-shape and timestamp checks.

const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/;
const OFFSET_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?[+-]\d{2}:\d{2}$/;

export { ISO_TIMESTAMP_PATTERN, OFFSET_TIMESTAMP_PATTERN };

export function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

export function isPositiveNumber(value) {
  return isFiniteNumber(value) && value > 0;
}

// A percentage rounded to one decimal, in [0, 100]. Used for hit rates and
// confidence so a stored value can never silently carry hidden precision.
export function isOneDecimalPercent(value) {
  return (
    isFiniteNumber(value) &&
    value >= 0 &&
    value <= 100 &&
    Number(value.toFixed(1)) === value
  );
}

// Rejects missing AND unknown keys: unknown fields that could change meaning
// must fail closed rather than be ignored.
export function requireExactObject(value, fields, label, ErrorClass = TypeError) {
  if (!isRecord(value)) {
    throw new ErrorClass(`${label} must be an object.`);
  }
  const actual = Object.keys(value);
  const missing = fields.filter((field) => !Object.hasOwn(value, field));
  const unknown = actual.filter((field) => !fields.includes(field));
  if (missing.length > 0 || unknown.length > 0) {
    throw new ErrorClass(`${label} fields are invalid.`);
  }
  return value;
}

export function parseTimestamp(value, label, pattern = ISO_TIMESTAMP_PATTERN, ErrorClass = TypeError) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new ErrorClass(`${label} must be an ISO-8601 timestamp with an explicit offset.`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new ErrorClass(`${label} must be a valid timestamp.`);
  }
  return milliseconds;
}

export function mexicoCityOffset(milliseconds) {
  const timeZoneName = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Mexico_City",
    timeZoneName: "longOffset",
  })
    .formatToParts(new Date(milliseconds))
    .find(({ type }) => type === "timeZoneName")?.value;
  return timeZoneName?.replace("GMT", "") || "+00:00";
}

export function parseMexicoCityTimestamp(value, label, ErrorClass = TypeError) {
  const milliseconds = parseTimestamp(value, label, OFFSET_TIMESTAMP_PATTERN, ErrorClass);
  if (!value.endsWith(mexicoCityOffset(milliseconds))) {
    throw new ErrorClass(`${label} offset does not match America/Mexico_City.`);
  }
  return milliseconds;
}
