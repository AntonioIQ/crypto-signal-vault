# STATUS — foto actual del proyecto

> **Este archivo es la fuente de verdad del avance.** Cualquier sesión nueva (Claude Code, claude.ai, otra máquina) debe leerlo primero. Se sobrescribe al final de cada sesión de trabajo; el historial narrativo vive en [BITACORA.md](BITACORA.md).

**Última actualización**: 2026-07-16 17:10 (hora CDMX)

> ⚠️ **Antes de tocar nada, lee [`06_PRESUPUESTO.md`](06_PRESUPUESTO.md).** Netlify Free = 300 créditos/mes, cada production deploy cuesta 15, y si se agotan **el sitio se pausa**. Quedan ~17 deploys en el ciclo (expira 31 jul). Nada mutable se commitea; batchea los pushes.

## Fase activa: FASE 1 — Fundación · «la página viva»

**Objetivo**: sitio público en Netlify que muestra precio BTC/ETH actualizado cada hora con gráfica de 30 días.

| # | Tarea | Estado |
|---|---|---|
| 1.1 | Repo con estructura de carpetas + `docs/` + agentes | ☑ Hecha |
| 1.2 | Conectar repo a Netlify, verificar deploy del esqueleto | ☑ Hecha (`likelycoin.netlify.app`, `main`) |
| 1.3 | Key demo de CoinGecko → env vars de Netlify | ☑ Hecha (`COINGECKO_DEMO_API_KEY`) |
| 1.4 | `predict.mjs` v0: precio actual → snapshot con `stale` | ☑ Hecha y verificada en Netlify |
| 1.5 | Schedule horario + verificar 3 corridas | ◐ En curso (prueba manual fresca; faltan 3 corridas automáticas) |
| 1.6 | Bootstrap histórico 30 días → `data/history/` | ☑ Hecha (seed de ~720 puntos/activo; el vigente se refresca a Blobs cada 6h) |
| 1.7 | `index.html` + `app.js`: precio, gráfica, estados, responsive | ☑ Hecha (rediseño profesional LikelyCoin verificado en 390px y desktop) |
| 1.8 | Footer disclaimer + timestamp CDMX | ☑ Hecha |
| 1.9 | `ci.yml` con validación de schema de `latest.json` | ☑ Hecha (28 tests verdes) |
| 1.10 | Checklist de QA y cierre de fase | ☐ Pendiente (requiere sitio vivo) |

## Arquitectura del refresh (decisión cerrada)

Resuelta la duda que quedó abierta en la sesión anterior: el snapshot vivo se guarda en **Netlify Blobs** (store `market-data`, key `latest.json`), lo escribe `predict.mjs` cada hora y lo expone `GET /api/latest`. `data/latest.json` en el repo es **seed/fallback versionado**, no el estado vivo; el build lo copia a `public/data/`. El frontend pide `/api/latest` y cae al JSON estático si falla. Detalle completo en `01_ARQUITECTURA.md` §1.

## Validación de producción

- Sitio público: `https://likelycoin.netlify.app` responde HTTP 200.
- `GET /api/latest` responde HTTP 200 desde la Function desplegada.
- Ejecución manual de `predict` a las 14:09 CDMX: HTTP 200, snapshot en Netlify Blobs con `stale: false`, BTC y ETH con precios reales.
- Rediseño LikelyCoin desplegado en producción (`3d42b6b`): esfera y emojis decorativos eliminados, identidad geométrica de señal, jerarquía editorial y atribución de CoinGecko.
- UI productiva verificada: marca LikelyCoin, «Datos al día», precio real, sin errores de consola ni desbordamiento horizontal. QA responsive previo en 1440px/390px.
- Snapshot fresco observado a las 16:09 CDMX después del redeploy (`stale: false`).
- **Evidencia de 1.5**: `generated_at` avanzó de 14:09 → 16:09 CDMX sin intervención manual, así que el schedule sí dispara. Ojo: corre a las **:09**, no a las :00; la tarjeta «Próxima lectura» promete la hora en punto y llega ~9 min tarde. Faltan 2 corridas más observadas para cerrar 1.5.
- **Bug corregido en producción**: `change24h()` calculaba el % entre los dos últimos puntos del histórico (congelados) mientras el precio venía vivo del API → mostraba BTC en ▲ 0.0 % verde cuando realmente caía −1.16 %. Ahora ancla el % al precio mostrado y lo oculta si el histórico no cubre esa ventana ±2h. El arreglo quedó absorbido dentro del commit `3d42b6b` del rediseño.

## Hueco del histórico congelado: RESUELTO

El histórico ya no depende del bootstrap. `refresh-history.mjs` reescribe la ventana de 30 días en Blobs cada 6h y `GET /api/history?asset=` la sirve; `data/history/` quedó como seed de fallback. Se descartó la opción del Action diario que commitea: **habría costado 450 créditos/mes contra un presupuesto de 300** (ver `06_PRESUPUESTO.md`).

**Implicación pendiente para Fase 2**: el diseño original decía commitear `models/model_YYYYMMDD.json` a diario. Eso tampoco cabe en el presupuesto. `train.yml` deberá escribir el artefacto a Blobs con `NETLIFY_AUTH_TOKEN` + `NETLIFY_SITE_ID` sin tocar el repo.

## Siguiente paso (uno solo)

➡️ Verificar en producción que `refresh-history` escribió su blob (`GET /api/history?asset=btc` debe responder 200 con `generated_at` de hoy) y que `generated_at` de `/api/latest` avance en **3 corridas consecutivas**; después ejecutar el checklist 1.10 y cerrar la Fase 1.
