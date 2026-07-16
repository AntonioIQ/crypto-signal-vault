// Crypto Signal Vault — dashboard (Front-UX, tasks 1.7 / 1.8)
// Data flow: /api/latest (Blobs-backed function) with fallback to the static
// seed /data/latest.json; 30-day history from static /data/history/<asset>.json.

const TIMEZONE = 'America/Mexico_City';
const STALE_AFTER_MS = 2 * 60 * 60 * 1000; // >2h without ingestion = stale

const els = {
  banner: document.getElementById('status-banner'),
  statusText: document.getElementById('status-text'),
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

function change24h(history) {
  const points = history?.points ?? [];
  if (points.length < 2) return null;
  const last = points[points.length - 1];
  const target = new Date(last.timestamp).getTime() - 24 * 3_600_000;
  let previous = points[0];
  for (const point of points) {
    if (new Date(point.timestamp).getTime() > target) break;
    previous = point;
  }
  return ((last.price - previous.price) / previous.price) * 100;
}

function renderPrice() {
  const asset = state.snapshot?.assets?.[state.asset];
  const history = state.history[state.asset];
  els.assetName.textContent = asset?.name ?? state.asset.toUpperCase();

  // Live price when available; otherwise last history point (labeled stale upstream).
  const price = asset?.price ?? history?.points?.at(-1)?.price ?? null;
  els.price.textContent = price === null ? 'Sin datos' : priceFmt.format(price);

  const change = change24h(history);
  els.change.classList.remove('up', 'down');
  if (change === null) {
    els.change.textContent = '';
  } else {
    els.change.classList.add(change >= 0 ? 'up' : 'down');
    const arrow = change >= 0 ? '▲' : '▼';
    els.change.textContent = `${arrow} ${Math.abs(change).toFixed(1)} % en 24 h`;
  }
}

function renderChart() {
  const history = state.history[state.asset];
  if (!history?.points?.length) return;

  const labels = history.points.map((p) => p.timestamp);
  const data = history.points.map((p) => p.price);

  if (state.chart) state.chart.destroy();
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();

  state.chart = new Chart(document.getElementById('chart'), {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Precio real',
        data,
        borderColor: accent,
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.2,
        spanGaps: true, // tolerate ingestion gaps (R-11)
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => `${timeFmt.format(new Date(items[0].label))} (CDMX)`,
            label: (item) => priceFmt.format(item.parsed.y),
          },
        },
      },
      scales: {
        x: {
          ticks: {
            maxTicksLimit: 7,
            callback(value) {
              return dayFmt.format(new Date(this.getLabelForValue(value)));
            },
          },
          grid: { display: false },
        },
        y: {
          ticks: { callback: (value) => priceFmt.format(value) },
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
      fetchJson('data/history/btc.json'),
      fetchJson('data/history/eth.json'),
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
