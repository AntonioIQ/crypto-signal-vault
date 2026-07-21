import { access, copyFile, cp, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

const source = path.resolve("data");
const destination = path.resolve("public/data");
const chartSource = path.resolve("node_modules/chart.js/dist/chart.umd.js");
const chartDestination = path.resolve("public/js/vendor/chart.umd.js");

try {
  await access(chartSource, constants.R_OK);
} catch (error) {
  throw new Error(
    "Chart.js bundle is missing. Run `npm install` before building.",
    { cause: error },
  );
}

await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true, force: true });
await mkdir(path.dirname(chartDestination), { recursive: true });
await copyFile(chartSource, chartDestination);
