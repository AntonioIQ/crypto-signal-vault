import { assertValidSnapshot } from "./market-contract.mjs";

export const ANALYST_CONTEXT_SCHEMA_VERSION = "analyst-context/1.0";

function roundedPercent(value) {
  return Number(value.toFixed(1));
}

function forecastContext(snapshot, asset) {
  const forecast = snapshot.forecast;
  if (!forecast || forecast.status === "unavailable") {
    return { status: "unavailable" };
  }

  const item = forecast.assets[asset];
  return {
    status: forecast.status,
    horizon_hours: 48,
    direction: item.direction,
    terminal_change_percent: roundedPercent(item.terminal_return * 100),
    confidence: item.confidence.status === "available"
      ? {
          status: "available",
          percent: item.confidence.value,
          sample_size: item.confidence.sample_size,
        }
      : {
          status: "insufficient_validation",
          percent: null,
          sample_size: item.confidence.sample_size,
        },
  };
}

function accuracyContext(snapshot, asset) {
  const accuracy = snapshot.accuracy;
  if (!accuracy || accuracy.status === "unavailable") {
    return { status: "unavailable" };
  }

  const item = accuracy.assets[asset];
  return {
    status: item.status,
    window_days: accuracy.window_days,
    hit_rate_percent: item.hit_rate,
    sample_size: item.sample_size,
    measured_through: accuracy.measured_through,
  };
}

export function buildAnalystContext(snapshot) {
  assertValidSnapshot(snapshot);

  return {
    schema_version: ANALYST_CONTEXT_SCHEMA_VERSION,
    generated_at: snapshot.generated_at,
    timezone: snapshot.timezone,
    stale: snapshot.stale,
    assets: Object.fromEntries(
      ["btc", "eth"].map((asset) => {
        const market = snapshot.assets[asset];
        return [
          asset,
          {
            name: market.name,
            symbol: market.symbol,
            price_usd: market.price,
            source_updated_at: market.source_updated_at,
            forecast: forecastContext(snapshot, asset),
            accuracy: accuracyContext(snapshot, asset),
          },
        ];
      }),
    ),
  };
}

export function serializeAnalystContext(context) {
  if (context?.schema_version !== ANALYST_CONTEXT_SCHEMA_VERSION) {
    throw new TypeError("Unsupported analyst context.");
  }
  return JSON.stringify(context);
}
