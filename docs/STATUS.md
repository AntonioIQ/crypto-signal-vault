# STATUS — foto actual del proyecto

> **Este archivo es la fuente de verdad del avance.** Cualquier sesión nueva (Claude Code, claude.ai, otra máquina) debe leerlo primero. Se sobrescribe al final de cada sesión de trabajo; el historial narrativo vive en [BITACORA.md](BITACORA.md).

**Última actualización**: 2026-07-15 (hora CDMX)

## Fase activa: FASE 1 — Fundación · «la página viva»

**Objetivo**: sitio público en Netlify que muestra precio BTC/ETH actualizado cada hora con gráfica de 30 días.

| # | Tarea | Estado |
|---|---|---|
| 1.1 | Repo con estructura de carpetas + `docs/` + agentes | ☑ Hecha |
| 1.2 | Conectar repo a Netlify, verificar deploy del esqueleto | ☐ Pendiente (Antonio) |
| 1.3 | Key demo de CoinGecko → env vars de Netlify | ☐ Pendiente (Antonio) |
| 1.4 | `predict.mjs` v0: precio actual → `latest.json` con `stale` | ☐ Pendiente |
| 1.5 | Schedule horario + verificar 3 corridas | ☐ Pendiente |
| 1.6 | Bootstrap histórico 30 días → `data/history/` | ☐ Pendiente |
| 1.7 | `index.html` + `app.js`: precio, gráfica, estados, responsive | ☐ Pendiente |
| 1.8 | Footer disclaimer + timestamp CDMX | ☐ Pendiente |
| 1.9 | `ci.yml` con validación de schema de `latest.json` | ☐ Pendiente |
| 1.10 | Checklist de QA y cierre de fase | ☐ Pendiente |

## Bloqueos

- Ninguno técnico. 1.2 y 1.3 requieren cuentas de Antonio (Netlify, CoinGecko).

## Decisión abierta (resolver en 1.4)

Una Netlify Function **no puede escribir al directorio publicado** en runtime. El refresh horario de `latest.json` debe resolverse como: (a) `predict.mjs` escribe a **Netlify Blobs** y el frontend lee de un endpoint `/api/latest`, o (b) el JSON estático solo se refresca con el ciclo diario. Definir contrato antes de tocar frontend.

## Siguiente paso (uno solo)

➡️ **Antonio**: conectar el repo a Netlify (tarea 1.2). Después Claude implementa 1.4.
