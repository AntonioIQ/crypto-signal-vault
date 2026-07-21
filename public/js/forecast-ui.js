// Mirrors MIN_ACCURACY_SAMPLES in netlify/lib/prediction-contract.mjs; kept as
// a local constant so this browser module has no Node-side imports.
const MIN_ACCURACY_SAMPLES = 20;

const DIRECTION_COPY = {
  up: {
    label: "Probablemente suba",
    headline: "El modelo señala una posible subida.",
    tone: "up",
  },
  down: {
    label: "Probablemente baje",
    headline: "El modelo señala una posible bajada.",
    tone: "down",
  },
  flat: {
    label: "Probablemente se mantenga",
    headline: "El modelo señala un precio relativamente estable.",
    tone: "flat",
  },
};

function isFinitePositive(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function hasValidTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function unavailableView() {
  return {
    available: false,
    status: "unavailable",
    direction: null,
    directionLabel: "Sin señal disponible",
    headline: "El pronóstico todavía no está disponible.",
    tone: "unavailable",
    confidenceLabel: "Sin medición",
    confidenceAvailable: false,
    terminalReturn: null,
    points: [],
    artifactVersion: null,
    anchoredAt: null,
  };
}

export function forecastView(snapshot, asset) {
  const forecast = snapshot?.forecast;
  const item = forecast?.assets?.[asset];
  const directionCopy = DIRECTION_COPY[item?.direction];

  if (
    !["fresh", "stale"].includes(forecast?.status) ||
    !directionCopy ||
    !hasValidTimestamp(forecast?.anchored_at) ||
    typeof forecast?.artifact_version !== "string" ||
    !Number.isFinite(item?.terminal_return) ||
    !Array.isArray(item?.points) ||
    item.points.length !== 48
  ) {
    return unavailableView();
  }

  const validPoints = item.points.every((point, index) =>
    point?.offset_hours === index + 1 &&
    hasValidTimestamp(point?.target_at) &&
    isFinitePositive(point?.price),
  );
  if (!validPoints) return unavailableView();

  const confidence = item.confidence;
  const confidenceAvailable =
    confidence?.status === "available" &&
    typeof confidence.value === "number" &&
    Number.isFinite(confidence.value) &&
    confidence.value >= 0 &&
    confidence.value <= 100;

  return {
    available: true,
    status: forecast.status,
    direction: item.direction,
    directionLabel: directionCopy.label,
    headline: directionCopy.headline,
    tone: directionCopy.tone,
    confidenceLabel: confidenceAvailable
      ? `${Math.round(confidence.value)} %`
      : "Aún no medible",
    confidenceAvailable,
    terminalReturn: item.terminal_return,
    points: item.points,
    artifactVersion: forecast.artifact_version,
    anchoredAt: forecast.anchored_at,
  };
}

export function artifactGeneratedAt(artifactVersion) {
  const match = typeof artifactVersion === "string"
    ? artifactVersion.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-/)
    : null;
  if (!match) return null;

  const [, year, month, day, hour, minute, second] = match;
  const generatedAt = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
  return Number.isFinite(generatedAt.getTime()) ? generatedAt : null;
}

// Measured 7-day accuracy for one asset. Shows a percentage only when the
// evaluator published `available` with enough samples; otherwise the card stays
// honestly blank and never borrows the model's confidence as a stand-in.
export function accuracyView(snapshot, asset) {
  const blank = { available: false, label: "—", status: "TRAS 7 DÍAS MEDIDOS" };
  const accuracy = snapshot?.accuracy;
  if (!accuracy || accuracy.status !== "available") return blank;

  const item = accuracy.assets?.[asset];
  if (!item) return blank;

  // Defense in depth: even if a block claims `available`, never show a
  // percentage without the measured minimum of resolved predictions.
  if (
    item.status === "available" &&
    typeof item.hit_rate === "number" &&
    Number.isFinite(item.hit_rate) &&
    Number.isInteger(item.sample_size) &&
    item.sample_size >= MIN_ACCURACY_SAMPLES
  ) {
    return {
      available: true,
      label: `${Math.round(item.hit_rate)} %`,
      status: `${item.sample_size} predicciones medidas`,
    };
  }

  if (item.status === "insufficient_data") {
    const size = Number.isInteger(item.sample_size) ? item.sample_size : 0;
    return { available: false, label: "—", status: `MIDIENDO (${size})` };
  }

  return blank;
}

export function chartSeries(history, snapshot, asset) {
  const historicalPoints = (history?.points ?? [])
    .filter((point) => hasValidTimestamp(point?.timestamp) && isFinitePositive(point?.price))
    .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
  const view = forecastView(snapshot, asset);
  const livePrice = snapshot?.assets?.[asset]?.price;
  const liveAt = snapshot?.generated_at;
  const hasLiveAnchor = isFinitePositive(livePrice) && hasValidTimestamp(liveAt);

  if (!view.available || !hasLiveAnchor) {
    return {
      labels: historicalPoints.map((point) => point.timestamp),
      actual: historicalPoints.map((point) => point.price),
      forecast: null,
    };
  }

  const anchorMs = Date.parse(view.anchoredAt);
  const realBeforeAnchor = historicalPoints.filter(
    (point) => Date.parse(point.timestamp) < anchorMs,
  );
  const labels = [
    ...realBeforeAnchor.map((point) => point.timestamp),
    view.anchoredAt,
    ...view.points.map((point) => point.target_at),
  ];
  const actual = [
    ...realBeforeAnchor.map((point) => point.price),
    livePrice,
    ...Array(48).fill(null),
  ];
  const projected = [
    ...Array(realBeforeAnchor.length).fill(null),
    livePrice,
    ...view.points.map((point) => point.price),
  ];

  return { labels, actual, forecast: projected };
}
