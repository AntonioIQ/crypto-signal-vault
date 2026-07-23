import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

// Bespoke visualizations, no library: the price chart is SVG, the scenario
// distribution is a canvas Galton animation. No charting or viz dependency.

test("no charting or viz library is a project dependency", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
  assert.equal(deps["chart.js"], undefined);
  assert.equal(deps["d3"], undefined);
  assert.equal(deps["d3-force"], undefined);
});

test("the chart module is self-contained and has no external hosts", async () => {
  const chart = await readFile("public/js/likely-chart.js", "utf8");
  assert.match(chart, /export function mountLikelyChart/);
  assert.doesNotMatch(chart, /https?:\/\//i);
});

test("the dashboard mounts the bespoke chart and loads no Chart.js", async () => {
  const app = await readFile("public/js/app.js", "utf8");
  assert.match(app, /import \{ mountLikelyChart \} from ['"]\.\/likely-chart\.js['"]/);
  assert.match(app, /mountLikelyChart\(/);
  assert.doesNotMatch(app, /chart\.umd|CHART_JS_URL|globalThis\.Chart|cdn\.jsdelivr/i);
});

test("index.html declares a favicon and loads no chart script", async () => {
  const html = await readFile("public/index.html", "utf8");
  assert.match(html, /<link rel="icon" href="favicon\.svg"/);
  assert.match(html, /<div id="chart-mount">/);
  assert.doesNotMatch(html, /<script[^>]+(?:chart|vendor)/i);
});

test("the build copies no vendored bundle", async () => {
  const build = await readFile("scripts/copy-data.mjs", "utf8");
  assert.doesNotMatch(build, /chart\.umd|vendor|d3-/i);
});

test("the scenario viz is a self-contained canvas component, no external hosts", async () => {
  const viz = await readFile("public/js/scenario-viz.js", "utf8");
  assert.match(viz, /export function mountScenarioViz/);
  assert.match(viz, /getContext\(['"]2d['"]\)/);
  assert.doesNotMatch(viz, /https?:\/\//i);
});
