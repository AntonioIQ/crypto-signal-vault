// LikelyCoin — bespoke SVG chart (Aurora): line/candle modes, forecast, hover.
// No charting library: pure SVG for a light bundle and full control. Candles are
// bucketed by calendar day from the real hourly history (honest OHLC), the
// forecast is the anchored 48h path, both from the public snapshot/history.

const W = 720;
const H = 330;
const PAD = { l: 8, r: 8, t: 14 };
const PRICE_H = 214;
const VOL_TOP = 240;
const VOL_H = 72;

const priceFmt = new Intl.NumberFormat('es-MX', {
  style: 'currency', currency: 'USD', maximumFractionDigits: 0,
});

function toCandles(points) {
  const byDay = new Map();
  for (const p of points) {
    if (typeof p?.price !== 'number' || typeof p?.timestamp !== 'string') continue;
    const day = p.timestamp.slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(p.price);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, ps]) => ({
      day, o: ps[0], c: ps[ps.length - 1], h: Math.max(...ps), l: Math.min(...ps),
    }));
}

function forecastPath(snapshot, asset) {
  const fc = snapshot?.forecast;
  if (!fc || !['fresh', 'stale'].includes(fc.status)) return null;
  const item = fc.assets?.[asset];
  const anchor = snapshot?.assets?.[asset]?.price;
  if (!item?.points?.length || typeof anchor !== 'number') return null;
  return { anchor, prices: item.points.map((p) => p.price), direction: item.direction, status: fc.status };
}

