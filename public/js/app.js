// LikelyCoin — market and 48-hour forecast dashboard
// Data flow: /api/latest (Blobs-backed function) with fallback to the static
// seed /data/latest.json; 30-day history from /api/history with the static
// /data/history/<asset>.json build seed as fallback.

import {
  accuracyView,
  artifactGeneratedAt,
  forecastView,
} from './forecast-ui.js';
import { mountLikelyChart } from './likely-chart.js';
import { mountScenarioViz } from './scenario-viz.js';
import { fmtPrice } from './format.js';

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
  chartMount: document.getElementById('chart-mount'),
  scenarioMount: document.getElementById('scenario-mount'),
  signalPanel: document.getElementById('signal-panel'),
  signalEyebrow: document.getElementById('signal-eyebrow'),
  signalDirection: document.getElementById('signal-direction'),
  signalConfidence: document.getElementById('signal-confidence'),
  signalBarFill: document.getElementById('signal-bar-fill'),
  signalScenarios: document.getElementById('signal-scenarios'),
  signalAccuracy: document.getElementById('signal-accuracy'),
  signalStatus: document.getElementById('signal-status'),
  forecastRows: document.getElementById('forecast-rows'),
  ticker: document.getElementById('ticker'),
  spark: document.getElementById('spark'),
  scenarioAsset: document.getElementById('scenario-asset'),
  trained: document.getElementById('card-trained'),
  trainedStatus: document.getElementById('card-trained-status'),
  accuracy: document.getElementById('card-accuracy'),
  accuracyStatus: document.getElementById('card-accuracy-status'),
  assetTabs: document.getElementById('asset-tabs'),
  priceBlock: document.querySelector('.price-block'),
  tabs: [],
};

const state = {
  asset: 'btc',
  snapshot: null,
  history: {}, // asset -> history document (loaded lazily, cached)
  chart: null,
};

