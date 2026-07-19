import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getStore } from '@netlify/blobs';
import {
  ForecastContractError,
  LATEST_FORECAST_KEY,
  MODEL_ARTIFACTS_STORE,
  PREVIOUS_FORECAST_KEY,
  assertValidForecastArtifact,
} from '../netlify/lib/forecast-contract.mjs';

export {
  LATEST_FORECAST_KEY,
  MODEL_ARTIFACTS_STORE,
  PREVIOUS_FORECAST_KEY,
};


export class ForecastPublicationError extends Error {}

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

  try {
    assertValidForecastArtifact(artifact);
  } catch (error) {
    if (error instanceof ForecastContractError) {
      throw new ForecastPublicationError(error.message);
    }
    throw error;
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
