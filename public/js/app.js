// LikelyCoin — market and 48-hour forecast dashboard
// Data flow: /api/latest (Blobs-backed function) with fallback to the static
// seed /data/latest.json; 30-day history from /api/history with the static
// /data/history/<asset>.json build seed as fallback.

import {
  artifactGeneratedAt,
  chartSeries,
  forecastView,
} from './forecast-ui.js';

const TIMEZONE = 'America/Mexico_City';
const REFRESH_INTERVAL_MS = 15 * 60 * 1000; // predict.mjs schedule in netlify.toml
const STALE_AFTER_MS = 60 * 60 * 1000; // 4 missed runs: no longer "al día"
const ANCHOR_TOLERANCE_MS = 2 * 60 * 60 * 1000; // max drift for the 24h anchor

const els = {
  banner: document.getElementById('status-banner'),
  statusText: document.getElementById('status-text'),
  assetTicker: document.getElementById('asset-ticker'),
  assetName: document.getElementById('asset-name'),
  price: document.getElementById('price'),
  change: document.getElementById('change'),
  lastUpdate: document.getElementById('last-update'),
  nextUpdate: document.getElementById('card-next-update'),
  chartNote: document.getElementById('chart-note'),
  forecastLegend: document.getElementById('forecast-legend'),
  predictionTitle: document.getElementById('prediction-title'),
  predictionBody: document.getElementById('prediction-body'),
  signalPanel: document.getElementById('signal-panel'),
  signalDirection: document.getElementById('signal-direction'),
  signalConfidence: document.getElementById('signal-confidence'),
  signalStatus: document.getElementById('signal-status'),
  trained: document.getElementById('card-trained'),
  trainedStatus: document.getElementById('card-trained-status'),
  tabs: [...document.querySelectorAll('.tab')],
};

const state = {
  asset: 'btc',
  snapshot: null,
  history: {}, // asset -> history document
  chart: null,
};

