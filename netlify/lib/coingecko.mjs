export const COINGECKO_BASE_URL = "https://api.coingecko.com/api/v3";
export const COINGECKO_TIMEOUT_MS = 8_000;
export const COINGECKO_MAX_RETRIES = 2;

const RETRY_DELAY_MS = 250;

export const ASSETS = Object.freeze({
  btc: Object.freeze({
    id: "bitcoin",
    symbol: "BTC",
    name: "Bitcoin",
  }),
  eth: Object.freeze({
    id: "ethereum",
    symbol: "ETH",
    name: "Ethereum",
  }),
});

const SUPPORTED_COIN_IDS = new Set(
  Object.values(ASSETS).map(({ id }) => id),
);

function isPositiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function buildHeaders(apiKey) {
  const headers = { accept: "application/json" };

  if (typeof apiKey === "string" && apiKey.length > 0) {
    headers["x-cg-demo-api-key"] = apiKey;
  }

  return headers;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function fetchJsonWithRetry(
  url,
  {
    fetchImpl = globalThis.fetch,
    apiKey = process.env.COINGECKO_DEMO_API_KEY,
    timeoutMs = COINGECKO_TIMEOUT_MS,
    maxRetries = COINGECKO_MAX_RETRIES,
    sleep = wait,
  } = {},
) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("A Fetch API implementation is required.");
  }

  let lastFailure;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchImpl(url, {
        headers: buildHeaders(apiKey),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`CoinGecko returned HTTP ${response.status}.`);
      }

      return await response.json();
    } catch (error) {
      lastFailure = error;

      if (attempt < maxRetries) {
        await sleep(RETRY_DELAY_MS * 2 ** attempt);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  const reason = lastFailure?.name === "AbortError" ? "timeout" : "request error";
  throw new Error(
    `CoinGecko request failed after ${maxRetries + 1} attempts (${reason}).`,
  );
}

function validateSimplePricePayload(payload) {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("CoinGecko simple price response must be an object.");
  }

  return Object.fromEntries(
    Object.entries(ASSETS).map(([asset, metadata]) => {
      const item = payload[metadata.id];

      if (
        item === null ||
        typeof item !== "object" ||
        !isPositiveNumber(item.usd) ||
        !Number.isInteger(item.last_updated_at) ||
        item.last_updated_at <= 0
      ) {
        throw new TypeError(
          `CoinGecko simple price response is invalid for ${metadata.id}.`,
        );
      }

      return [
        asset,
        {
          ...metadata,
          price: item.usd,
          sourceUpdatedAt: new Date(item.last_updated_at * 1_000).toISOString(),
        },
      ];
    }),
  );
}

export async function fetchCurrentPrices(options = {}) {
  const url = new URL(`${COINGECKO_BASE_URL}/simple/price`);
  url.searchParams.set(
    "ids",
    Object.values(ASSETS)
      .map(({ id }) => id)
      .join(","),
  );
  url.searchParams.set("vs_currencies", "usd");
  url.searchParams.set("include_last_updated_at", "true");

  const payload = await fetchJsonWithRetry(url, options);
  return validateSimplePricePayload(payload);
}

function validateMarketChartPayload(payload, coinId) {
  if (
    payload === null ||
    typeof payload !== "object" ||
    !Array.isArray(payload.prices) ||
    payload.prices.length === 0
  ) {
    throw new TypeError(`CoinGecko market chart response is invalid for ${coinId}.`);
  }

  const points = payload.prices.map((point) => {
    if (
      !Array.isArray(point) ||
      point.length < 2 ||
      !isPositiveNumber(point[0]) ||
      !isPositiveNumber(point[1])
    ) {
      throw new TypeError(
        `CoinGecko market chart contains an invalid point for ${coinId}.`,
      );
    }

    return {
      timestamp: new Date(point[0]).toISOString(),
      price: point[1],
    };
  });

  points.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  return points;
}

export async function fetchMarketChart(coinId, { days = 30, ...options } = {}) {
  if (!SUPPORTED_COIN_IDS.has(coinId)) {
    throw new RangeError(`Unsupported CoinGecko asset: ${coinId}.`);
  }

  if (!Number.isInteger(days) || days < 1 || days > 365) {
    throw new RangeError("Market chart days must be an integer from 1 to 365.");
  }

  const url = new URL(
    `${COINGECKO_BASE_URL}/coins/${encodeURIComponent(coinId)}/market_chart`,
  );
  url.searchParams.set("vs_currency", "usd");
  url.searchParams.set("days", String(days));

  const payload = await fetchJsonWithRetry(url, options);
  return validateMarketChartPayload(payload, coinId);
}
