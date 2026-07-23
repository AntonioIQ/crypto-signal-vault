// LikelyCoin — "Escenarios del modelo": a Galton-board animation of the model's
// own rolling-origin validation scenarios. Each ball falls through a peg field
// and settles in the bin of its REAL scenario value (terminal return of one
// out-of-sample fold), stacking into the true distribution — the balls are the
// data, not random draws, so the shape is the model's, not chance.
//
// Rendered on <canvas>: for dozens of balls animating per frame, canvas is the
// right tool. Honest: with no published scenarios it says so instead of drawing
// a fabricated shape.

const FLAT_THRESHOLD = 0.5; // percent, matches the model's tau
const DIR_LABEL = { up: 'una subida', down: 'una bajada', flat: 'un precio estable' };
const H = 250;

function pct(value) {
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)} %`;
}
function classify(returnPct) {
  if (returnPct >= FLAT_THRESHOLD) return 'up';
  if (returnPct <= -FLAT_THRESHOLD) return 'down';
  return 'flat';
}

export function mountScenarioViz(container, { snapshot }) {
  container.classList.add('sv');
  container.innerHTML = `
    <div class="sv-head">
      <p class="sv-conf"><span class="sv-value">—</span></p>
      <p class="sv-sub"></p>
    </div>
    <div class="sv-cw"><canvas class="sv-canvas" role="img" aria-label="Distribución de escenarios del modelo"></canvas></div>
    <p class="sv-note"></p>`;

  const canvas = container.querySelector('.sv-canvas');
  const wrap = container.querySelector('.sv-cw');
  const ctx = canvas.getContext('2d');
  const valueEl = container.querySelector('.sv-value');
  const subEl = container.querySelector('.sv-sub');
  const noteEl = container.querySelector('.sv-note');
  const state = { asset: 'btc' };
  let raf = null;

  function read() {
    const fc = snapshot?.forecast;
    if (!fc || !['fresh', 'stale'].includes(fc.status)) return null;
    const item = fc.assets?.[state.asset];
    const conf = item?.confidence;
    if (!conf || !Array.isArray(conf.scenarios) || conf.scenarios.length === 0) return null;
    return {
      direction: item.direction,
      value: conf.value,
      status: conf.status,
      sampleSize: conf.sample_size,
      scenarios: conf.scenarios.map((r) => r * 100),
    };
  }

  function cssColor(name, fallback) {
    const v = getComputedStyle(container).getPropertyValue(name).trim();
    return v || fallback;
  }

  function empty(message) {
    if (raf) cancelAnimationFrame(raf);
    valueEl.textContent = '—';
    valueEl.className = 'sv-value';
    subEl.textContent = 'De dónde saldría la confianza del modelo.';
    const w = wrap.clientWidth || 640;
    canvas.width = w; canvas.height = H;
    ctx.clearRect(0, 0, w, H);
    noteEl.textContent = message;
  }

  function run() {
    if (raf) cancelAnimationFrame(raf);
    const d = read();
    if (!d) {
      empty('La distribución aparecerá cuando el modelo publique sus escenarios de validación.');
      return;
    }

    const dirLabel = DIR_LABEL[d.direction] ?? 'un movimiento';
    if (d.status === 'available') {
      valueEl.textContent = `${Math.round(d.value)} %`;
      valueEl.className = `sv-value ${d.value >= 50 ? 'high' : d.value >= 20 ? 'mid' : 'low'}`;
      const agree = Math.round((d.value / 100) * d.sampleSize);
      subEl.textContent = `${agree} de ${d.sampleSize} escenarios de validación apuntan a ${dirLabel}.`;
    } else {
      valueEl.textContent = 'Aún no medible';
      valueEl.className = 'sv-value mid';
      subEl.textContent = `${d.sampleSize} escenarios medidos; con menos de 20 no se publica un porcentaje.`;
    }
    noteEl.innerHTML = 'Cada pelota es un escenario de validación real y cae en el resultado que midió el modelo; la línea marca el umbral de ±0.5 %. <b>La forma es la distribución real, no azar.</b>';

    // Canvas sizing (DPR-aware, responsive width).
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = wrap.clientWidth || 640;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.height = `${H}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Domain: zoom to the scenarios but keep 0 and ±0.5% visible.
    const dmin = Math.min(...d.scenarios);
    const dmax = Math.max(...d.scenarios);
    const pad = Math.max(0.5, (dmax - dmin) * 0.2);
    const lo = Math.min(-1, dmin - pad);
    const hi = Math.max(1, dmax + pad);
    const padX = 14;
    const iw = W - padX * 2;
    const X = (v) => padX + ((v - lo) / (hi - lo)) * iw;

    const bins = Math.min(29, Math.max(11, Math.round(iw / 22)));
    const bw = (hi - lo) / bins;
    const binOf = (v) => Math.max(0, Math.min(bins - 1, Math.floor((v - lo) / bw)));
    const binCenterX = (bi) => X(lo + (bi + 0.5) * bw);

    const baseY = H - 26;
    const r = Math.max(3, Math.min(6, iw / bins / 2.2));
    const step = r * 1.75;

    const accent = cssColor('--accent', '#4fe0b8');
    const down = cssColor('--chart-down', '#ff7a9c');
    const muted = cssColor('--muted', '#93a6b4');
    const grid = 'rgba(199,232,219,0.16)';
    const pegColor = 'rgba(199,232,219,0.14)';

    // Peg field (decorative Galton board).
    const pegTop = 34;
    const pegRows = 6;
    const pegGap = (baseY - 40 - pegTop) / pegRows;
    const pegs = [];
    for (let row = 0; row < pegRows; row += 1) {
      const y = pegTop + row * pegGap;
      const offset = (row % 2) * (iw / bins / 2);
      for (let x = padX + offset; x <= W - padX; x += iw / bins) {
        pegs.push({ x, y });
      }
    }

    const landed = new Array(bins).fill(0);
    const balls = d.scenarios.map((v) => {
      const cls = classify(v);
      const color = cls === d.direction ? accent : cls === 'flat' ? muted : down;
      return {
        v, bi: binOf(v), targetX: binCenterX(binOf(v)),
        x: W / 2, y: -r - Math.random() * 30, vy: 0, phase: Math.random() * Math.PI * 2,
        released: false, landed: false, color,
      };
    });

    const bg = () => {
      ctx.clearRect(0, 0, W, H);
      // axis + threshold guides
      ctx.strokeStyle = grid; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(padX, baseY + 1); ctx.lineTo(W - padX, baseY + 1); ctx.stroke();
      ctx.setLineDash([4, 4]); ctx.strokeStyle = 'rgba(147,166,180,0.5)';
      [-FLAT_THRESHOLD, FLAT_THRESHOLD].forEach((t) => {
        ctx.beginPath(); ctx.moveTo(X(t), pegTop - 8); ctx.lineTo(X(t), baseY); ctx.stroke();
      });
      ctx.setLineDash([]);
      // pegs
      ctx.fillStyle = pegColor;
      pegs.forEach((p) => { ctx.beginPath(); ctx.arc(p.x, p.y, 1.6, 0, Math.PI * 2); ctx.fill(); });
      // axis labels
      ctx.fillStyle = muted; ctx.font = '600 10px Inter, sans-serif'; ctx.textAlign = 'center';
      [Math.round(lo), 0, Math.round(hi)].forEach((t) => ctx.fillText(pct(t), X(t), baseY + 16));
    };

    let frame = 0;
    const tick = () => {
      bg();
      let moving = false;
      balls.forEach((b, i) => {
        if (!b.released && frame > i * 2) b.released = true;
        if (b.released && !b.landed) {
          moving = true;
          b.vy += 0.45;
          b.y += b.vy;
          // guide toward the real bin, with a Galton wobble that fades near the floor
          b.x += (b.targetX - b.x) * 0.07;
          const amp = Math.max(0, Math.min(1, (baseY - b.y) / 120)) * 2.2;
          b.x += Math.sin(b.y / 16 + b.phase) * amp;
          const restY = baseY - r - landed[b.bi] * step;
          if (b.y >= restY) { b.y = restY; b.x = b.targetX; b.landed = true; landed[b.bi] += 1; }
        }
        if (b.released) {
          ctx.beginPath();
          ctx.arc(b.x, b.y, r, 0, Math.PI * 2);
          ctx.fillStyle = b.color;
          ctx.fill();
        }
      });
      frame += 1;
      if (moving || frame < balls.length * 2 + 4) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }

  // Click to replay the drop.
  wrap.addEventListener('click', () => run());
  run();

  return {
    setAsset(asset) { state.asset = asset; run(); },
  };
}
