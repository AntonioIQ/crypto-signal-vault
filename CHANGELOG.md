# CHANGELOG

## Fase 3 — MLOps · «la honestidad medida» — CERRADA 2026-07-21

**Entregable**: la tarjeta «Precisión de 7 días», antes vacía, ahora se llena con accuracy **medida contra el precio real que ocurrió** — nunca backtest, nunca la confianza del modelo. Regla de oro #3 hecha producto. Costo de operación: $0.

### Qué se construyó

- **Contrato `prediction-log/1.0`** (`prediction-contract.mjs`): registro por predicción con id horario idempotente, dirección con umbral 0.5 %, y bloque público `accuracy`. El validador impone la verdad semántica (dirección coherente con `predicted/anchor`, `hit` coherente con el precio real, `resolved_at ≥ target_at`) y el umbral de honestidad (`available` solo con ≥20 muestras; ventana de 7 días).
- **Estado en Netlify Blobs, nunca en el repo** (store `predictions`): `predict.mjs` registra una predicción por activo al anclar un forecast `fresh`, con compare-and-swap por ETag (`blob-log.mjs`) para no perder escrituras concurrentes; todo aislado, un fallo del store no toca el precio.
- **`ml/evaluate.py` + `evaluate.yml` (07:30 UTC)**: resuelve predicciones vencidas contra el precio real más cercano ±1 h (serie horaria completa, sin interpolar), calcula accuracy rolling de 7 días por activo, reporta huecos/pendientes en `health`, y poda el log a 30 días. Publica a Blobs con merge contra el baseline; cero commits, cero deploys diarios.
- **UI** (`forecast-ui.js accuracyView` + `app.js`): la tarjeta muestra el porcentaje solo cuando hay ≥20 predicciones medidas; si no, «MIDIENDO (n)».

### Revisión externa (reparto invertido: Claude construyó, Codex revisó)

- Codex encontró 1 bloqueante + 4 mayores + 1 menor; los 6 corregidos y confirmados en una segunda pasada (**«CONFIRMACIÓN FINAL FASE 3: APTA PARA MERGE»**). El bloqueante era pérdida de predicciones por escrituras concurrentes → resuelto con CAS por ETag + merge con baseline.
- 94 pruebas Node + 39 Python; build, `npm audit` (0 vulns), `git diff --check` limpios. E2e Python→JS revalidado contra el contrato endurecido.

### Verificación operativa en producción

- PR #2 integrada a `main` (`934a78b`); un solo deploy productivo de 15 créditos.
- Primera corrida real de `Daily prediction evaluation` (run `29877442181`) en **success** end-to-end, incluida la publicación a Netlify Blobs.
- `/api/latest` sirve el bloque `accuracy` (`available`, ambos activos `insufficient_data` con muestra 0 sobre un log recién iniciado — honesto).
- UI productiva: tarjeta «MIDIENDO (0)» en BTC y ETH, precio y pronóstico intactos, sin errores de consola.

### Siguiente

La primera accuracy con porcentaje aparece cuando se acumulen ≥20 predicciones resueltas (~48 h de registro). Fase 4: el chat del Analista.

## Fase 2 — Modelo · «la línea punteada» — CERRADA 2026-07-21

**Entregable**: pronóstico real de 48 horas para BTC y ETH, entrenado diariamente en GitHub Actions, publicado en Netlify Blobs, anclado al precio vivo y presentado en `https://likelycoin.netlify.app` con lenguaje simple. Costo de operación: $0.

### Qué se construyó

- **Contrato agnóstico `forecast-artifact/1.0`**: 48 factores horarios por activo, dirección simple, confianza rolling-origin separada de accuracy, expiración y rollback `latest → previous`.
- **Pipeline ML** (`ml/features.py`, `ml/train.py`): Prophet 1.3.0, histórico reciente y contiguo, validación rolling-origin y artefacto JSON validado antes de publicarse.
- **Entrenamiento diario** (`Daily forecast training`): CI Python/Node, gate a `main`, publicación versionada en el store `model-artifacts`, read-back fuerte y rollback, sin commits de estado ni deploys diarios.
- **Serving tolerante a fallos**: `predict.mjs` lee `latest → previous`, ancla 48 horas al precio vivo y conserva el precio aunque el forecast esté ausente, vencido o corrupto.
- **Dashboard productivo**: línea sólida para histórico, línea punteada para pronóstico, dirección y confianza en lenguaje simple, estados `fresh/stale/unavailable`, precisión vacía hasta tener evidencia real.
- **Chart.js 4.4.9 local**: bundle oficial copiado al build, carga dinámica con fallback, sin CDN ni dependencia de jsDelivr.

### Verificación operativa en producción

- PR #1 integrada por fast-forward estricto a `main`; Claude confirmó **«CONFIRMACIÓN FINAL FASE 2: APTA PARA MERGE»** sin hallazgos.
- Workflow manual #1: run `29854592038`, job `88715662743`, sobre `a44db3e`; 26 pruebas Python, 72 Node, entrenamiento y publicación en **success**.
- Artefacto verificado: `20260721T175020Z-a44db3e34bc969fc02f31132bcb22bb538c7421d-gh29854592038-1`.
- Una ejecución directa de `/.netlify/functions/predict` respondió HTTP 200 y ancló el snapshot a `2026-07-21T11:52:05-06:00`.
- `/api/latest`: `stale: false`, forecast `fresh`, 48 puntos por activo. BTC: `down`, −3.1511 %, confianza 72.5 % (muestra 40). ETH: `down`, −3.4374 %, confianza 87.5 % (muestra 40).
- Accuracy ausente por diseño hasta medirse contra `data/predictions_log.json`; la UI no presenta backtest ni expectativa como resultado real.
- UI productiva verificada en desktop y 390 px: BTC/ETH, línea punteada, copy simple, «Datos al día», entrenamiento 11:50 CDMX, sin errores de consola ni overflow.
- `/js/vendor/chart.umd.js` responde HTTP 200 con 206670 bytes y es byte-idéntico al bundle oficial 4.4.9; no hay referencia a jsDelivr.
- Un único deploy productivo consumió 15 créditos; los commits posteriores solo-documentación fueron ignorados por Netlify.

### Checklist de QA (2.6) — 2026-07-21

- ✅ CI y tests: 72 Node + 26 Python; build, sintaxis, diff-check y `npm audit` verdes.
- ✅ Móvil 390 px y desktop sin desbordamiento horizontal.
- ✅ Modo oscuro fijo por diseño; el tema del sistema no aplica.
- ✅ Estados cargando/fresco/stale/error y forecast `fresh/stale/unavailable` cubiertos por pruebas.
- ✅ Disclaimers presentes; chat todavía no aplica.
- ✅ Sin logs de debug ni claves en el cliente.
- ✅ Números redondeados y horarios etiquetados en CDMX.
- ✅ Lighthouse móvil remoto limpio: performance 98, accesibilidad 100.
- ✅ Arquitectura, estado, bitácora y changelog actualizados.
- ✅ QA-Guardian aprobó sin hallazgos y revisión externa completa.

### Deuda no bloqueante

- GitHub Actions advierte que actions v4 apuntan a Node 20 y las fuerza a Node 24. El run pasó; revisar el upgrade al preparar la Fase 3.

### Siguiente

Preparar la Fase 3: `predictions_log`, evaluación y accuracy real medida. No se muestra accuracy hasta contar con resultados reales suficientes.

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
