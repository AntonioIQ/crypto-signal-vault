import { updateJsonWithRetry } from "./blob-log.mjs";
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

// Appends this anchor's predictions to the current-month log, deduped by id and
// guarded by compare-and-swap so a concurrent daily evaluate cannot drop the
// append. Writes only when there is something new. Returns how many were added;
// a failure here must never affect the price snapshot, so callers isolate it.
export async function recordPredictions(store, snapshot) {
  const records = buildPredictionRecords(snapshot);
  if (records.length === 0) return 0;
  if (
    !store ||
    typeof store.getWithMetadata !== "function" ||
    typeof store.setJSON !== "function"
  ) {
    return 0;
  }

  let added = 0;
  try {
    const result = await updateJsonWithRetry(store, LOG_CURRENT_KEY, (current) => {
      const log = Array.isArray(current) ? current : [];
      const updated = appendPredictions(log, records);
      if (updated.length === log.length) return undefined; // nothing new to write
      added = updated.length - log.length;
      return updated;
    });
    return result.written ? added : 0;
  } catch {
    // Self-isolating: a store outage or exhausted retries records nothing and
    // never throws, so the caller's price path is safe regardless.
    return 0;
  }
}
