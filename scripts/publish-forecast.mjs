import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getStore } from '@netlify/blobs';


export const MODEL_ARTIFACTS_STORE = 'model-artifacts';
export const LATEST_FORECAST_KEY = 'forecast/latest.json';
export const PREVIOUS_FORECAST_KEY = 'forecast/previous.json';

const ARTIFACT_VERSION_PATTERN =
  /^(\d{8}T\d{6}Z)-([0-9a-f]{7,40})-(gh[0-9]+-[0-9]+|local[0-9a-f]{32})$/;
const OFFSET_TIMESTAMP_PATTERN = /(?:Z|[+-][0-9]{2}:[0-9]{2})$/;
const MAX_SOURCE_AGE_MS = 12 * 60 * 60 * 1000;
const MAX_REFERENCE_SKEW_MS = 60 * 60 * 1000;


export class ForecastPublicationError extends Error {}


function requireObject(value, field) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ForecastPublicationError(`${field} must be an object`);
  }
  return value;
}


function requireExactObject(value, expectedFields, field) {
  const object = requireObject(value, field);
  const actualFields = Object.keys(object);
  const missing = expectedFields.filter((key) => !Object.hasOwn(object, key));
  const unknown = actualFields.filter((key) => !expectedFields.includes(key));
  if (missing.length > 0) {
    throw new ForecastPublicationError(`${field} is missing fields: ${missing.join(', ')}`);
  }
  if (unknown.length > 0) {
    throw new ForecastPublicationError(`${field} has unsupported fields: ${unknown.join(', ')}`);
  }
  return object;
}


