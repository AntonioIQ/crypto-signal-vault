# STATUS — foto actual del proyecto

> **Este archivo es la fuente de verdad del avance.** Cualquier sesión nueva (Claude Code, claude.ai, otra máquina) debe leerlo primero. Se sobrescribe al final de cada sesión de trabajo; el historial narrativo vive en [BITACORA.md](BITACORA.md).

**Última actualización**: 2026-07-16 (hora CDMX)

## Fase activa: FASE 1 — Fundación · «la página viva»

**Objetivo**: sitio público en Netlify que muestra precio BTC/ETH actualizado cada hora con gráfica de 30 días.

| # | Tarea | Estado |
|---|---|---|
| 1.1 | Repo con estructura de carpetas + `docs/` + agentes | ☑ Hecha |
| 1.2 | Conectar repo a Netlify, verificar deploy del esqueleto | ☐ Pendiente (Antonio) |
| 1.3 | Key demo de CoinGecko → env vars de Netlify | ☐ Pendiente (Antonio) |
| 1.4 | `predict.mjs` v0: precio actual → snapshot con `stale` | ☑ Hecha (falta verificar en Netlify) |
| 1.5 | Schedule horario + verificar 3 corridas | ☐ Pendiente (requiere 1.2) |
| 1.6 | Bootstrap histórico 30 días → `data/history/` | ☑ Hecha (~720 puntos horarios por activo) |
| 1.7 | `index.html` + `app.js`: precio, gráfica, estados, responsive | ☑ Hecha (verificada local en 375px y desktop) |
| 1.8 | Footer disclaimer + timestamp CDMX | ☑ Hecha |
| 1.9 | `ci.yml` con validación de schema de `latest.json` | ☑ Hecha (17 tests verdes) |
| 1.10 | Checklist de QA y cierre de fase | ☐ Pendiente (requiere sitio vivo) |

## Arquitectura del refresh (decisión cerrada)

Resuelta la duda que quedó abierta en la sesión anterior: el snapshot vivo se guarda en **Netlify Blobs** (store `market-data`, key `latest.json`), lo escribe `predict.mjs` cada hora y lo expone `GET /api/latest`. `data/latest.json` en el repo es **seed/fallback versionado**, no el estado vivo; el build lo copia a `public/data/`. El frontend pide `/api/latest` y cae al JSON estático si falla. Detalle completo en `01_ARQUITECTURA.md` §1.

## Bloqueos

- 1.2 y 1.3 requieren cuentas de Antonio (Netlify, CoinGecko). Todo lo demás de la fase ya está construido y probado localmente.

## Siguiente paso (uno solo)

➡️ **Antonio**: conectar el repo a Netlify (tarea 1.2) y agregar `COINGECKO_DEMO_API_KEY` a las env vars (1.3). Con eso se desbloquea 1.5 y el cierre de fase.
