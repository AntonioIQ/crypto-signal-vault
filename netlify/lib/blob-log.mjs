// Compare-and-swap update for a JSON blob. The predictions log has two writers
// (predict.mjs appends every anchor; the daily evaluate republishes), so a
// plain read-modify-write loses whichever write lands second. This reads the
// current value with its etag, applies `mutate`, and writes conditionally;
// on a conflicting concurrent write it re-reads and retries.
export async function updateJsonWithRetry(store, key, mutate, { retries = 5 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const current = await store.getWithMetadata(key, {
      type: "json",
      consistency: "strong",
    });
    const value = current?.data ?? null;
    const next = mutate(value);
    if (next === undefined) {
      return { written: false, value };
    }

    // A brand-new key must be created with onlyIfNew so a racing creator loses
    // and we retry; an existing key is guarded by its etag.
    const options = current?.etag ? { onlyIfMatch: current.etag } : { onlyIfNew: true };
    const result = await store.setJSON(key, next, options);
    if (result?.modified !== false) {
      return { written: true, value: next };
    }
  }
  throw new Error(`updateJsonWithRetry: exhausted ${retries} retries for ${key}`);
}
