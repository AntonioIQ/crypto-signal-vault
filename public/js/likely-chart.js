// LikelyCoin — bespoke SVG chart (no charting library). Chart-only component:
// the dashboard owns the BTC/ETH tabs and the price; this renders the chart
// with a Línea/Velas mode toggle, a forecast on/off toggle, and hover.
// Candles are real daily OHLC bucketed from the hourly history; the forecast is
// the anchored 48h path. Colors come from the site CSS variables so it matches
// the theme (real line/up = --accent, forecast/down = --forecast/--chart-down).

const W = 720;
const H = 300;
const PAD = { l: 8, r: 8, t: 14 };
const PRICE_H = 240;

const priceFmt = new Intl.NumberFormat('es-MX', {
  style: 'currency', currency: 'USD', maximumFractionDigits: 0,
});
const dayFmt = new Intl.DateTimeFormat('es-MX', {
  timeZone: 'America/Mexico_City', day: 'numeric', month: 'short',
});

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
      </div>
      <button class="lk-fc-toggle on" data-toggle="fc" aria-pressed="true"><span class="lk-fc-sw"></span>Pronóstico 48 h</button>
      <button class="lk-fc-toggle lk-vol-toggle on" data-toggle="vol" aria-pressed="true"><span class="lk-vol-sw"></span>Volumen</button>
    </div>
    <div class="lk-cw">
      <svg class="lk-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Gráfica de precio y pronóstico"></svg>
      <div class="lk-tip" hidden></div>
    </div>
    <p class="lk-note chart-note"></p>`;

  const svg = container.querySelector('.lk-svg');
  const tip = container.querySelector('.lk-tip');
  const note = container.querySelector('.lk-note');
  const state = { asset: 'btc', mode: 'candle', showFc: true, showVol: true };

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

  function draw(animate) {
    const s = scales();
    svg._s = s;
    if (!s) { svg.innerHTML = ''; note.textContent = 'Aún no hay datos para graficar.'; return; }
    const { X, Y, lo } = s;
    let grid = '';
    for (let g = 0; g <= 3; g += 1) {
      const y = PAD.t + (s.priceH / 3) * g;
      grid += `<line class="lk-grid" x1="${PAD.l}" y1="${y}" x2="${W - PAD.r}" y2="${y}"/>`;
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

    svg.innerHTML = `${grid}${vol}${body}
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
    const s = svg._s; if (!s) return;
    const r = svg.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width * W;
    let i = Math.round(((px - PAD.l) / (W - PAD.l - PAD.r)) * (s.total - 1));
    i = Math.max(0, Math.min(s.total - 1, i));
    let v; let label; let cls = '';
    if (state.mode === 'candle') {
      if (i < s.NC) {
        const c = s.candles[i]; const up = c.c >= c.o; v = c.c; cls = up ? 'up' : 'down';
        label = `<span class="d">${dayFmt.format(new Date(c.day))} · O ${priceFmt.format(c.o)} C ${priceFmt.format(c.c)}<br>H ${priceFmt.format(c.h)} L ${priceFmt.format(c.l)}</span>`;
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
    tip.innerHTML = `<b class="${cls}">${priceFmt.format(v)}</b>${label}`;
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
    state.mode = m.dataset.mode; draw(true);
  }));
  container.querySelectorAll('[data-toggle]').forEach((btn) => btn.addEventListener('click', () => {
    const key = btn.dataset.toggle === 'vol' ? 'showVol' : 'showFc';
    state[key] = !state[key];
    btn.classList.toggle('on', state[key]);
    btn.setAttribute('aria-pressed', String(state[key]));
    draw(false);
  }));

  draw(true);
  return {
    setAsset(asset) { state.asset = asset; draw(true); },
  };
}
