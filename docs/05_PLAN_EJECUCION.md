# 05 — PLAN DE EJECUCIÓN

> Cada fase está dimensionada para 1–2 fines de semana de una persona. **Regla: no se abre una fase sin cerrar la anterior** (checklist de QA completo).

### Definición de terminado (DoD) global

Una tarea está terminada cuando: (1) el código está en `main` y desplegado, (2) pasó QA-Guardian, (3) los docs afectados están actualizados, (4) hay al menos una prueba que la cubre (si es código).

### FASE 1 — Fundación · «la página viva»

**Objetivo**: sitio público en Netlify que muestra precio BTC/ETH actualizado cada hora con gráfica de 30 días.
**Estimación**: 1 fin de semana.

| # | Tarea | Agente | Depende de | Notas |
|---|---|---|---|---|
| 1.1 | Crear repo `crypto-signal-vault` con estructura de carpetas + `docs/` | Orquestador | — | Repo público (portafolio) |
| 1.2 | Conectar repo a Netlify, configurar `netlify.toml` (publish `public/`, functions dir) | Data-Pipe | 1.1 | Verificar deploy del esqueleto |
| 1.3 | Registrar key demo gratuita de CoinGecko y guardarla en env vars de Netlify | Data-Pipe | — | Mitigación R-02 desde día 1 |
| 1.4 | `predict.mjs` v0: fetch precio actual BTC/ETH → escribe `data/latest.json` (sin predicción aún) con manejo de error + `stale` | Data-Pipe | 1.2, 1.3 | Timeout + 2 reintentos |
| 1.5 | Configurar schedule horario de la function y verificar 3 corridas | Data-Pipe | 1.4 | Logs de Netlify |
| 1.6 | Bootstrap del histórico: script one-shot que baja 30 días y llena `data/history/` | Data-Pipe | 1.3 | Para que la gráfica no nazca vacía |
| 1.7 | `index.html` + `app.js`: precio grande, gráfica 30 días (Chart.js), estados cargando/stale/error, responsive móvil | Front-UX | 1.4, 1.6 | Según mockup aprobado |
| 1.8 | Footer con disclaimer + timestamp "última actualización" en hora CDMX | Front-UX | 1.7 | Mitigación R-10 |
| 1.9 | `ci.yml` con validación de schema de `latest.json` + test de formateo | QA-Guardian | 1.4 | Base de la suite |
| 1.10 | Pasar checklist Fase 1 y cierre de fase | QA-Guardian + Doc-Scribe | todo | CHANGELOG + resumen |

**Entregable visible**: URL pública con precios reales auto-actualizados.

### FASE 2 — Modelo · «la línea punteada»

**Objetivo**: predicción 24–48h visible en la gráfica con indicador de dirección y confianza.
**Estimación**: 1–2 fines de semana.
**Componentes**: `ml/features.py`, `ml/train.py`, `train.yml` (07:00 UTC diario), artefacto de forecast 48h pre-computado, anclaje en `predict.mjs`, indicador 🔼/🔽/➡️ + % de confianza en UI.

### FASE 3 — MLOps · «la honestidad medida»

**Objetivo**: `predictions_log.json` funcionando, `ml/evaluate.py` + `evaluate.yml` (07:30 UTC), accuracy rolling 7 días **real** en las 3 tarjetas de MLOps, `metrics/health.json` y detección de drift/huecos.

### FASE 4 — Analista · «el chat»

**Objetivo**: `chat.mjs` con Groq, system prompt v1, rate limit doble, fallback de plantillas, botones de preguntas rápidas, feature flag `CHAT_ENABLED`.

### FASE 5 — Pulido y portafolio

**Objetivo**: README con badges, `/status.html`, Lighthouse, caso de estudio escrito para el portafolio.