const priceFmt = new Intl.NumberFormat('es-MX', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

const timeFmt = new Intl.DateTimeFormat('es-MX', {
  timeZone: TIMEZONE,
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

const dayFmt = new Intl.DateTimeFormat('es-MX', {
  timeZone: TIMEZONE,
  day: 'numeric',
  month: 'short',
});

async function fetchJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

// Live endpoint first; static seed as fallback so the page never dies.
async function loadSnapshot() {
  try {
    return await fetchJson('/api/latest');
  } catch {
    return fetchJson('data/latest.json');
  }
}

// Same shape: the refreshed window lives in Blobs, and the build seed is the
// floor. The seed is frozen at bootstrap time, so it may be old enough that
// change24h() declines to show a figure — that is the intended degradation.
async function loadHistory(asset) {
  try {
    return await fetchJson(`/api/history?asset=${asset}`);
  } catch {
    return fetchJson(`data/history/${asset}.json`);
  }
}

function setStatus(kind, text) {
  els.banner.classList.remove('fresh', 'stale', 'error');
  if (kind) els.banner.classList.add(kind);
  els.statusText.textContent = text;
}

function hoursAgo(iso) {
  return (Date.now() - new Date(iso).getTime()) / 3_600_000;
}

function renderStatus(snapshot) {
  const age = hoursAgo(snapshot.generated_at);
  if (snapshot.stale || age * 3_600_000 > STALE_AFTER_MS) {
    const rounded = Math.max(1, Math.round(age));
    setStatus('stale', `Datos de hace ${rounded} ${rounded === 1 ? 'hora' : 'horas'}`);
  } else {
    setStatus('fresh', 'Datos al día');
  }
  els.lastUpdate.textContent =
    `Última actualización: ${timeFmt.format(new Date(snapshot.generated_at))} (hora CDMX)`;

  // Anchored to the last real run, not to a wall-clock boundary: Netlify fires
  // the schedule a few minutes late, so promising an exact slot would be a
  // promise we don't control. Once that estimate passes, stop naming a time.
  const next = new Date(new Date(snapshot.generated_at).getTime() + REFRESH_INTERVAL_MS);
  els.nextUpdate.textContent =
    next.getTime() > Date.now() ? `${timeFmt.format(next)} (CDMX)` : 'En cualquier momento';
}

// Compares the displayed price against the history point closest to 24h
// before it. The anchor must land within ANCHOR_TOLERANCE_MS of that target,
// otherwise the window is not really 24h and we show nothing rather than a
// number that contradicts the price above it.
function change24h(history, price, priceAsOf) {
  const points = history?.points ?? [];
  if (!points.length || typeof price !== 'number' || !priceAsOf) return null;

  const target = new Date(priceAsOf).getTime() - 24 * 3_600_000;
  let anchor = null;
  let anchorDrift = Infinity;
  for (const point of points) {
    const drift = Math.abs(new Date(point.timestamp).getTime() - target);
    if (drift < anchorDrift) {
      anchorDrift = drift;
      anchor = point;
    }
  }

  if (!anchor || anchorDrift > ANCHOR_TOLERANCE_MS) return null;
  return ((price - anchor.price) / anchor.price) * 100;
}

function renderPrice() {
  const asset = state.snapshot?.assets?.[state.asset];
  const history = state.history[state.asset];
  els.assetName.textContent = asset?.name ?? state.asset.toUpperCase();
  els.assetTicker.textContent = `${asset?.symbol ?? state.asset.toUpperCase()} · USD`;

  // Live price when available; otherwise last history point (labeled stale upstream).
  const lastPoint = history?.points?.at(-1) ?? null;
  const price = asset?.price ?? lastPoint?.price ?? null;
  els.price.textContent = price === null ? 'Sin datos' : priceFmt.format(price);

  // The change must be anchored to whichever price we actually display.
  const priceAsOf = asset?.price != null
    ? state.snapshot?.generated_at
    : lastPoint?.timestamp;
  const change = change24h(history, price, priceAsOf);
  els.change.classList.remove('up', 'down');
  if (change === null) {
    els.change.textContent = '';
  } else {
    els.change.classList.add(change >= 0 ? 'up' : 'down');
    const sign = change >= 0 ? '+' : '−';
    els.change.textContent = `${sign}${Math.abs(change).toFixed(1)} % en las últimas 24 h`;
  }
}

function renderChart() {
  const history = state.history[state.asset];
  if (!history?.points?.length) return;

  const series = chartSeries(history, state.snapshot, state.asset);
  const assetName = state.snapshot?.assets?.[state.asset]?.name ?? state.asset.toUpperCase();

  if (state.chart) state.chart.destroy();
  const styles = getComputedStyle(document.documentElement);
  const accent = styles.getPropertyValue('--accent').trim();
  const muted = styles.getPropertyValue('--muted').trim();
  const grid = styles.getPropertyValue('--chart-grid').trim();
  const surface = styles.getPropertyValue('--surface-raised').trim();
  const text = styles.getPropertyValue('--text').trim();
  const forecastColor = styles.getPropertyValue('--forecast').trim();

  const datasets = [{
    label: 'Precio real',
    data: series.actual,
    borderColor: accent,
    backgroundColor: 'rgba(105, 230, 178, 0.06)',
    borderWidth: 2.5,
    fill: true,
    pointRadius: 0,
    tension: 0.2,
    spanGaps: true, // tolerate ingestion gaps (R-11)
  }];
  if (series.forecast) {
    datasets.push({
      label: 'Pronóstico 48 h',
      data: series.forecast,
      borderColor: forecastColor,
      backgroundColor: 'transparent',
      borderWidth: 2,
      borderDash: [6, 6],
      fill: false,
      pointRadius: 0,
      pointHitRadius: 8,
      tension: 0.24,
      spanGaps: false,
    });
  }

  els.forecastLegend.hidden = !series.forecast;
  els.chartNote.textContent = series.forecast
    ? `La línea punteada muestra el recorrido estimado para ${assetName}; no representa una garantía.`
    : 'El precio real sigue disponible. Publicaremos la línea punteada cuando exista un pronóstico válido.';
  const canvas = document.getElementById('chart');
  canvas.setAttribute(
    'aria-label',
    series.forecast
      ? `Precio real y pronóstico de 48 horas de ${assetName}`
      : `Precio real de los últimos 30 días de ${assetName}`,
  );

  state.chart = new Chart(canvas, {
    type: 'line',
    data: {
      labels: series.labels,
      datasets,
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      layout: { padding: { top: 8 } },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: surface,
          titleColor: muted,
          bodyColor: text,
          borderColor: grid,
          borderWidth: 1,
          padding: 12,
          displayColors: false,
          callbacks: {
            title: (items) => `${timeFmt.format(new Date(items[0].label))} (CDMX)`,
            label: (item) => `${item.dataset.label}: ${priceFmt.format(item.parsed.y)}`,
          },
        },
      },
      scales: {
        x: {
          ticks: {
            color: muted,
            font: { size: 10 },
            maxTicksLimit: 7,
            callback(value) {
              return dayFmt.format(new Date(this.getLabelForValue(value)));
            },
          },
          border: { display: false },
          grid: { display: false },
        },
        y: {
          border: { display: false },
          grid: { color: grid },
          ticks: {
            color: muted,
            font: { size: 10 },
            maxTicksLimit: 5,
            callback: (value) => priceFmt.format(value),
          },
        },
      },
    },
  });
}

function renderPrediction() {
  const view = forecastView(state.snapshot, state.asset);
  const assetName = state.snapshot?.assets?.[state.asset]?.name ?? state.asset.toUpperCase();
  els.signalPanel.classList.remove('up', 'down', 'flat', 'stale', 'unavailable');

  if (!view.available) {
    els.predictionTitle.textContent = 'El pronóstico todavía no está disponible.';
    els.predictionBody.textContent =
      `Seguimos mostrando el precio real de ${assetName}. La señal aparecerá cuando el modelo publique una lectura completa y vigente.`;
    els.signalDirection.textContent = 'Sin señal disponible';
    els.signalConfidence.textContent = 'Sin medición';
    els.signalStatus.textContent = 'NO DISPONIBLE';
    els.signalPanel.classList.add('unavailable');
    els.trained.textContent = 'Sin publicación';
    els.trainedStatus.textContent = 'PRONÓSTICO PENDIENTE';
    return;
  }

  const estimatedChange = Math.abs(view.terminalReturn * 100).toFixed(1);
  const changeCopy = view.direction === 'up'
    ? `El modelo estima una subida de ${estimatedChange} % al final del periodo.`
    : view.direction === 'down'
      ? `El modelo estima una bajada de ${estimatedChange} % al final del periodo.`
      : 'El cambio estimado se mantiene dentro de un margen de 0.5 %.';
  const confidenceCopy = view.confidenceAvailable
    ? 'La confianza resume qué tan consistente fue esta dirección en pruebas previas.'
    : 'Todavía no hay suficientes pruebas previas para publicar un porcentaje de confianza.';
  const freshnessCopy = view.status === 'stale'
    ? ' Esta lectura está pendiente de actualización.'
    : '';

  els.predictionTitle.textContent = view.headline;
  els.predictionBody.textContent = `${changeCopy} ${confidenceCopy}${freshnessCopy}`;
  els.signalDirection.textContent = view.directionLabel;
  els.signalConfidence.textContent = view.confidenceLabel;
  els.signalStatus.textContent = view.status === 'fresh' ? 'PRONÓSTICO VIGENTE' : 'ACTUALIZACIÓN PENDIENTE';
  els.signalPanel.classList.add(view.tone);
  if (view.status === 'stale') els.signalPanel.classList.add('stale');

  const trainedAt = artifactGeneratedAt(view.artifactVersion);
  els.trained.textContent = trainedAt
    ? `${timeFmt.format(trainedAt)} (CDMX)`
    : 'Publicación validada';
  els.trainedStatus.textContent = view.status === 'fresh' ? 'MODELO AL DÍA' : 'MODELO POR ACTUALIZAR';
}

function selectAsset(asset) {
  state.asset = asset;
  for (const tab of els.tabs) {
    const active = tab.dataset.asset === asset;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  }
  renderPrice();
  renderPrediction();
  renderChart();
}

async function init() {
  for (const tab of els.tabs) {
    tab.addEventListener('click', () => selectAsset(tab.dataset.asset));
  }

  try {
    const [snapshot, btc, eth] = await Promise.all([
      loadSnapshot(),
      loadHistory('btc'),
      loadHistory('eth'),
    ]);
    state.snapshot = snapshot;
    state.history = { btc, eth };
    renderStatus(snapshot);
    selectAsset(state.asset);
  } catch (error) {
    console.error(error);
    setStatus('error', 'No se pudieron cargar los datos. Intenta de nuevo en unos minutos.');
    els.price.textContent = 'Sin datos';
  }
}

init();
