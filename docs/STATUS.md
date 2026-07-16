# STATUS — foto actual del proyecto

> **Este archivo es la fuente de verdad del avance.** Cualquier sesión nueva (Claude Code, claude.ai, otra máquina) debe leerlo primero. Se sobrescribe al final de cada sesión de trabajo; el historial narrativo vive en [BITACORA.md](BITACORA.md).

**Última actualización**: 2026-07-16 16:24 (hora CDMX)

## Fase activa: FASE 1 — Fundación · «la página viva»

**Objetivo**: sitio público en Netlify que muestra precio BTC/ETH actualizado cada hora con gráfica de 30 días.

| # | Tarea | Estado |
|---|---|---|
| 1.1 | Repo con estructura de carpetas + `docs/` + agentes | ☑ Hecha |
| 1.2 | Conectar repo a Netlify, verificar deploy del esqueleto | ☑ Hecha (`likelycoin.netlify.app`, `main`) |
| 1.3 | Key demo de CoinGecko → env vars de Netlify | ☑ Hecha (`COINGECKO_DEMO_API_KEY`) |
| 1.4 | `predict.mjs` v0: precio actual → snapshot con `stale` | ☑ Hecha y verificada en Netlify |
| 1.5 | Schedule horario + verificar 3 corridas | ◐ En curso (prueba manual fresca; faltan 3 corridas automáticas) |
| 1.6 | Bootstrap histórico 30 días → `data/history/` | ☑ Hecha (~720 puntos horarios por activo) |
| 1.7 | `index.html` + `app.js`: precio, gráfica, estados, responsive | ☑ Hecha (rediseño profesional LikelyCoin verificado en 390px y desktop) |
| 1.8 | Footer disclaimer + timestamp CDMX | ☑ Hecha |
| 1.9 | `ci.yml` con validación de schema de `latest.json` | ☑ Hecha (17 tests verdes) |
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
- Sin bloqueos activos. Falta observar el comportamiento automático del schedule `@hourly`.

## Siguiente paso (uno solo)

➡️ Verificar que `generated_at` avance en **3 corridas automáticas consecutivas** de `@hourly`; después ejecutar el checklist 1.10 y cerrar la Fase 1.