export function initLikelyChart(root, { snapshot, histories }) {
  root.classList.add('lk');
  root.innerHTML = `
    <div class="lk-head">
      <div class="lk-tabs" role="tablist">
        <button class="lk-tab active" data-asset="btc">BTC</button>
        <button class="lk-tab" data-asset="eth">ETH</button>
      </div>
      <div class="lk-modes">
        <button class="lk-mode" data-mode="line">Línea</button>
        <button class="lk-mode active" data-mode="candle">Velas</button>
      </div>
    </div>
    <div class="lk-price"><span class="lk-now">—</span><span class="lk-chg"></span></div>
    <div class="lk-legend">
      <button class="lk-chip on" data-series="fc"><span class="sw sw-fc"></span>Pronóstico 48 h</button>
    </div>
    <div class="lk-cw">
      <svg class="lk-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Gráfica de precio y pronóstico"></svg>
      <div class="lk-tip" hidden></div>
    </div>`;

  const svg = root.querySelector('.lk-svg');
  const tip = root.querySelector('.lk-tip');
  const nowEl = root.querySelector('.lk-now');
  const chgEl = root.querySelector('.lk-chg');
  const state = { asset: 'btc', mode: 'candle', showFc: true };

  function scales(asset) {
    const hist = histories[asset]?.points ?? [];
    const candles = toCandles(hist);
    const fc = state.showFc ? forecastPath(snapshot, asset) : null;
    const NC = candles.length;
    const NH = hist.length;
    const fcN = fc ? fc.prices.length : 0;
    const prices = [
      ...hist.map((p) => p.price),
      ...candles.flatMap((c) => [c.h, c.l]),
      ...(fc ? [fc.anchor, ...fc.prices] : []),
    ].filter((v) => typeof v === 'number');
    const lo = Math.min(...prices) * 0.995;
    const hi = Math.max(...prices) * 1.005;
    const iw = W - PAD.l - PAD.r;
    const total = state.mode === 'candle' ? NC + fcN / 6 : NH + fcN;
    return {
      hist, candles, fc, NC, NH, fcN, lo, hi, total,
      X: (i) => PAD.l + (i / (total - 1)) * iw,
      Y: (v) => PAD.t + PRICE_H - ((v - lo) / (hi - lo)) * PRICE_H,
    };
  }

  function draw(animate) {
    const s = scales(state.asset);
    svg._s = s;
    const { X, Y, lo } = s;
    let grid = '';
    for (let g = 0; g <= 3; g += 1) {
      const y = PAD.t + (PRICE_H / 3) * g;
      grid += `<line class="lk-grid" x1="${PAD.l}" y1="${y}" x2="${W - PAD.r}" y2="${y}"/>`;
    }
    let body = '';
    if (state.mode === 'line') {
      const line = (arr, off) => arr.map((v, i) => (i ? 'L' : 'M') + X(i + off).toFixed(1) + ' ' + Y(v).toFixed(1)).join(' ');
      const rp = line(s.hist.map((p) => p.price), 0);
      body += `<path class="lk-area" fill="var(--lk-accent)" d="${rp} L ${X(s.NH - 1)} ${Y(lo)} L ${X(0)} ${Y(lo)} Z"/>`;
      body += `<path class="lk-real" d="${rp}"/>`;
      if (s.fc) {
        const fp = [s.fc.anchor, ...s.fc.prices].map((v, i) => (i ? 'L' : 'M') + X(s.NH - 1 + i).toFixed(1) + ' ' + Y(v).toFixed(1)).join(' ');
        body += `<path class="lk-fc" d="${fp}"/>`;
      }
    } else {
      const cw = (W - PAD.l - PAD.r) / s.total * 0.6;
      s.candles.forEach((c, i) => {
        const up = c.c >= c.o;
        const col = `var(--lk-${up ? 'up' : 'down'})`;
        const x = X(i);
        body += `<line class="lk-wick" x1="${x}" y1="${Y(c.h)}" x2="${x}" y2="${Y(c.l)}" stroke="${col}"/>`;
        body += `<rect class="lk-body" x="${(x - cw / 2).toFixed(1)}" width="${cw.toFixed(1)}" y="${Math.min(Y(c.o), Y(c.c)).toFixed(1)}" height="${Math.max(2, Math.abs(Y(c.o) - Y(c.c))).toFixed(1)}" fill="${col}" rx="1" style="transition-delay:${i * 14}ms"/>`;
      });
      if (s.fc) {
        const fp = [s.fc.anchor, ...s.fc.prices].map((v, i) => (i ? 'L' : 'M') + X(s.NC - 1 + i / 6).toFixed(1) + ' ' + Y(v).toFixed(1)).join(' ');
        body += `<path class="lk-fc" d="${fp}"/>`;
      }
    }
    svg.innerHTML = `${grid}${body}
      <line class="lk-cross" x1="0" y1="${PAD.t}" x2="0" y2="${PAD.t + PRICE_H}"/>
      <circle class="lk-dot" r="4" fill="var(--lk-accent)"/>`;

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

    const live = snapshot?.assets?.[state.asset]?.price;
    const hist = s.hist;
    nowEl.textContent = typeof live === 'number' ? priceFmt.format(live) : '—';
    if (hist.length > 25) {
      const chg = ((hist.at(-1).price - hist.at(-25).price) / hist.at(-25).price) * 100;
      chgEl.textContent = `${chg >= 0 ? '▲ ' : '▼ '}${Math.abs(chg).toFixed(1)} %`;
      chgEl.className = `lk-chg ${chg >= 0 ? 'up' : 'down'}`;
    }
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
        label = `<span class="d">${c.day} · O ${priceFmt.format(c.o)} C ${priceFmt.format(c.c)}<br>H ${priceFmt.format(c.h)} L ${priceFmt.format(c.l)}</span>`;
      } else {
        v = s.fc ? s.fc.prices[Math.min(s.fc.prices.length - 1, Math.round((i - s.NC + 1) * 6))] : s.candles.at(-1).c;
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
    cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.style.opacity = 0.6;
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

  root.querySelectorAll('.lk-tab').forEach((t) => t.addEventListener('click', () => {
    root.querySelectorAll('.lk-tab').forEach((x) => x.classList.remove('active'));
    t.classList.add('active'); state.asset = t.dataset.asset; draw(true);
  }));
  root.querySelectorAll('.lk-mode').forEach((m) => m.addEventListener('click', () => {
    root.querySelectorAll('.lk-mode').forEach((x) => x.classList.remove('active'));
    m.classList.add('active'); state.mode = m.dataset.mode; draw(true);
  }));
  root.querySelectorAll('.lk-chip').forEach((c) => c.addEventListener('click', () => {
    state.showFc = !state.showFc; c.classList.toggle('on', state.showFc); draw(false);
  }));

  draw(true);
}
