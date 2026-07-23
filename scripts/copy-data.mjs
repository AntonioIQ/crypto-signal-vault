// Build step: copy the public data contracts into the publish dir so the
// frontend can read them as static JSON (fallback when the live API is down),
// and vendor the small d3-force UMD bundles used by the scenario distribution.
import { access, copyFile, cp, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

const source = path.resolve("data");
const destination = path.resolve("public/data");

// Loaded in this order at runtime: force depends on the other three.
const D3_MODULES = ["d3-dispatch", "d3-quadtree", "d3-timer", "d3-force"];
const vendor = path.resolve("public/js/vendor");

await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true, force: true });

await mkdir(vendor, { recursive: true });
for (const module of D3_MODULES) {
  const from = path.resolve(`node_modules/${module}/dist/${module}.min.js`);
  try {
    await access(from, constants.R_OK);
  } catch (error) {
    throw new Error(`${module} bundle is missing. Run \`npm install\` before building.`, {
      cause: error,
    });
  }
  await copyFile(from, path.join(vendor, `${module}.min.js`));
}