function parseTimestamp(value, field) {
  if (typeof value !== 'string' || !OFFSET_TIMESTAMP_PATTERN.test(value)) {
    throw new ForecastPublicationError(`${field} must be ISO-8601 with an explicit offset`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new ForecastPublicationError(`${field} must be a valid timestamp`);
  }
  return milliseconds;
}


function compactUtcTimestamp(milliseconds) {
  return new Date(milliseconds)
    .toISOString()
    .replaceAll('-', '')
    .replaceAll(':', '')
    .replace('.000', '');
}


function directionFor(terminalReturn) {
  if (terminalReturn >= 0.005) return 'up';
  if (terminalReturn <= -0.005) return 'down';
  return 'flat';
}


function validateConfidence(value, field) {
  const confidence = requireExactObject(
    value,
    ['value', 'status', 'method', 'sample_size'],
    field,
  );
  const { method, sample_size: sampleSize, status } = confidence;
  if (method !== 'rolling_origin_48h_residuals') {
    throw new ForecastPublicationError(`${field}.method is unsupported`);
  }
  if (!Number.isInteger(sampleSize) || sampleSize < 0) {
    throw new ForecastPublicationError(`${field}.sample_size must be a non-negative integer`);
  }
  if (sampleSize < 20) {
    if (status !== 'insufficient_validation' || confidence.value !== null) {
      throw new ForecastPublicationError(`${field} is inconsistent with its sample size`);
    }
    return;
  }
  if (
    status !== 'available'
    || !Number.isFinite(confidence.value)
    || confidence.value < 0
    || confidence.value > 100
    || Number(confidence.value.toFixed(1)) !== confidence.value
  ) {
    throw new ForecastPublicationError(`${field} is inconsistent with its sample size`);
  }
}


function validateAsset(value, asset, generatedAt, canonicalIdentity = null) {
  const document = requireExactObject(
    value,
    ['id', 'symbol', 'reference', 'forecast', 'summary'],
    `assets.${asset}`,
  );
  if (
    typeof document.id !== 'string'
    || document.id.length === 0
    || typeof document.symbol !== 'string'
    || document.symbol.length === 0
  ) {
    throw new ForecastPublicationError(`assets.${asset} identity is invalid`);
  }
  if (
    canonicalIdentity
    && (document.id !== canonicalIdentity.id || document.symbol !== canonicalIdentity.symbol)
  ) {
    throw new ForecastPublicationError(`assets.${asset} identity is not canonical`);
  }
  const reference = requireExactObject(
    document.reference,
    ['price', 'observed_at'],
    `assets.${asset}.reference`,
  );
  if (!Number.isFinite(reference.price) || reference.price <= 0) {
    throw new ForecastPublicationError(`assets.${asset}.reference.price must be positive`);
  }
  const observedAt = parseTimestamp(
    reference.observed_at,
    `assets.${asset}.reference.observed_at`,
  );
  if (observedAt > generatedAt || generatedAt - observedAt > MAX_SOURCE_AGE_MS) {
    throw new ForecastPublicationError(`assets.${asset}.reference.observed_at is not fresh`);
  }

  if (!Array.isArray(document.forecast) || document.forecast.length !== 48) {
    throw new ForecastPublicationError(`assets.${asset}.forecast must contain 48 points`);
  }
  document.forecast.forEach((point, index) => {
    const forecastPoint = requireExactObject(
      point,
      ['offset_hours', 'return_factor'],
      `assets.${asset}.forecast[${index}]`,
    );
    if (
      forecastPoint.offset_hours !== index + 1
      || !Number.isFinite(forecastPoint.return_factor)
      || forecastPoint.return_factor <= 0
    ) {
      throw new ForecastPublicationError(`assets.${asset}.forecast[${index}] is invalid`);
    }
  });

  const summary = requireExactObject(
    document.summary,
    ['terminal_return', 'direction', 'confidence'],
    `assets.${asset}.summary`,
  );
  const terminalReturn = document.forecast[47].return_factor - 1;
  if (
    !Number.isFinite(summary.terminal_return)
    || Math.abs(summary.terminal_return - terminalReturn) > 1e-12
    || summary.direction !== directionFor(terminalReturn)
  ) {
    throw new ForecastPublicationError(`assets.${asset}.summary is inconsistent`);
  }
  validateConfidence(summary.confidence, `assets.${asset}.summary.confidence`);
  return observedAt;
}


export function validateForecastPayload(payload) {
  if (typeof payload !== 'string' || payload.length === 0) {
    throw new ForecastPublicationError('forecast payload must be non-empty UTF-8 text');
  }

  let artifact;
  try {
    artifact = JSON.parse(payload);
  } catch {
    throw new ForecastPublicationError('forecast payload is not valid JSON');
  }
  requireExactObject(
    artifact,
    [
      'schema_version',
      'artifact_version',
      'artifact_type',
      'generated_at',
      'data_through',
      'valid_until',
      'expires_at',
      'timezone',
      'currency',
      'horizon_hours',
      'step_hours',
      'direction_policy',
      'producer',
      'assets',
    ],
    'artifact',
  );

  if (
    artifact.schema_version !== 'forecast-artifact/1.0'
    || artifact.artifact_type !== 'relative_hourly_forecast'
    || artifact.timezone !== 'America/Mexico_City'
    || artifact.currency !== 'usd'
    || artifact.horizon_hours !== 48
    || artifact.step_hours !== 1
  ) {
    throw new ForecastPublicationError('forecast artifact contract is unsupported');
  }
  const directionPolicy = requireExactObject(
    artifact.direction_policy,
    ['horizon_hours', 'flat_threshold_return'],
    'direction_policy',
  );
  if (
    directionPolicy.horizon_hours !== 48
    || directionPolicy.flat_threshold_return !== 0.005
  ) {
    throw new ForecastPublicationError('direction_policy is unsupported');
  }

  const versionMatch =
    typeof artifact.artifact_version === 'string'
      ? artifact.artifact_version.match(ARTIFACT_VERSION_PATTERN)
      : null;
  if (!versionMatch) {
    throw new ForecastPublicationError('artifact_version is invalid');
  }
  const producer = requireExactObject(
    artifact.producer,
    ['model_id', 'code_revision', 'run_id'],
    'producer',
  );
  if (
    typeof producer.model_id !== 'string'
    || producer.model_id.length === 0
    || producer.code_revision !== versionMatch[2]
    || producer.run_id !== versionMatch[3]
  ) {
    throw new ForecastPublicationError('artifact_version does not match producer identity');
  }

  const generatedAt = parseTimestamp(artifact.generated_at, 'generated_at');
  if (compactUtcTimestamp(generatedAt) !== versionMatch[1]) {
    throw new ForecastPublicationError('artifact_version does not match generated_at');
  }
  const dataThrough = parseTimestamp(artifact.data_through, 'data_through');
  const validUntil = parseTimestamp(artifact.valid_until, 'valid_until');
  const expiresAt = parseTimestamp(artifact.expires_at, 'expires_at');
  if (
    dataThrough > generatedAt
    || generatedAt - dataThrough > MAX_SOURCE_AGE_MS
    || validUntil !== generatedAt + 36 * 60 * 60 * 1000
    || expiresAt !== generatedAt + 72 * 60 * 60 * 1000
  ) {
    throw new ForecastPublicationError('forecast artifact timestamps are inconsistent');
  }

  const assets = requireObject(artifact.assets, 'assets');
  const referenceTimes = new Map(
    Object.entries(assets).map(([asset, value]) => [
      asset,
      validateAsset(
        value,
        asset,
        generatedAt,
        asset === 'btc'
          ? { id: 'bitcoin', symbol: 'BTC' }
          : asset === 'eth'
            ? { id: 'ethereum', symbol: 'ETH' }
            : null,
      ),
    ]),
  );
  if (!referenceTimes.has('btc') || !referenceTimes.has('eth')) {
    throw new ForecastPublicationError('assets must contain btc and eth');
  }
  const btcObservedAt = referenceTimes.get('btc');
  const ethObservedAt = referenceTimes.get('eth');
  if (Math.abs(btcObservedAt - ethObservedAt) > MAX_REFERENCE_SKEW_MS) {
    throw new ForecastPublicationError('BTC and ETH references differ by more than one hour');
  }
  return artifact;
}


export function versionKey(artifactVersion) {
  return `forecast/versions/${artifactVersion}.json`;
}


export async function publishForecast({ payload, store }) {
  const artifact = validateForecastPayload(payload);
  if (!store || typeof store.get !== 'function' || typeof store.set !== 'function') {
    throw new ForecastPublicationError('a compatible blob store is required');
  }

  const immutableKey = versionKey(artifact.artifact_version);
  const versionResult = await store.set(immutableKey, payload, { onlyIfNew: true });
  if (versionResult?.modified === false) {
    throw new ForecastPublicationError('artifact_version already exists');
  }
  const confirmedVersion = await store.get(immutableKey, {
    consistency: 'strong',
    type: 'text',
  });
  if (confirmedVersion !== payload) {
    throw new ForecastPublicationError('immutable artifact verification failed');
  }

  const previousLatest = await store.get(LATEST_FORECAST_KEY, {
    consistency: 'strong',
    type: 'text',
  });
  let previousSaved = false;
  if (previousLatest !== null) {
    let previousIsValid = false;
    try {
      validateForecastPayload(previousLatest);
      previousIsValid = true;
    } catch (error) {
      if (!(error instanceof ForecastPublicationError)) throw error;
    }
    if (previousIsValid) {
      await store.set(PREVIOUS_FORECAST_KEY, previousLatest);
      previousSaved = true;
    }
  }

  await store.set(LATEST_FORECAST_KEY, payload);
  return {
    artifactVersion: artifact.artifact_version,
    immutableKey,
    previousSaved,
  };
}


export function createArtifactStore({
  siteID = process.env.NETLIFY_SITE_ID,
  token = process.env.NETLIFY_AUTH_TOKEN,
  getStoreFn = getStore,
} = {}) {
  if (!siteID || !token) {
    throw new ForecastPublicationError(
      'NETLIFY_SITE_ID and NETLIFY_AUTH_TOKEN are required',
    );
  }
  return getStoreFn({
    name: MODEL_ARTIFACTS_STORE,
    siteID,
    token,
  });
}


export async function publishForecastFile({
  artifactPath,
  store,
  readFileFn = readFile,
}) {
  if (!artifactPath) {
    throw new ForecastPublicationError('artifact file path is required');
  }
  const payload = await readFileFn(artifactPath, 'utf8');
  return publishForecast({ payload, store });
}


export async function main(argv = process.argv.slice(2)) {
  const [artifactPath] = argv;
  const store = createArtifactStore();
  const result = await publishForecastFile({ artifactPath, store });
  console.log(`Published forecast artifact ${result.artifactVersion}.`);
}


export function cliErrorMessage(error) {
  if (error instanceof ForecastPublicationError) {
    return `Forecast publication failed: ${error.message}`;
  }
  return 'Forecast publication failed due to an external error.';
}


const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  main().catch((error) => {
    console.error(cliErrorMessage(error));
    process.exitCode = 1;
  });
}
