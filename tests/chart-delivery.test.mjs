import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { test } from "node:test";

const execFileAsync = promisify(execFile);
const CHART_VERSION = "4.4.9";
const CHART_SOURCE = "node_modules/chart.js/dist/chart.umd.js";
const CHART_DESTINATION = "public/js/vendor/chart.umd.js";

test("Chart.js is pinned to the exact supported version", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  const packageLock = JSON.parse(await readFile("package-lock.json", "utf8"));

  assert.equal(packageJson.dependencies["chart.js"], CHART_VERSION);
  assert.equal(packageLock.packages[""].dependencies["chart.js"], CHART_VERSION);
  assert.equal(
    packageLock.packages["node_modules/chart.js"].version,
    CHART_VERSION,
  );
});

test("build copies the official Chart.js UMD bundle into the published site", async () => {
  await execFileAsync(process.execPath, ["scripts/copy-data.mjs"]);

  const [source, destination] = await Promise.all([
    readFile(CHART_SOURCE),
    readFile(CHART_DESTINATION),
  ]);
  assert.deepEqual(destination, source);
});

test("app loads Chart.js dynamically from the local vendor bundle", async () => {
  const app = await readFile("public/js/app.js", "utf8");

  assert.doesNotMatch(app, /cdn\.jsdelivr\.net|https?:\/\//i);
  assert.match(app, /const CHART_JS_URL = ['"]\/js\/vendor\/chart\.umd\.js['"]/);
  assert.match(app, /document\.createElement\(['"]script['"]\)/);
  assert.match(app, /script\.async = true/);
  assert.match(app, /loadChartLibrary\(\)\.catch\(\(\) => null\)/);
});
