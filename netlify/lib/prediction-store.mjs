import {
  ACCURACY_KEY,
  LOG_CURRENT_KEY,
  appendPredictions,
  assertValidAccuracy,
  buildPredictionRecords,
  unavailableAccuracy,
} from "./prediction-contract.mjs";

// Reads the last measured accuracy block for embedding in the public snapshot.
// Any read or validation problem degrades to `unavailable` — the card stays
// blank rather than showing a wrong number.
export async function readAccuracyBlock(store) {
  if (!store || typeof store.get !== "function") return unavailableAccuracy();
  let raw;
  try {
    raw = await store.get(ACCURACY_KEY, { consistency: "strong", type: "json" });
  } catch {
    return unavailableAccuracy();
  }
  if (raw === null || raw === undefined) return unavailableAccuracy();
  try {
    return assertValidAccuracy(raw);
  } catch {
    return unavailableAccuracy();
  }
}

// Appends this anchor's predictions to the current-month log, deduped by id.
// Writes only when there is something new. Returns how many were added; a
// failure here must never affect the price snapshot, so callers isolate it.
export async function recordPredictions(store, snapshot) {
  const records = buildPredictionRecords(snapshot);
  if (records.length === 0) return 0;
  if (!store || typeof store.get !== "function" || typeof store.setJSON !== "function") {
    return 0;
  }

  let existing = null;
  try {
    existing = await store.get(LOG_CURRENT_KEY, { consistency: "strong", type: "json" });
  } catch {
    return 0;
  }
  const currentLog = Array.isArray(existing) ? existing : [];
  const updated = appendPredictions(currentLog, records);
  if (updated.length === currentLog.length) return 0;

  await store.setJSON(LOG_CURRENT_KEY, updated);
  return updated.length - currentLog.length;
}
