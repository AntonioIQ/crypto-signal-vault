import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { ASSETS, fetchMarketChart } from "../netlify/lib/coingecko.mjs";
import { createHistoryDocument } from "../netlify/lib/market-contract.mjs";

export const HISTORY_DAYS = 30;

export async function bootstrapHistory({
  fetchChart = fetchMarketChart,
  outputDirectory = path.resolve("data/history"),
  clock = () => new Date(),
} = {}) {
  const entries = await Promise.all(
    Object.entries(ASSETS).map(async ([asset, metadata]) => {
      const points = await fetchChart(metadata.id, { days: HISTORY_DAYS });
      const document = createHistoryDocument({
        asset,
        points,
        generatedAt: clock(),
      });

      return [asset, document];
    }),
  );

  await mkdir(outputDirectory, { recursive: true });

  await Promise.all(
    entries.map(([asset, document]) =>
      writeFile(
        path.join(outputDirectory, `${asset}.json`),
        `${JSON.stringify(document, null, 2)}\n`,
        "utf8",
      ),
    ),
  );

  return Object.fromEntries(entries);
}

async function main() {
  await bootstrapHistory();
  console.log("Histórico de 30 días guardado en data/history/.");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch(() => {
    console.error("No se pudo generar el histórico de mercado.");
    process.exitCode = 1;
  });
}
