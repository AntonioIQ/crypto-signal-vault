// LikelyCoin — bespoke SVG chart (no charting library). Chart-only component:
// the dashboard owns the coin tabs and the price; this renders the chart with
// Línea / Velas / Comparar modes, a forecast on/off toggle, a volume toggle and
// a daily-range band toggle, plus a 24h stats strip.
//
// Candles are real daily OHLC bucketed from the hourly history. "Comparar"
// normalizes any set of coins to percent-from-day-0 so coins priced $65,000 and
// $0.0000005 can share one axis, and each one can show its own 48h forecast as a
// dashed line in its own color. Colors come from the site CSS variables.

import { fmtPrice, fmtCompact, fmtPct } from './format.js';

const W = 720;
const H = 300;
const PAD = { l: 8, r: 8, t: 14 };
const PRICE_H = 240;
const MAX_COMPARE = 4;

// Series colors, in assignment order. Green stays first: it is the site's
// "real data" color and the compare lines are all real measured history.
const SERIES_COLORS = ['--accent', '--compare-2', '--compare-3', '--forecast'];

const dayFmt = new Intl.DateTimeFormat('es-MX', {
  timeZone: 'America/Mexico_City', day: 'numeric', month: 'short',
});

function sortedValid(points) {
  return (Array.isArray(points) ? points : [])
    .filter((p) => typeof p?.price === 'number' && Number.isFinite(p.price) && typeof p?.timestamp === 'string')
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

function toCandles(points) {
  const byDay = new Map();
  for (const p of points) {
    if (typeof p?.price !== 'number' || typeof p?.timestamp !== 'string') continue;
    const day = p.timestamp.slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, { prices: [], volume: 0, hasVolume: false });
    const bucket = byDay.get(day);
    bucket.prices.push(p.price);
    if (typeof p.volume === 'number' && Number.isFinite(p.volume)) {
      bucket.volume += p.volume;
      bucket.hasVolume = true;
    }
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, b]) => ({
      day, o: b.prices[0], c: b.prices[b.prices.length - 1],
      h: Math.max(...b.prices), l: Math.min(...b.prices),
      volume: b.hasVolume ? b.volume : null,
    }));
}

// 24h stats derived from our own hourly history — no extra API call. Volume uses
// the latest point, which is CoinGecko's rolling 24h figure (summing samples
// would multiply it), so this stays honest.
export function stats24h(points) {
  const valid = sortedValid(points);
  if (valid.length < 2) return null;
  const lastT = Date.parse(valid.at(-1).timestamp);
  if (!Number.isFinite(lastT)) return null;
  const win = valid.filter((p) => Date.parse(p.timestamp) >= lastT - 24 * 3_600_000);
  if (win.length < 2) return null;
  const prices = win.map((p) => p.price);
  const first = win[0].price;
  const last = win.at(-1).price;
  const lastVol = valid.at(-1).volume;
  return {
    changePct: ((last - first) / first) * 100,
    high: Math.max(...prices),
    low: Math.min(...prices),
    volume: typeof lastVol === 'number' && Number.isFinite(lastVol) ? lastVol : null,
  };
}

// Percent from the first point of the window: the only fair way to overlay
// coins whose absolute prices differ by orders of magnitude.
export function rebasedPct(points) {
  const valid = sortedValid(points);
  if (valid.length < 2) return null;
  const base = valid[0].price;
  if (!(base > 0)) return null;
  return { base, values: valid.map((p) => (p.price / base - 1) * 100) };
}

function forecastPath(snapshot, asset) {
  const fc = snapshot?.forecast;
  if (!fc || !['fresh', 'stale'].includes(fc.status)) return null;
  const item = fc.assets?.[asset];
  const anchor = snapshot?.assets?.[asset]?.price;
  if (!item?.points?.length || typeof anchor !== 'number') return null;
  return { anchor, prices: item.points.map((p) => p.price), status: fc.status };
}

