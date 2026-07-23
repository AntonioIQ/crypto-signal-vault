import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

// The chart is a bespoke SVG component with no charting library: no external
// hosts, no vendored bundle, and no runtime dependency to pin.

test("no charting library is a project dependency", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
  // The price chart is bespoke; only d3-force (physics for the scenario
  // beeswarm) is a viz dependency, not a charting library.
  assert.equal(deps["chart.js"], undefined);
  assert.equal(deps["d3"], undefined);
  assert.equal(deps["d3-force"], "^3.0.0");
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

test("the build vendors d3-force locally and no Chart.js bundle", async () => {
  const build = await readFile("scripts/copy-data.mjs", "utf8");
  assert.doesNotMatch(build, /chart\.umd/i);
  assert.match(build, /d3-force/);
});

test("the scenario viz loads d3 from local vendor with no external hosts", async () => {
  const viz = await readFile("public/js/scenario-viz.js", "utf8");
  assert.match(viz, /export function mountScenarioViz/);
  assert.match(viz, /\/js\/vendor\/\$\{module\}\.min\.js/);
  assert.doesNotMatch(viz, /https?:\/\//i);
});
