import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getStore } from '@netlify/blobs';

import { updateJsonWithRetry } from '../netlify/lib/blob-log.mjs';
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
export async function downloadLog({ store, outPath, writeFileFn = writeFile }) {
  const raw = await store.get(LOG_CURRENT_KEY, { consistency: 'strong', type: 'json' });
  const log = Array.isArray(raw) ? raw : [];
  await writeFileFn(outPath, JSON.stringify(log), 'utf8');
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
//
// The log is written under compare-and-swap and merged with the live blob: the
// resolved log is authoritative for every id evaluate saw (including prunes),
// and any prediction predict.mjs appended *after* the baseline was fetched is
// carried forward, so the daily republish cannot drop a concurrent append.
export async function publishEvaluation({
  store,
  logPath,
  accuracyPath,
  healthPath,
  baselinePath,
  readFileFn = readFile,
}) {
  const resolved = validateResolvedLog(readJson(await readFileFn(logPath, 'utf8'), 'log'));
  const accuracy = assertValidAccuracy(readJson(await readFileFn(accuracyPath, 'utf8'), 'accuracy'));
  const health = readJson(await readFileFn(healthPath, 'utf8'), 'health'); // shape owned by evaluate.py

  const baselineRaw = baselinePath ? readJson(await readFileFn(baselinePath, 'utf8'), 'baseline') : [];
  const baselineIds = new Set((Array.isArray(baselineRaw) ? baselineRaw : []).map((r) => r?.id));
  const resolvedIds = new Set(resolved.map((r) => r.id));

  await updateJsonWithRetry(store, LOG_CURRENT_KEY, (current) => {
    const live = Array.isArray(current) ? current : [];
    // Anything in the live blob that evaluate never saw (id not in the fetched
    // baseline) and did not already resolve is a concurrent append: keep it.
    const appended = live.filter((r) => !baselineIds.has(r?.id) && !resolvedIds.has(r?.id));
    appended.forEach((record) => {
      try {
        assertValidPredictionRecord(record);
      } catch (error) {
        throw new EvaluationPublicationError(`concurrent log record is invalid: ${error.message}`);
      }
    });
    return [...resolved, ...appended];
  });

  await store.setJSON(ACCURACY_KEY, accuracy);
  await store.setJSON(HEALTH_KEY, health);
  return { resolved: resolved.length, accuracyStatus: accuracy.status };
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
    const [logPath, accuracyPath, healthPath, baselinePath] = rest;
    // The baseline is what makes the concurrent-append merge correct, so the
    // canonical CLI requires it even though the library keeps a safe default.
    if (!logPath || !accuracyPath || !healthPath || !baselinePath) {
      throw new EvaluationPublicationError('publish requires log, accuracy, health and baseline paths');
    }
    const result = await publishEvaluation({ store, logPath, accuracyPath, healthPath, baselinePath });
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