const timeFmt = new Intl.DateTimeFormat('es-MX', {
  timeZone: TIMEZONE,
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
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

// The 24h move for a coin, using whichever price we would display for it.
function assetChange24h(asset) {
  const market = state.snapshot?.assets?.[asset];
  const hist = state.history[asset];
  const last = hist?.points?.at(-1) ?? null;
  const price = market?.price ?? last?.price ?? null;
  const asOf = market?.price != null ? state.snapshot?.generated_at : last?.timestamp;
  return { price, change: change24h(hist, price, asOf) };
}

// Top ticker: the whole board at a glance. Coins whose history has not loaded
// yet simply show no percentage rather than a placeholder number.
function renderTicker() {
  if (!els.ticker) return;
  const assets = state.snapshot?.assets ?? {};
  els.ticker.innerHTML = Object.entries(assets).map(([asset, meta]) => {
    const { change } = assetChange24h(asset);
    const symbol = meta?.symbol ?? asset.toUpperCase();
    const cls = change == null ? '' : change >= 0 ? 'up' : 'down';
    const text = change == null
      ? '—'
      : `${change >= 0 ? '+' : '−'}${Math.abs(change).toFixed(1)}%`;
    return `<span class="ticker-item"><b>${symbol}</b><span class="${cls}">${text}</span></span>`;
  }).join('');
}

// Sparkline of the selected coin's 30-day history, drawn to the card's 360x70
// viewBox. Flat or missing history leaves the area empty instead of a fake line.
function renderSpark() {
  if (!els.spark) return;
  const points = (state.history[state.asset]?.points ?? [])
    .map((p) => p.price)
    .filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (points.length < 2) { els.spark.innerHTML = ''; return; }

  const W = 360;
  const H = 70;
  const lo = Math.min(...points);
  const hi = Math.max(...points);
  const span = hi - lo || 1;
  const X = (i) => (i / (points.length - 1)) * W;
  const Y = (v) => H - 3 - ((v - lo) / span) * (H - 8);
  const line = points
    .map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(v).toFixed(1)}`)
    .join(' ');
  els.spark.innerHTML =
    `<path class="spark-area" d="${line} L ${W} ${H} L 0 ${H} Z"></path>` +
    `<path class="spark-line" d="${line}"></path>`;
}

// Restart a one-shot CSS animation by removing the class, forcing reflow and
// re-adding it — so the same class animates again on the next call.
function replay(el, cls) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

// Tween a number into an element, formatting each frame, so a price update
// reads as motion rather than a jump. `from` 0 gives the boot count-up; a huge
// relative jump (a coin switch) skips the tween and lets the crossfade carry it.
function animateCount(el, to, formatter, { from } = {}) {
  const start = typeof from === 'number' ? from
    : typeof el._val === 'number' ? el._val : to;
  el._val = to;
  if (!Number.isFinite(start) || !Number.isFinite(to)) { el.textContent = formatter(to); return; }
  const ratio = Math.abs(to - start) / (Math.abs(to) || 1);
  if (start === to || ratio > 1.5) { el.textContent = formatter(to); return; }
  const duration = 650;
  const t0 = performance.now();
  const ease = (p) => 1 - (1 - p) ** 3;
  (function step(now) {
    const p = Math.min(1, (now - t0) / duration);
    el.textContent = formatter(start + (to - start) * ease(p));
    if (p < 1) requestAnimationFrame(step);
  })(t0);
}

// mode: 'switch' (coin change → crossfade), 'update' (live refresh → count-up +
// pulse), or 'boot' (first paint → count-up from 0).
function renderPrice(mode = 'switch') {
  const asset = state.snapshot?.assets?.[state.asset];
  const history = state.history[state.asset];
  els.assetName.textContent = asset?.name ?? state.asset.toUpperCase();
  els.assetTicker.textContent = `${asset?.symbol ?? state.asset.toUpperCase()} · USD`;

  // Live price when available; otherwise last history point (labeled stale upstream).
  const lastPoint = history?.points?.at(-1) ?? null;
  const price = asset?.price ?? lastPoint?.price ?? null;
  if (price === null) {
    els.price.textContent = 'Sin datos';
    els.price._val = undefined;
  } else if (mode === 'boot') {
    animateCount(els.price, price, fmtPrice, { from: 0 });
  } else if (mode === 'update') {
    const changed = els.price._val !== price;
    animateCount(els.price, price, fmtPrice);
    if (changed) replay(els.price, 'is-fresh');
  } else {
    els.price._val = price;
    els.price.textContent = fmtPrice(price);
  }
  if (mode === 'switch') replay(els.priceBlock ?? els.price, 'is-swap');

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
    const mark = change >= 0 ? '▲' : '▼';
    els.change.innerHTML =
      `${mark} ${Math.abs(change).toFixed(1)} %<span class="change-window">24 h</span>`;
  }

  renderSpark();
}


const DIR_MARK = { up: '▲', down: '▼', flat: '➜' };
const DIR_WORD = { up: 'una subida', down: 'una bajada', flat: 'un precio estable' };

// One forecast reading per coin, straight from the artifact the model published.
// A coin with no usable forecast reports "Sin señal" instead of a fabricated one.
function forecastRowData(asset) {
  const item = state.snapshot?.forecast?.assets?.[asset];
  const meta = state.snapshot?.assets?.[asset];
  const conf = item?.confidence;
  const available = Boolean(item) && typeof item.terminal_return === 'number';
  const measured = conf?.status === 'available' && typeof conf.value === 'number';
  return {
    asset,
    symbol: meta?.symbol ?? asset.toUpperCase(),
    name: meta?.name ?? asset.toUpperCase(),
    available,
    direction: item?.direction ?? null,
    terminalReturn: item?.terminal_return ?? null,
    measured,
    confidence: measured ? conf.value : null,
    sampleSize: conf?.sample_size ?? 0,
  };
}

function renderForecastTable() {
  if (!els.forecastRows) return;
  const assets = Object.keys(state.snapshot?.assets ?? {});
  const rows = assets
    .map(forecastRowData)
    // Measured confidence first, then by how strong it is: the board reads
    // top-down from "most backed by validation" to "not measurable yet".
    .sort((a, b) => (b.confidence ?? -1) - (a.confidence ?? -1));

  els.forecastRows.innerHTML = '';
  for (const row of rows) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'forecast-row' + (row.asset === state.asset ? ' selected' : '');
    btn.dataset.asset = row.asset;
    btn.setAttribute('role', 'row');

    const tone = !row.available ? 'fc-none' : `fc-${row.direction ?? 'flat'}`;
    const dirLabel = row.available
      ? `${DIR_MARK[row.direction] ?? '➜'} ${row.direction === 'up' ? 'Sube' : row.direction === 'down' ? 'Baja' : 'Estable'}`
      : 'Sin señal';
    const pctLabel = row.available
      ? `${row.terminalReturn >= 0 ? '+' : '−'}${Math.abs(row.terminalReturn * 100).toFixed(1)} %`
      : '—';
    const confLabel = row.measured ? `${Math.round(row.confidence)} %` : 'Sin medir';
    const barWidth = row.measured ? `${Math.max(0, Math.min(100, row.confidence))}%` : '0%';

    btn.innerHTML =
      `<span class="fc-sym">${row.symbol}</span>` +
      `<span class="fc-name">${row.name}</span>` +
      `<span class="fc-dir ${tone}">${dirLabel}</span>` +
      `<span class="fc-pct ${tone}">${pctLabel}</span>` +
      `<span class="fc-conf ${tone}">` +
        `<span class="fc-track"><span class="fc-fill" style="width:${barWidth}"></span></span>` +
        `<b>${confLabel}</b>` +
      `</span>`;
    btn.addEventListener('click', () => { selectAsset(row.asset); });
    els.forecastRows.appendChild(btn);
  }
}

function renderPrediction() {
  const view = forecastView(state.snapshot, state.asset);
  const row = forecastRowData(state.asset);
  const accuracy = accuracyView(state.snapshot, state.asset);
  els.signalPanel.classList.remove('up', 'down', 'flat', 'stale', 'unavailable');
  els.signalEyebrow.textContent = `MONEDA SELECCIONADA · ${row.symbol}`;
  els.signalAccuracy.textContent = accuracy.label;

  if (!view.available) {
    els.signalDirection.textContent = 'Sin señal disponible';
    els.signalConfidence.textContent = '—';
    els.signalBarFill.style.width = '0%';
    els.signalScenarios.textContent =
      `Seguimos mostrando el precio real de ${row.name}. La señal aparecerá cuando el modelo publique una lectura completa y vigente.`;
    els.signalStatus.textContent = 'NO DISPONIBLE';
    els.signalPanel.classList.add('unavailable');
    els.trained.textContent = 'Sin publicación';
    els.trainedStatus.textContent = 'PRONÓSTICO PENDIENTE';
    renderForecastTable();
    return;
  }

  const pct = `${Math.abs(view.terminalReturn * 100).toFixed(1)} %`;
  els.signalDirection.textContent = `${DIR_MARK[view.direction] ?? '➜'} ${pct}`;
  els.signalConfidence.textContent = view.confidenceLabel;
  els.signalBarFill.style.width = row.measured
    ? `${Math.max(0, Math.min(100, row.confidence))}%`
    : '0%';
  els.signalScenarios.textContent = row.measured
    ? `${Math.round((row.confidence / 100) * row.sampleSize)} de ${row.sampleSize} escenarios de validación apuntan a ${DIR_WORD[view.direction] ?? 'un movimiento'}.`
    : `${row.sampleSize} escenarios medidos; con menos de 20 no se publica un porcentaje.`;
  els.signalStatus.textContent = view.status === 'fresh' ? 'PRONÓSTICO VIGENTE' : 'ACTUALIZACIÓN PENDIENTE';
  els.signalPanel.classList.add(view.tone);
  if (view.status === 'stale') els.signalPanel.classList.add('stale');

  const trainedAt = artifactGeneratedAt(view.artifactVersion);
  els.trained.textContent = trainedAt
    ? `${timeFmt.format(trainedAt)} (CDMX)`
    : 'Publicación validada';
  els.trainedStatus.textContent = view.status === 'fresh' ? 'MODELO AL DÍA' : 'MODELO POR ACTUALIZAR';
  renderForecastTable();
}

// Tabs are built from the assets the snapshot actually carries, so adding a
// coin to the backend config surfaces it here with no HTML change.
function buildTabs(assets) {
  els.assetTabs.innerHTML = '';
  els.tabs = Object.entries(assets).map(([asset, meta]) => {
    const btn = document.createElement('button');
    btn.className = 'tab';
    btn.type = 'button';
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', 'false');
    btn.dataset.asset = asset;
    btn.innerHTML =
      `<span class="tab-symbol">${meta.symbol ?? asset.toUpperCase()}</span>` +
      `<span>${meta.name ?? asset.toUpperCase()}</span>`;
    btn.addEventListener('click', () => { selectAsset(asset); });
    els.assetTabs.appendChild(btn);
    return btn;
  });
}

async function selectAsset(asset, mode = 'switch') {
  state.asset = asset;
  for (const tab of els.tabs) {
    const active = tab.dataset.asset === asset;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  }
  // History is fetched on demand and cached; the chart holds the same object
  // reference, so a newly loaded asset becomes visible to it immediately.
  if (!state.history[asset]) {
    try {
      state.history[asset] = await loadHistory(asset);
    } catch (error) {
      console.error(error);
    }
  }
  if (els.scenarioAsset) {
    els.scenarioAsset.textContent =
      state.snapshot?.assets?.[asset]?.symbol ?? asset.toUpperCase();
  }
  renderPrice(mode);
  renderPrediction();
  renderAccuracy();
  renderTicker();
  state.chart?.setAsset(asset);
  state.scenarios?.setAsset(asset);
}

// Light live refresh: re-read the snapshot on an interval (only while the tab is
// visible) so a moved price counts up instead of waiting for a manual reload.
// Prices advance every ~15 min upstream, so this stays cheap.
function startLiveRefresh(intervalMs = 5 * 60 * 1000) {
  setInterval(async () => {
    if (document.hidden) return;
    let snapshot;
    try {
      snapshot = await loadSnapshot();
    } catch {
      return;
    }
    state.snapshot = snapshot;
    renderStatus(snapshot);
    renderPrice('update');
    renderPrediction();
    renderAccuracy();
    renderTicker();
  }, intervalMs);
}

function renderAccuracy() {
  const view = accuracyView(state.snapshot, state.asset);
  els.accuracy.textContent = view.label;
  els.accuracyStatus.textContent = view.status;
}

async function init() {
  try {
    const snapshot = await loadSnapshot();
    state.snapshot = snapshot;
    const assets = Object.keys(snapshot.assets ?? {});
    state.asset = assets.includes('btc') ? 'btc' : assets[0];
    buildTabs(snapshot.assets ?? {});
    renderStatus(snapshot);

    // btc and eth load up front: they are the default view and the fixed
    // benchmarks for the chart's "BTC vs ETH" compare mode. Every other coin's
    // history is fetched the first time its tab is opened.
    const [btc, eth] = await Promise.all([
      loadHistory('btc').catch(() => null),
      loadHistory('eth').catch(() => null),
    ]);
    if (btc) state.history.btc = btc;
    if (eth) state.history.eth = eth;

    // Mount the bespoke chart once the data is in; it is driven by the asset
    // tabs through setAsset. A render failure must not break the price cards.
    try {
      state.chart = mountLikelyChart(els.chartMount, {
        snapshot,
        histories: state.history,
      });
    } catch (chartError) {
      console.error(chartError);
    }

    try {
      state.scenarios = mountScenarioViz(els.scenarioMount, { snapshot });
    } catch (scenarioError) {
      console.error(scenarioError);
    }

    await selectAsset(state.asset, 'boot');
    startLiveRefresh();

    // The ticker and the compare mode need every coin, so the rest of the
    // histories stream in behind the first paint and refresh what depends on them.
    Promise.all(
      Object.keys(snapshot.assets ?? {}).map((a) =>
        state.history[a]
          ? null
          : loadHistory(a).then((h) => { state.history[a] = h; }).catch(() => {}),
      ),
    ).then(() => {
      renderTicker();
      state.chart?.refresh();
    });
  } catch (error) {
    console.error(error);
    setStatus('error', 'No se pudieron cargar los datos. Intenta de nuevo en unos minutos.');
    els.price.textContent = 'Sin datos';
  }
}

init();