export function mountLikelyChart(container, { snapshot, histories }) {
  container.classList.add('lk');
  container.innerHTML = `
    <div class="lk-controls">
      <div class="lk-modes" role="tablist" aria-label="Tipo de gráfica">
        <button class="lk-mode" data-mode="line" role="tab">Línea</button>
        <button class="lk-mode active" data-mode="candle" role="tab" aria-selected="true">Velas</button>
        <button class="lk-mode" data-mode="compare" role="tab">Comparar</button>
      </div>
      <button class="lk-fc-toggle on" data-toggle="fc" aria-pressed="true"><span class="lk-fc-sw"></span>Pronóstico 48 h</button>
      <button class="lk-fc-toggle lk-vol-toggle on" data-toggle="vol" aria-pressed="true"><span class="lk-vol-sw"></span>Volumen</button>
      <button class="lk-fc-toggle lk-rng-toggle" data-toggle="rng" aria-pressed="false"><span class="lk-vol-sw"></span>Rango diario</button>
    </div>
    <div class="lk-compare-row" hidden>
      <span class="lk-compare-label">Comparar</span>
      <div class="lk-compare-chips"></div>
      <span class="lk-compare-hint"><span class="lk-dash-sw"></span>Pronóstico de cada moneda</span>
    </div>
    <div class="lk-stats" aria-live="polite"></div>
    <div class="lk-cw">
      <svg class="lk-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Gráfica de precio y pronóstico"></svg>
      <div class="lk-tip" hidden></div>
    </div>
    <div class="lk-legend"></div>
    <p class="lk-note chart-note"></p>`;

  const svg = container.querySelector('.lk-svg');
  const tip = container.querySelector('.lk-tip');
  const note = container.querySelector('.lk-note');
  const statsEl = container.querySelector('.lk-stats');
  const legendEl = container.querySelector('.lk-legend');
  const compareRow = container.querySelector('.lk-compare-row');
  const chipsEl = container.querySelector('.lk-compare-chips');

  const state = {
    asset: 'btc',
    mode: 'candle',
    showFc: true,
    showVol: true,
    showRange: false,
    compare: new Set(),
    compareForecast: new Set(),
  };

  const assetsMeta = () => snapshot?.assets ?? {};
  const symbolOf = (a) => assetsMeta()[a]?.symbol ?? a.toUpperCase();
  const cssColor = (name) => (name.startsWith('--') ? `var(${name})` : name);

  // The coin currently selected always takes the green so it matches its own
  // price card; the rest keep a stable color from the sorted order.
  function compareColors() {
    const sorted = [...state.compare].sort();
    const ordered = sorted.includes(state.asset)
      ? [state.asset, ...sorted.filter((a) => a !== state.asset)]
      : sorted;
    const map = new Map();
    ordered.forEach((a, i) => map.set(a, cssColor(SERIES_COLORS[i % SERIES_COLORS.length])));
    return map;
  }

  function ensureCompareDefaults() {
    if (state.compare.size > 0) return;
    const all = Object.keys(assetsMeta());
    const seed = [state.asset, ...all.filter((a) => a !== state.asset)].slice(0, 3);
    for (const a of seed) {
      if (histories[a]) {
        state.compare.add(a);
        state.compareForecast.add(a);
      }
    }
  }

  function chip(label, value, cls = '') {
    return `<span class="lk-chip"><span class="lk-chip-k">${label}</span><span class="lk-chip-v ${cls}">${value}</span></span>`;
  }

  function renderChips() {
    const colors = compareColors();
    const all = Object.keys(assetsMeta());
    chipsEl.innerHTML = all.map((a) => {
      const on = state.compare.has(a);
      const fcOn = state.compareForecast.has(a);
      const color = colors.get(a);
      const style = on ? `background:color-mix(in srgb, ${color} 16%, transparent); color:${color};` : '';
      return `<button type="button" class="lk-cchip${on ? ' on' : ''}" data-coin="${a}" aria-pressed="${on}" style="${style}">` +
        `<b>${on ? '●' : '○'}</b>${symbolOf(a)}` +
        (on
          ? `<span class="lk-cfc${fcOn ? ' on' : ''}" data-fc="${a}" role="switch" aria-checked="${fcOn}" title="Mostrar u ocultar el pronóstico de ${symbolOf(a)}"><span class="lk-dash-sw"></span>48 h</span>`
          : '') +
        `</button>`;
    }).join('');
  }

  function renderStats() {
    if (state.mode === 'compare') { statsEl.innerHTML = ''; return; }
    const s = stats24h(histories[state.asset]?.points ?? []);
    if (!s) { statsEl.innerHTML = ''; return; }
    statsEl.innerHTML = [
      chip('24 h', fmtPct(s.changePct), s.changePct >= 0 ? 'up' : 'down'),
      chip('Máx 24 h', fmtPrice(s.high)),
      chip('Mín 24 h', fmtPrice(s.low)),
      s.volume != null ? chip('Vol 24 h', fmtCompact(s.volume)) : '',
    ].join('');
  }

  function scales() {
    const hist = histories[state.asset]?.points ?? [];
    const candles = toCandles(hist);
    const fc = state.showFc ? forecastPath(snapshot, state.asset) : null;
    const NH = hist.length;
    const NC = candles.length;
    const fcN = fc ? fc.prices.length : 0;
    const prices = [
      ...hist.map((p) => p.price),
      ...candles.flatMap((c) => [c.h, c.l]),
      ...(fc ? [fc.anchor, ...fc.prices] : []),
    ].filter((v) => typeof v === 'number');
    if (!prices.length) return null;
    const lo = Math.min(...prices) * 0.995;
    const hi = Math.max(...prices) * 1.005;
    const iw = W - PAD.l - PAD.r;
    const total = state.mode === 'candle' ? NC + fcN / 6 : NH + fcN;

    const hasVolume = hist.some((p) => typeof p.volume === 'number');
    const showVolBand = state.showVol && hasVolume;
    const priceH = showVolBand ? 190 : PRICE_H;
    const volTop = PAD.t + priceH + 14;
    const volH = showVolBand ? H - volTop - 2 : 0;
    const maxVol = showVolBand
      ? Math.max(1, ...(state.mode === 'candle'
        ? candles.map((c) => c.volume ?? 0)
        : hist.map((p) => p.volume ?? 0)))
      : 1;

    return {
      hist, candles, fc, NH, NC, fcN, lo, total, hasVolume, showVolBand,
      priceH, volTop, volH, maxVol,
      X: (i) => PAD.l + (i / (total - 1)) * iw,
      Y: (v) => PAD.t + priceH - ((v - lo) / (hi - lo)) * priceH,
      VY: (vol) => volTop + volH - (vol / maxVol) * volH,
    };
  }

  // Every selected coin as percent-from-day-0, plus (optionally) its own 48h
  // forecast continued from its last real point in the same units.
  function compareScales() {
    const colors = compareColors();
    const series = [];
    for (const asset of [...state.compare].sort()) {
      const reb = rebasedPct(histories[asset]?.points ?? []);
      if (!reb) continue;
      const entry = {
        asset,
        symbol: symbolOf(asset),
        color: colors.get(asset),
        values: reb.values,
        forecast: null,
      };
      if (state.compareForecast.has(asset)) {
        const fc = forecastPath(snapshot, asset);
        if (fc) {
          // The dashed line continues from the coin's last measured percent,
          // scaled by the forecast's own returns against its anchor price.
          const lastPct = reb.values.at(-1);
          entry.forecast = fc.prices.map(
            (p) => lastPct + ((p / fc.anchor) - 1) * 100,
          );
        }
      }
      series.push(entry);
    }
    if (!series.length) return null;

    const maxHist = Math.max(...series.map((s) => s.values.length));
    const maxFc = Math.max(0, ...series.map((s) => s.forecast?.length ?? 0));
    const all = series.flatMap((s) => [...s.values, ...(s.forecast ?? [])]);
    const lo = Math.min(...all, 0);
    const hi = Math.max(...all, 0);
    const padY = (hi - lo) * 0.08 || 1;
    const iw = W - PAD.l - PAD.r;
    const priceH = PRICE_H;
    // Histories can differ by a point or two; map each series onto the same
    // 0..1 span so they start and end together, then reserve the tail for the
    // forecast horizon.
    const fcSpan = maxFc > 0 ? 0.16 : 0;
    return {
      series, maxHist, maxFc, priceH,
      lo: lo - padY,
      hi: hi + padY,
      XH: (i, n) => PAD.l + (n > 1 ? (i / (n - 1)) * iw * (1 - fcSpan) : 0),
      XF: (i, n) => PAD.l + iw * (1 - fcSpan) + (n > 1 ? ((i + 1) / n) * iw * fcSpan : 0),
      Y: (v) => PAD.t + priceH - ((v - (lo - padY)) / ((hi + padY) - (lo - padY))) * priceH,
    };
  }

  function drawCompare(animate) {
    const s = compareScales();
    svg._s = null; svg._c = s;
    legendEl.innerHTML = '';
    if (!s) {
      svg.innerHTML = '';
      note.textContent = 'Elige al menos una moneda para comparar.';
      return;
    }
    let grid = '';
    for (let g = 0; g <= 3; g += 1) {
      const y = PAD.t + (s.priceH / 3) * g;
      grid += `<line class="lk-grid" x1="${PAD.l}" y1="${y}" x2="${W - PAD.r}" y2="${y}"/>`;
    }
    const yZero = s.Y(0);
    grid += `<line class="lk-base" x1="${PAD.l}" y1="${yZero.toFixed(1)}" x2="${W - PAD.r}" y2="${yZero.toFixed(1)}"/>`;

    let body = '';
    for (const serie of s.series) {
      const n = serie.values.length;
      const d = serie.values
        .map((v, i) => `${i ? 'L' : 'M'}${s.XH(i, n).toFixed(1)} ${s.Y(v).toFixed(1)}`)
        .join(' ');
      body += `<path class="lk-cmp" d="${d}" stroke="${serie.color}"/>`;
      if (serie.forecast?.length) {
        const fn = serie.forecast.length;
        const start = `M${s.XH(n - 1, n).toFixed(1)} ${s.Y(serie.values.at(-1)).toFixed(1)}`;
        const fd = serie.forecast
          .map((v, i) => `L${s.XF(i, fn).toFixed(1)} ${s.Y(v).toFixed(1)}`)
          .join(' ');
        body += `<path class="lk-cmp-fc" d="${start} ${fd}" stroke="${serie.color}"/>`;
      }
    }

    svg.innerHTML = `${grid}${body}
      <line class="lk-cross" x1="0" y1="${PAD.t}" x2="0" y2="${PAD.t + s.priceH}"/>`;

    legendEl.innerHTML = s.series.map((serie) => {
      const last = serie.values.at(-1);
      const cls = last >= 0 ? 'up' : 'down';
      return `<span class="lk-leg"><span class="lk-leg-sw" style="background:${serie.color}"></span>` +
        `${serie.symbol}<b class="${cls}">${fmtPct(last)}</b></span>`;
    }).join('') +
      '<span class="lk-leg-note">Línea sólida: 30 días medidos · punteada: pronóstico 48 h de esa misma moneda</span>';

    if (animate) {
      requestAnimationFrame(() => {
        svg.querySelectorAll('.lk-cmp').forEach((p, k) => {
          const L = p.getTotalLength();
          p.style.strokeDasharray = L; p.style.strokeDashoffset = L; p.getBoundingClientRect();
          p.style.transition = `stroke-dashoffset 1s cubic-bezier(.6,0,.2,1) ${k * 110}ms`;
          p.style.strokeDashoffset = 0;
        });
      });
    }
    note.textContent = 'Todas rebasadas a 0 % hace 30 días: la línea más alta es la que más rindió. No es una recomendación.';
  }

  function draw(animate) {
    renderStats();
    compareRow.hidden = state.mode !== 'compare';
    container.classList.toggle('lk-compare', state.mode === 'compare');
    if (state.mode === 'compare') {
      ensureCompareDefaults();
      renderChips();
      drawCompare(animate);
      return;
    }
    legendEl.innerHTML = '';
    const s = scales();
    svg._s = s; svg._c = null;
    if (!s) { svg.innerHTML = ''; note.textContent = 'Aún no hay datos para graficar.'; return; }
    const { X, Y, lo } = s;
    let grid = '';
    for (let g = 0; g <= 3; g += 1) {
      const y = PAD.t + (s.priceH / 3) * g;
      grid += `<line class="lk-grid" x1="${PAD.l}" y1="${y}" x2="${W - PAD.r}" y2="${y}"/>`;
    }
    // Daily high-low volatility band (line mode only).
    let band = '';
    if (state.showRange && state.mode === 'line' && s.candles.length > 1) {
      const step = (s.NH - 1) / (s.candles.length - 1);
      const top = s.candles.map((c, i) => (i ? 'L' : 'M') + X(i * step).toFixed(1) + ' ' + Y(c.h).toFixed(1)).join(' ');
      const bottom = s.candles.map((c, i) => 'L' + X((s.candles.length - 1 - i) * step).toFixed(1) + ' ' + Y(s.candles[s.candles.length - 1 - i].l).toFixed(1)).join(' ');
      band = `<path class="lk-band" d="${top} ${bottom} Z"/>`;
    }
    let body = '';
    if (state.mode === 'line') {
      const pts = s.hist.map((p) => p.price);
      const rp = pts.map((v, i) => (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1)).join(' ');
      body += `<path class="lk-area" d="${rp} L ${X(s.NH - 1)} ${Y(lo)} L ${X(0)} ${Y(lo)} Z"/>`;
      body += `<path class="lk-real" d="${rp}"/>`;
      if (s.fc) {
        const fp = [s.fc.anchor, ...s.fc.prices].map((v, i) => (i ? 'L' : 'M') + X(s.NH - 1 + i).toFixed(1) + ' ' + Y(v).toFixed(1)).join(' ');
        body += `<path class="lk-fc" d="${fp}"/>`;
      }
    } else {
      const cw = (W - PAD.l - PAD.r) / s.total * 0.6;
      s.candles.forEach((c, i) => {
        const up = c.c >= c.o;
        const col = up ? 'var(--accent)' : 'var(--chart-down)';
        const x = X(i);
        body += `<line class="lk-wick" x1="${x}" y1="${Y(c.h)}" x2="${x}" y2="${Y(c.l)}" stroke="${col}"/>`;
        body += `<rect class="lk-body" x="${(x - cw / 2).toFixed(1)}" width="${cw.toFixed(1)}" y="${Math.min(Y(c.o), Y(c.c)).toFixed(1)}" height="${Math.max(2, Math.abs(Y(c.o) - Y(c.c))).toFixed(1)}" fill="${col}" rx="1" style="transition-delay:${i * 14}ms"/>`;
      });
      if (s.fc) {
        const fp = [s.fc.anchor, ...s.fc.prices].map((v, i) => (i ? 'L' : 'M') + X(s.NC - 1 + i / 6).toFixed(1) + ' ' + Y(v).toFixed(1)).join(' ');
        body += `<path class="lk-fc" d="${fp}"/>`;
      }
    }
    let vol = '';
    if (s.showVolBand) {
      const baseY = s.volTop + s.volH;
      if (state.mode === 'candle') {
        const cw = (W - PAD.l - PAD.r) / s.total * 0.6;
        s.candles.forEach((c, i) => {
          if (c.volume == null) return;
          const col = c.c >= c.o ? 'var(--accent)' : 'var(--chart-down)';
          const y = s.VY(c.volume);
          vol += `<rect class="lk-vol" x="${(X(i) - cw / 2).toFixed(1)}" width="${cw.toFixed(1)}" y="${y.toFixed(1)}" height="${Math.max(1, baseY - y).toFixed(1)}" fill="${col}"/>`;
        });
      } else {
        const bw = Math.max(1, (W - PAD.l - PAD.r) / s.NH * 0.55);
        s.hist.forEach((p, i) => {
          if (typeof p.volume !== 'number') return;
          const col = i > 0 && p.price < s.hist[i - 1].price ? 'var(--chart-down)' : 'var(--accent)';
          const y = s.VY(p.volume);
          vol += `<rect class="lk-vol" x="${(X(i) - bw / 2).toFixed(1)}" width="${bw.toFixed(1)}" y="${y.toFixed(1)}" height="${Math.max(0.5, baseY - y).toFixed(1)}" fill="${col}"/>`;
        });
      }
    }

    svg.innerHTML = `${grid}${band}${vol}${body}
      <line class="lk-cross" x1="0" y1="${PAD.t}" x2="0" y2="${PAD.t + s.priceH}"/>
      <circle class="lk-dot" r="4"/>`;

    if (animate) {
      requestAnimationFrame(() => {
        svg.querySelectorAll('.lk-body').forEach((b) => {
          b.style.transform = 'scaleY(0)'; b.getBoundingClientRect(); b.style.transform = 'scaleY(1)';
        });
        const rp = svg.querySelector('.lk-real');
        if (rp) {
          const L = rp.getTotalLength();
          rp.style.strokeDasharray = L; rp.style.strokeDashoffset = L; rp.getBoundingClientRect();
          rp.style.transition = 'stroke-dashoffset 1.1s cubic-bezier(.6,0,.2,1)'; rp.style.strokeDashoffset = 0;
        }
        const fp = svg.querySelector('.lk-fc');
        if (fp) { fp.style.opacity = 0; setTimeout(() => { fp.style.opacity = 1; }, state.mode === 'candle' ? 600 : 950); }
      });
    }

    const assetName = snapshot?.assets?.[state.asset]?.name ?? state.asset.toUpperCase();
    note.textContent = s.fc
      ? `La línea punteada muestra el recorrido estimado de ${assetName} a 48 h; no es una garantía.`
      : 'El precio real sigue disponible. La línea punteada aparecerá cuando exista un pronóstico válido.';
  }

  svg.addEventListener('mousemove', (e) => {
    const r = svg.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width * W;
    const c = svg._c;
    if (c) { // compare mode
      const f = Math.max(0, Math.min(1, (px - PAD.l) / (W - PAD.l - PAD.r)));
      const cx = PAD.l + f * (W - PAD.l - PAD.r);
      const cross = svg.querySelector('.lk-cross');
      cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.style.opacity = 0.55;
      const rows = c.series.map((serie) => {
        const n = serie.values.length;
        const i = Math.max(0, Math.min(n - 1, Math.round(f * (n - 1))));
        const v = serie.values[i];
        return `<span class="d"><span class="lk-leg-sw" style="background:${serie.color}"></span>${serie.symbol} ${fmtPct(v)}</span>`;
      }).join('');
      tip.hidden = false;
      tip.innerHTML = rows;
      tip.style.left = `${cx / W * r.width}px`;
      tip.style.top = `${c.Y(Math.max(...c.series.map((s2) => s2.values.at(-1)))) / H * r.height}px`;
      return;
    }
    const s = svg._s; if (!s) return;
    let i = Math.round(((px - PAD.l) / (W - PAD.l - PAD.r)) * (s.total - 1));
    i = Math.max(0, Math.min(s.total - 1, i));
    let v; let label; let cls = '';
    if (state.mode === 'candle') {
      if (i < s.NC) {
        const cd = s.candles[i]; const up = cd.c >= cd.o; v = cd.c; cls = up ? 'up' : 'down';
        label = `<span class="d">${dayFmt.format(new Date(cd.day))} · O ${fmtPrice(cd.o)} C ${fmtPrice(cd.c)}<br>H ${fmtPrice(cd.h)} L ${fmtPrice(cd.l)}</span>`;
      } else {
        v = s.fc ? s.fc.prices[Math.min(s.fc.prices.length - 1, Math.round((i - s.NC + 1) * 6))] : s.candles.at(-1)?.c;
        label = '<span class="d fc">pronóstico</span>';
      }
    } else {
      const isFc = i >= s.NH;
      v = isFc && s.fc ? s.fc.prices[Math.min(s.fc.prices.length - 1, i - s.NH)] : s.hist[Math.min(s.NH - 1, i)]?.price;
      label = `<span class="d ${isFc ? 'fc' : ''}">${isFc ? 'pronóstico' : ''}</span>`;
    }
    if (typeof v !== 'number') return;
    const cx = s.X(i); const cy = s.Y(v);
    const cross = svg.querySelector('.lk-cross'); const dot = svg.querySelector('.lk-dot');
    cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.style.opacity = 0.55;
    dot.setAttribute('cx', cx); dot.setAttribute('cy', cy); dot.style.opacity = 1;
    tip.hidden = false;
    tip.innerHTML = `<b class="${cls}">${fmtPrice(v)}</b>${label}`;
    tip.style.left = `${cx / W * r.width}px`;
    tip.style.top = `${cy / H * r.height}px`;
  });
  svg.addEventListener('mouseleave', () => {
    tip.hidden = true;
    const c = svg.querySelector('.lk-cross'); const d = svg.querySelector('.lk-dot');
    if (c) c.style.opacity = 0; if (d) d.style.opacity = 0;
  });

  container.querySelectorAll('.lk-mode').forEach((m) => m.addEventListener('click', () => {
    container.querySelectorAll('.lk-mode').forEach((x) => { x.classList.remove('active'); x.removeAttribute('aria-selected'); });
    m.classList.add('active'); m.setAttribute('aria-selected', 'true');
    state.mode = m.dataset.mode;
    draw(true);
  }));
  container.querySelectorAll('[data-toggle]').forEach((btn) => btn.addEventListener('click', () => {
    const key = { vol: 'showVol', rng: 'showRange', fc: 'showFc' }[btn.dataset.toggle];
    state[key] = !state[key];
    btn.classList.toggle('on', state[key]);
    btn.setAttribute('aria-pressed', String(state[key]));
    draw(false);
  }));

  // Coin chips: the "48 h" sub-chip toggles only that coin's forecast, so it
  // must not also toggle the coin itself.
  chipsEl.addEventListener('click', (event) => {
    const fcSwitch = event.target.closest('.lk-cfc');
    if (fcSwitch) {
      event.stopPropagation();
      const asset = fcSwitch.dataset.fc;
      if (state.compareForecast.has(asset)) state.compareForecast.delete(asset);
      else state.compareForecast.add(asset);
      renderChips();
      drawCompare(false);
      return;
    }
    const chipBtn = event.target.closest('.lk-cchip');
    if (!chipBtn) return;
    const asset = chipBtn.dataset.coin;
    if (state.compare.has(asset)) {
      state.compare.delete(asset);
      state.compareForecast.delete(asset);
    } else if (state.compare.size < MAX_COMPARE && histories[asset]) {
      state.compare.add(asset);
      state.compareForecast.add(asset);
    }
    renderChips();
    drawCompare(true);
  });

  draw(true);
  return {
    setAsset(asset) {
      state.asset = asset;
      if (state.mode === 'compare') { renderChips(); drawCompare(false); }
      else draw(true);
    },
    // Called once the remaining histories finish streaming in.
    refresh() { draw(false); },
  };
}
