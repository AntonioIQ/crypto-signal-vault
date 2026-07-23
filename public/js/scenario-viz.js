// LikelyCoin — "Escenarios del modelo": the real distribution behind the
// confidence number. Each dot is one rolling-origin validation scenario
// (terminal return + one out-of-sample residual), read from
// snapshot.forecast.assets[asset].confidence.scenarios. Dots are binned into a
// dot-plot (a real histogram of the model's own scenarios) and animate into
// place. No charting library. Honest: if the model has not published scenarios
// yet, it says so instead of drawing a fabricated shape.

const W = 700;
const H = 210;
const PAD = { l: 12, r: 12, t: 14, b: 30 };
const FLAT_THRESHOLD = 0.5; // percent, matches the model's tau
const DIR_LABEL = { up: 'una subida', down: 'una bajada', flat: 'un precio estable' };

// d3-force powers the beeswarm settle (collision physics). Loaded from the
// vendored UMD bundles in dependency order; if it fails, the layout degrades to
// a plain stacked dot-plot so the distribution still renders.
const D3_MODULES = ['d3-dispatch', 'd3-quadtree', 'd3-timer', 'd3-force'];
let d3Promise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = false;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.append(script);
  });
}

function loadD3Force() {
  if (globalThis.d3?.forceSimulation) return Promise.resolve(globalThis.d3);
  if (d3Promise) return d3Promise;
  d3Promise = (async () => {
    for (const module of D3_MODULES) {
      await loadScript(`/js/vendor/${module}.min.js`);
    }
    if (!globalThis.d3?.forceSimulation) throw new Error('d3-force unavailable');
    return globalThis.d3;
  })();
  return d3Promise;
}

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
    <div class="sv-cw">
      <svg class="sv-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Distribución de escenarios del modelo"></svg>
    </div>
    <p class="sv-note"></p>`;

  const svg = container.querySelector('.sv-svg');
  const valueEl = container.querySelector('.sv-value');
  const subEl = container.querySelector('.sv-sub');
  const noteEl = container.querySelector('.sv-note');
  const state = { asset: 'btc' };

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
      scenarios: conf.scenarios.map((r) => r * 100), // to percent
    };
  }

  function empty(message) {
    valueEl.textContent = '—';
    valueEl.className = 'sv-value';
    subEl.textContent = 'De dónde saldría la confianza del modelo.';
    svg.innerHTML = '';
    noteEl.textContent = message;
  }

  function draw() {
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

    // Zoom to the scenario range but always keep zero and the ±0.5% threshold
    // in view, so the distribution fills the width instead of hugging one side.
    const dmin = Math.min(...d.scenarios);
    const dmax = Math.max(...d.scenarios);
    const pad = Math.max(0.5, (dmax - dmin) * 0.18);
    const lo = Math.min(-1, dmin - pad);
    const hi = Math.max(1, dmax + pad);
    const iw = W - PAD.l - PAD.r;
    const ih = H - PAD.t - PAD.b;
    const X = (v) => PAD.l + ((v - lo) / (hi - lo)) * iw;
    const axisY = PAD.t + ih;
    const dotR = Math.max(3, Math.min(5.5, 150 / d.scenarios.length + 3));

    const colorFor = (v) => {
      const cls = classify(v);
      if (cls === d.direction) return 'var(--accent)';
      return cls === 'flat' ? 'var(--muted)' : 'var(--chart-down)';
    };

    // Beeswarm via d3-force when available: strong pull to the value on X, a
    // gentle pull to a midline on Y, and collision so dots never overlap — the
    // density along X becomes the distribution. Fallback: a stacked dot-plot.
    const bins = 23;
    const bw = (hi - lo) / bins;
    const binCenterX = (v) => {
      const bi = Math.max(0, Math.min(bins - 1, Math.floor((v - lo) / bw)));
      return X(lo + (bi + 0.5) * bw);
    };

    const d3 = globalThis.d3;
    let placed;
    if (d3?.forceSimulation) {
      // d3-force builds the bell: each dot is pulled to its value's column on X
      // and down to the baseline on Y, and collision stacks same-column dots
      // upward — dense columns rise, forming the distribution with real physics.
      const baseline = axisY - dotR - 1;
      const nodes = d.scenarios.map((v) => ({ v, bx: binCenterX(v), x: binCenterX(v), y: baseline }));
      const sim = d3.forceSimulation(nodes)
        .force('x', d3.forceX((n) => n.bx).strength(1))
        .force('y', d3.forceY(baseline).strength(0.16))
        .force('collide', d3.forceCollide(dotR + 0.6).strength(0.95))
        .stop();
      for (let i = 0; i < 200; i += 1) sim.tick();
      placed = nodes.map((n) => ({
        v: n.v,
        x: Math.max(PAD.l + dotR, Math.min(W - PAD.r - dotR, n.x)),
        y: Math.max(PAD.t + dotR, Math.min(baseline, n.y)),
      }));
    } else {
      const counts = new Array(bins).fill(0);
      placed = d.scenarios.map((v) => {
        const bi = Math.max(0, Math.min(bins - 1, Math.floor((v - lo) / bw)));
        const stack = counts[bi];
        counts[bi] += 1;
        return { v, x: X(lo + (bi + 0.5) * bw), y: axisY - dotR - 2 - stack * (dotR * 2 + 1) };
      });
    }

    let g = `<line class="sv-axis" x1="${PAD.l}" y1="${axisY}" x2="${W - PAD.r}" y2="${axisY}"/>`;
    [-FLAT_THRESHOLD, FLAT_THRESHOLD].forEach((t) => {
      g += `<line class="sv-thr" x1="${X(t).toFixed(1)}" y1="${PAD.t}" x2="${X(t).toFixed(1)}" y2="${axisY}"/>`;
    });
    [Math.round(lo), 0, Math.round(hi)].forEach((t) => {
      g += `<text class="sv-albl" x="${X(t).toFixed(1)}" y="${axisY + 18}" text-anchor="middle">${pct(t)}</text>`;
    });

    const dots = placed.map((p, i) => (
      `<circle class="sv-dot" data-x="${p.x.toFixed(1)}" data-y="${p.y.toFixed(1)}" cx="${(W / 2).toFixed(1)}" cy="${PAD.t}" r="${dotR.toFixed(1)}" fill="${colorFor(p.v)}" opacity="0" style="transition-delay:${i * 16}ms"/>`
    )).join('');

    svg.innerHTML = `${g}${dots}`;
    requestAnimationFrame(() => svg.querySelectorAll('.sv-dot').forEach((c) => {
      c.style.opacity = 1;
      c.setAttribute('cx', c.dataset.x);
      c.setAttribute('cy', c.dataset.y);
    }));

    noteEl.innerHTML = 'Cada punto es un escenario de validación fuera de muestra; la línea marca el umbral de ±0.5 %. <b>Es la evidencia detrás de la confianza, no una predicción del precio.</b>';
  }

  draw();
  // Upgrade to the d3-force beeswarm once the physics bundle is in; the initial
  // paint already showed the dot-plot fallback, so a load failure is harmless.
  loadD3Force().then(() => draw()).catch(() => {});

  return {
    setAsset(asset) { state.asset = asset; draw(); },
  };
}
