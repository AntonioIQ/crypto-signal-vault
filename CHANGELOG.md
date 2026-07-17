# CHANGELOG

## Fase 1 — Fundación · «la página viva» — CERRADA 2026-07-16

**Entregable**: https://likelycoin.netlify.app — sitio público con precio de BTC/ETH actualizado cada 15 minutos, gráfica de 30 días auto-refrescada y pipeline de estado en Netlify Blobs. Costo de operación: $0.

### Qué se construyó

- **Capa de datos** (`netlify/lib/`): abstracción de CoinGecko con timeout y 2 reintentos (cambiar de proveedor = tocar un módulo), y contrato de snapshot/histórico con validación estricta y timestamps en CDMX.
- **Estado vivo en Netlify Blobs**, nunca en el repo: `predict.mjs` (cada 15 min) escribe el precio; `refresh-history.mjs` (cada 6 h) reescribe la ventana de 30 días; `/api/latest` y `/api/history` los sirven con seeds versionados como fallback. Cada capa se degrada con honestidad (`stale`, «Datos de hace N horas», seed) en vez de romperse.
- **Dashboard LikelyCoin**: precio grande, cambio de 24 h anclado al precio mostrado, tabs BTC/ETH, gráfica Chart.js, estados cargando/fresco/stale/error, tarjetas de transparencia del modelo con placeholders honestos, disclaimers permanentes.
- **CI**: 28 pruebas (contratos, functions, fallbacks) + build en cada push.
- **Gobierno del presupuesto** (`docs/06_PRESUPUESTO.md`): 300 créditos/mes de Netlify, 15 por deploy → nada mutable se commitea, los pushes solo-docs no construyen (`ignore` en `netlify.toml`), y los crons se dimensionan contra la cuota de CoinGecko (uso actual: 31%).

### Bugs encontrados y corregidos durante la fase

- La gráfica desbordaba horizontalmente en móvil (`min-width:auto` en grid items).
- El % de 24 h comparaba dos puntos congelados del histórico y mostraba «▲ 0.0 %» verde con BTC cayendo −1.16 %; ahora se ancla al precio mostrado y se oculta si no hay ancla válida (±2 h).
- «Próxima lectura» prometía la hora en punto; el scheduler de Netlify llega tarde y a minutos variables, así que ahora se calcula desde la última corrida real y dice «En cualquier momento» si la estimación pasó.

### Checklist de QA (1.10) — 2026-07-16

- ✅ CI verde: 28/28.
- ✅ Móvil 390 px y desktop, sin desbordamiento horizontal (verificado programáticamente).
- ✅ Modo oscuro fijo por diseño (`color-scheme: dark`); no depende del tema del sistema.
- ✅ Estados cargando/fresco/stale/error forzados y verificados uno a uno.
- ✅ Disclaimers renderizados: footer + sección de predicción (chat: aplica en Fase 4).
- ✅ Sin logs de debug ni claves en el cliente (solo un `console.error` legítimo en la ruta de error).
- ✅ Números redondeados; horas en CDMX etiquetadas.
- ✅ Lighthouse: **performance 94** (≥85), **accesibilidad 100** (≥90), best practices 96, SEO 100.
- ✅ `docs/` al día (arquitectura, presupuesto, bitácora).

### Verificación operativa en producción

- 5+ corridas automáticas de `predict` observadas (16:09 → 18:30 CDMX), ninguna coincidente con un deploy; cadencia de 15 min confirmada con corridas a las 18:08:55 y 18:18:55.
- Primera corrida de `refresh-history` a las 18:04:49: 721 puntos con el último de ese minuto.
- Ingesta manual + fallbacks verificados extremo a extremo.
