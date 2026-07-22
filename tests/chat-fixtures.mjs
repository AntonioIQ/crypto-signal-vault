import {
  createFreshSnapshot,
  formatMexicoCityTimestamp,
} from "../netlify/lib/market-contract.mjs";

const HOUR_MS = 60 * 60 * 1_000;
const ANCHORED_AT = new Date("2026-07-21T12:00:00-06:00");

function forecastAsset({ price, terminalReturn, confidence }) {
  return {
    direction: terminalReturn >= 0.005 ? "up" : terminalReturn <= -0.005 ? "down" : "flat",
    terminal_return: terminalReturn,
    confidence,
    points: Array.from({ length: 48 }, (_, index) => ({
      offset_hours: index + 1,
      target_at: formatMexicoCityTimestamp(
        new Date(ANCHORED_AT.getTime() + (index + 1) * HOUR_MS),
      ),
      price: price * (1 + (terminalReturn * (index + 1)) / 48),
    })),
  };
}

export function chatSnapshot() {
  const forecast = {
    status: "fresh",
    artifact_version: "20260721T180000Z-abcdef1-gh123-1",
    anchored_at: formatMexicoCityTimestamp(ANCHORED_AT),
    valid_until: formatMexicoCityTimestamp(
      new Date(ANCHORED_AT.getTime() + 36 * HOUR_MS),
    ),
    expires_at: formatMexicoCityTimestamp(
      new Date(ANCHORED_AT.getTime() + 72 * HOUR_MS),
    ),
    assets: {
      btc: forecastAsset({
        price: 65_000,
        terminalReturn: 0.018,
        confidence: {
          value: 72.5,
          status: "available",
          method: "rolling_origin_48h_residuals",
          sample_size: 40,
        },
      }),
      eth: forecastAsset({
        price: 3_500,
        terminalReturn: -0.007,
        confidence: {
          value: null,
          status: "insufficient_validation",
          method: "rolling_origin_48h_residuals",
          sample_size: 12,
        },
      }),
    },
  };
  const accuracy = {
    status: "available",
    window_days: 7,
    measured_through: "2026-07-21T11:30:00-06:00",
    assets: {
      btc: { status: "available", hit_rate: 58.3, sample_size: 96 },
      eth: { status: "insufficient_data", hit_rate: null, sample_size: 11 },
    },
  };
  const prices = {
    btc: { price: 65_000, sourceUpdatedAt: "2026-07-21T17:59:00.000Z" },
    eth: { price: 3_500, sourceUpdatedAt: "2026-07-21T17:59:00.000Z" },
  };
  return createFreshSnapshot(prices, ANCHORED_AT, forecast, accuracy);
}

export function makeCasStore(seed = null, { onFirstRead = null, fail = false } = {}) {
  const blobs = new Map();
  let nextEtag = 1;
  if (seed !== null) blobs.set("limits/current.json", { value: seed, etag: String(nextEtag++) });
  let firstRead = true;
  return {
    blobs,
    writes: 0,
    async getWithMetadata(key) {
      if (fail) throw new Error("store unavailable");
      const entry = blobs.get(key);
      const result = entry ? { data: structuredClone(entry.value), etag: entry.etag } : null;
      if (firstRead && onFirstRead) {
        firstRead = false;
        onFirstRead(blobs, () => String(nextEtag++));
      }
      return result;
    },
    async setJSON(key, value, options = {}) {
      if (fail) throw new Error("store unavailable");
      const current = blobs.get(key);
      if (options.onlyIfNew && current) return { modified: false };
      if (options.onlyIfMatch && current?.etag !== options.onlyIfMatch) {
        return { modified: false };
      }
      this.writes += 1;
      blobs.set(key, { value: structuredClone(value), etag: String(nextEtag++) });
      return { modified: true };
    },
  };
}
