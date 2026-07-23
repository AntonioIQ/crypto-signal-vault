// Build step: copy the public data contracts into the publish dir so the
// frontend can read them as static JSON (fallback when the live API is down).
import { cp, mkdir } from "node:fs/promises";
import path from "node:path";

const source = path.resolve("data");
const destination = path.resolve("public/data");

await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true, force: true });
