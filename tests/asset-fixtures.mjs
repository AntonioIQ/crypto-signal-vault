// Shared test helpers for the multi-asset world. The contracts iterate over
// ASSETS and require every configured coin to be present in a snapshot/artifact,
// so fixtures that only care about btc/eth still have to carry the rest. These
// fillers default the other coins to valid throwaway values while letting a test
// override the ones it actually asserts on.

import { ASSETS } from "../netlify/lib/coingecko.mjs";

export const ASSET_KEYS = Object.keys(ASSETS);

// The filler timestamp used to be `new Date()`, which made every assertion
// about published figures depend on the wall clock: the digits of "now" ground
// themselves, so a test could pass at 22:00 and fail at 03:52 because the hour
// happened to contain the digit under test. Fixtures state a fixed instant.
export const FIXTURE_UPDATED_AT = "2026-07-21T17:59:00.000Z";

// A full { asset: { price, sourceUpdatedAt } } map for createFreshSnapshot.
export function fillPrices(overrides = {}, defaults = {}) {
  const price = defaults.price ?? 100;
  const sourceUpdatedAt = defaults.sourceUpdatedAt ?? FIXTURE_UPDATED_AT;
  const out = {};
  for (const asset of ASSET_KEYS) {
    out[asset] = overrides[asset] ?? { price, sourceUpdatedAt };
  }
  return out;
}

// A full { asset: <artifact asset> } map. `make(asset, id, symbol)` builds a
// filler for the coins the test didn't specify.
export function fillArtifactAssets(overrides, make) {
  const out = {};
  for (const [asset, meta] of Object.entries(ASSETS)) {
    out[asset] = overrides[asset] ?? make(asset, meta.id, meta.symbol);
  }
  return out;
}

// A full accuracy.assets map; unspecified coins report insufficient data.
export function fillAccuracyAssets(overrides = {}) {
  const out = {};
  for (const asset of ASSET_KEYS) {
    out[asset] = overrides[asset] ?? { status: "insufficient_data", hit_rate: null, sample_size: 0 };
  }
  return out;
}
