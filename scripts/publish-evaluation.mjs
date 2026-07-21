import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getStore } from '@netlify/blobs';

import {
  ACCURACY_KEY,
  HEALTH_KEY,
  LOG_CURRENT_KEY,
  PREDICTIONS_STORE,
  assertValidAccuracy,
  assertValidPredictionRecord,
} from '../netlify/lib/prediction-contract.mjs';

export class EvaluationPublicationError extends Error {}

export function createPredictionsStore({
  siteID = process.env.NETLIFY_SITE_ID,
  token = process.env.NETLIFY_AUTH_TOKEN,
  getStoreFn = getStore,
} = {}) {
  if (!siteID || !token) {
    throw new EvaluationPublicationError(
      'NETLIFY_SITE_ID and NETLIFY_AUTH_TOKEN are required',
    );
  }
  return getStoreFn({ name: PREDICTIONS_STORE, siteID, token });
}

// Downloads the current predictions log to a local file for evaluate.py. A
// missing blob yields an empty array so the first-ever run is not an error.
export async function downloadLog({ store, outPath }) {
  const raw = await store.get(LOG_CURRENT_KEY, { consistency: 'strong', type: 'json' });
  const log = Array.isArray(raw) ? raw : [];
  await writeFile(outPath, JSON.stringify(log), 'utf8');
  return log.length;
}

function validateResolvedLog(log) {
  if (!Array.isArray(log)) {
    throw new EvaluationPublicationError('resolved log must be a JSON array');
  }
  const ids = new Set();
  for (const record of log) {
    try {
      assertValidPredictionRecord(record);
    } catch (error) {
      throw new EvaluationPublicationError(`resolved log has an invalid record: ${error.message}`);
    }
    if (ids.has(record.id)) {
      throw new EvaluationPublicationError(`resolved log has a duplicate id: ${record.id}`);
    }
    ids.add(record.id);
  }
  return log;
}

function readJson(text, field) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new EvaluationPublicationError(`${field} is not valid JSON: ${error.message}`);
  }
}

// Publishes the evaluation outputs. Accuracy is validated against the public
// contract and the log against the record contract before any write, so a
// malformed evaluation never overwrites good blobs.
export async function publishEvaluation({ store, logPath, accuracyPath, healthPath, readFileFn = readFile }) {
  const log = validateResolvedLog(readJson(await readFileFn(logPath, 'utf8'), 'log'));
  const accuracy = assertValidAccuracy(readJson(await readFileFn(accuracyPath, 'utf8'), 'accuracy'));
  const healthText = await readFileFn(healthPath, 'utf8');
  const health = readJson(healthText, 'health'); // shape owned by evaluate.py; stored verbatim

  await store.setJSON(LOG_CURRENT_KEY, log);
  await store.setJSON(ACCURACY_KEY, accuracy);
  await store.setJSON(HEALTH_KEY, health);
  return { resolved: log.length, accuracyStatus: accuracy.status };
}

export async function main(argv = process.argv.slice(2)) {
  const [mode, ...rest] = argv;
  const store = createPredictionsStore();

  if (mode === 'fetch') {
    const [outPath] = rest;
    if (!outPath) throw new EvaluationPublicationError('fetch requires an output path');
    const count = await downloadLog({ store, outPath });
    console.log(`fetched ${count} predictions to ${outPath}`);
    return;
  }
  if (mode === 'publish') {
    const [logPath, accuracyPath, healthPath] = rest;
    if (!logPath || !accuracyPath || !healthPath) {
      throw new EvaluationPublicationError('publish requires log, accuracy and health paths');
    }
    const result = await publishEvaluation({ store, logPath, accuracyPath, healthPath });
    console.log(`published evaluation: ${result.resolved} predictions, accuracy ${result.accuracyStatus}`);
    return;
  }
  throw new EvaluationPublicationError("mode must be 'fetch' or 'publish'");
}

export function cliErrorMessage(error) {
  if (error instanceof EvaluationPublicationError) {
    return `Evaluation step failed: ${error.message}`;
  }
  return 'Evaluation step failed due to an external error.';
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  main().catch((error) => {
    console.error(cliErrorMessage(error));
    process.exitCode = 1;
  });
}
