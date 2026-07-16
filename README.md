# Crypto Signal Vault

Plataforma web de predicción de precios de criptomonedas (BTC y ETH) con pipeline de MLOps completo y un chatbot analista tipo RAG. Proyecto de portafolio, costo de operación: **$0**.

> ⚠️ Este proyecto es un **experimento educativo de Machine Learning**. Nada de lo que muestra constituye asesoría financiera.

## Qué hace

- Muestra el precio actual de BTC/ETH, actualizado cada hora.
- Predice el precio a 24–48h con un indicador simple: 🔼 sube / 🔽 baja / ➡️ estable, con % de confianza.
- Mide y publica su **precisión real** (rolling 7 días) — la que se midió, no la del backtest.
- Incluye "el Analista": un chat acotado a los datos del modelo (no da consejos de inversión).

## Stack (todo free tier)

| Capa | Tecnología |
|---|---|
| Frontend | Vanilla JS + Chart.js, hosteado en Netlify |
| Predicción horaria | Netlify Scheduled Functions |
| Entrenamiento diario | GitHub Actions (cron) |
| Datos de mercado | CoinGecko API |
| Chatbot LLM | Groq free tier (Llama 3.3) |
| Estado | JSON versionados en el repo + Netlify Blobs |

## Documentación

Todo el diseño vive en [`docs/`](docs/):

- [00 — Contexto](docs/00_CONTEXTO.md) · qué es, restricciones, decisiones tomadas y descartadas
- [01 — Arquitectura](docs/01_ARQUITECTURA.md) · contratos de datos, estructura, flujos
- [02 — Riesgos](docs/02_RIESGOS.md) · matriz viva de riesgos y mitigaciones
- [03 — Agentes](docs/03_AGENTES.md) · equipo de subagentes de desarrollo
- [04 — QA](docs/04_QA.md) · checklist de release y monitoreo
- [05 — Plan de ejecución](docs/05_PLAN_EJECUCION.md) · fases y tareas

## Estado

🚧 **Fase 1 en curso** — «la página viva»: sitio público con precio real auto-actualizado.
