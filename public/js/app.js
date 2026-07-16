// LikelyCoin — dashboard (Front-UX, tasks 1.7 / 1.8)
// Data flow: /api/latest (Blobs-backed function) with fallback to the static
// seed /data/latest.json; 30-day history from /api/history with the static
// /data/history/<asset>.json build seed as fallback.

const TIMEZONE = 'America/Mexico_City';
const STALE_AFTER_MS = 2 * 60 * 60 * 1000; // >2h without ingestion = stale
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

  const next = new Date();
  next.setMinutes(0, 0, 0);
  next.setHours(next.getHours() + 1);
  els.nextUpdate.textContent = `${timeFmt.format(next)} (CDMX)`;
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

  const labels = history.points.map((p) => p.timestamp);
  const data = history.points.map((p) => p.price);

  if (state.chart) state.chart.destroy();
  const styles = getComputedStyle(document.documentElement);
  const accent = styles.getPropertyValue('--accent').trim();
  const muted = styles.getPropertyValue('--muted').trim();
  const grid = styles.getPropertyValue('--chart-grid').trim();
  const surface = styles.getPropertyValue('--surface-raised').trim();
  const text = styles.getPropertyValue('--text').trim();

  state.chart = new Chart(document.getElementById('chart'), {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Precio real',
        data,
        borderColor: accent,
        backgroundColor: 'rgba(105, 230, 178, 0.06)',
        borderWidth: 2.5,
        fill: true,
        pointRadius: 0,
        tension: 0.2,
        spanGaps: true, // tolerate ingestion gaps (R-11)
      }],
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
            label: (item) => priceFmt.format(item.parsed.y),
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

function selectAsset(asset) {
  state.asset = asset;
  for (const tab of els.tabs) {
    const active = tab.dataset.asset === asset;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  }
  renderPrice();
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
