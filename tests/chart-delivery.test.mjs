import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

// The chart is a bespoke SVG component with no charting library: no external
// hosts, no vendored bundle, and no runtime dependency to pin.

test("no charting library is a project dependency", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
  assert.equal(deps["chart.js"], undefined);
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

test("the build does not copy a vendored chart bundle", async () => {
  const build = await readFile("scripts/copy-data.mjs", "utf8");
  assert.doesNotMatch(build, /chart\.umd|vendor/i);
});
