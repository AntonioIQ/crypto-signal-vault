# STATUS — foto actual del proyecto

> **Este archivo es la fuente de verdad del avance.** Cualquier sesión nueva (Claude Code, claude.ai, otra máquina) debe leerlo primero. Se sobrescribe al final de cada sesión de trabajo; el historial narrativo vive en [BITACORA.md](BITACORA.md).

**Última actualización**: 2026-07-21 12:01 (hora CDMX)

> ⚠️ **Antes de tocar nada, lee [`06_PRESUPUESTO.md`](06_PRESUPUESTO.md).** Netlify Free = 300 créditos/mes, cada production deploy cuesta 15, y si se agotan **el sitio se pausa**. Quedan ~16 deploys en el ciclo (expira 31 jul). Nada mutable se commitea; batchea los pushes.

## FASE 2 — Modelo · «la línea punteada» — CERRADA ✅

**Rama actual**: `main` (código productivo de Fase 2 en `4a41cb7`; los commits posteriores solo-documentación fueron ignorados por Netlify sin deploy).

| # | Paquete | Estado |
|---|---|---|
| 2.1 | Contrato `forecast-artifact/1.0` + snapshot anclado | ☑ Documentado antes del código |
| 2.2 | `ml/features.py` + `ml/train.py` + Prophet + validación rolling-origin | ☑ Implementado y aprobado por QA; Prophet real verificado |
| 2.3 | `train.yml` diario + publicador seguro a Netlify Blobs | ☑ Primera ejecución real publicada y verificada en Netlify Blobs |
| 2.4 | Lectura `latest → previous`, anclaje 48h en `predict.mjs` | ☑ Implementado y aprobado por QA; incluye fallback ante JSON malformado y seed explícito `unavailable` |
| 2.5 | Línea punteada + dirección + confianza en UI | ☑ Implementado y aprobado por QA; desktop/390 px verificados |
| 2.6 | QA completo + revisión externa de Claude + merge batched a `main` | ☑ Checklist completo, Claude confirmó sin hallazgos y producción verificada |

### Validación de Fase 2

- **72 pruebas Node + 26 Python verdes**; build, `node --check` y `git diff --check` correctos en el checkpoint local; `npm audit` reporta 0 vulnerabilidades.
- QA-Guardian aprobó 2.4 después de corregir el fallback de `latest` con JSON malformado y la forma de snapshots seed nuevos.
- QA-Guardian aprobó 2.5 sin hallazgos: 48 puntos punteados, BTC/ETH, dirección simple, confianza separada de accuracy y estados `fresh/stale/unavailable`.
- Revisión visual local con snapshot de pronóstico controlado: desktop y 390 px sin overflow, cambio BTC/ETH correcto y sin errores de consola.
- Se eliminó el último motivo circular del panel predictivo; la señal usa una identidad lineal sobria, sin esfera ni emojis.
- El estado sin forecast conserva precio/gráfica real y dice explícitamente «Sin señal disponible» / «Sin medición».
- GitHub Actions reconoce `NETLIFY_AUTH_TOKEN` y `NETLIFY_SITE_ID` como repository secrets; sus valores permanecen ocultos.
- PR #1 `Add Phase 2 forecast pipeline and dashboard`: CI y Netlify Deploy Preview verdes en `9f01ea0`; integrada por fast-forward estricto a `main` en `4a41cb7`.
- Deploy Preview usado para la validación previa: `https://deploy-preview-1--likelycoin.netlify.app` (gratuito).
- La URL colaborativa del Deploy Preview obtuvo **78 performance móvil** después del cambio. Esa superficie inyectó Netlify Drawer —incluidos tres videos y scripts ajenos al build— y elevó la transferencia a 1.72 MiB; el resultado se conserva y no se atribuye al sitio.
- El permalink inmutable del mismo deploy `6a5fa9eceab5c90008c48303` —misma compilación, sin Drawer— obtuvo **98 performance, 100 accesibilidad y 100 Best Practices** en Lighthouse móvil remoto: FCP 0.8 s, LCP 1.5 s, TBT 70 ms, CLS 0 y 103 KiB transferidos. Con ello M1 supera el umbral formal de performance ≥85.
- SEO queda en 60 únicamente en las superficies de preview por el encabezado `x-robots-tag: noindex`; producción de Fase 1 midió SEO 100.
- Claude emitió **«APROBACIÓN EXTERNA FASE 2: APTA PARA MERGE»** sobre `8f388fd`, sin bloqueantes ni hallazgos mayores.
- Después de revisar el delta completo, Claude confirmó exactamente **«CONFIRMACIÓN FINAL FASE 2: APTA PARA MERGE»**, sin hallazgos.
- Las cinco observaciones menores de Claude quedaron resueltas: publicador y runtime comparten un único validador; el anclaje fallido deja warning controlado; CI incluye las 26 pruebas Python; se eliminó `requests` sin uso; y M1 quedó cerrado con Chart.js servido por el propio build.
- **M1 resuelto local y remotamente:** `chart.js` está fijado exactamente en `4.4.9`; el build copia su bundle oficial `dist/chart.umd.js` a `public/js/vendor/chart.umd.js`; la carga sigue siendo dinámica, ya no depende del CDN y conserva el fallback si Chart.js no está disponible.
- Front-UX y QA-Guardian aprobaron el cambio. En navegador local, desktop y 390 px muestran BTC/ETH, gráfica y pronóstico correctamente, sin overflow ni errores de consola.
- Lighthouse móvil local: **performance 93, accesibilidad 100, Best Practices 100 y SEO 100**; FCP 1.0 s, LCP 3.2 s, TBT 10 ms y CLS 0.001. Lighthouse móvil remoto limpio: **performance 98, accesibilidad 100 y Best Practices 100**.
- Producción ya sirve `/js/vendor/chart.umd.js` con HTTP 200 y **206670 bytes** desde el build integrado.
- `Daily forecast training` #1 —run `29854592038`, job `88715662743`, sobre `main` en `a44db3e`— terminó en **success**: 26 pruebas Python, 72 Node, entrenamiento y publicación completos.
- Artefacto publicado y leído de vuelta: `20260721T175020Z-a44db3e34bc969fc02f31132bcb22bb538c7421d-gh29854592038-1`.
- Una única ejecución directa de `/.netlify/functions/predict` respondió HTTP 200 y ancló el forecast a `2026-07-21T11:52:05-06:00`.
- `/api/latest` quedó con `stale: false` y `forecast.status: fresh`; BTC y ETH contienen 48 puntos cada uno. BTC: dirección `down`, cambio −3.1511 %, confianza 72.5 % con muestra 40. ETH: `down`, cambio −3.4374 %, confianza 87.5 % con muestra 40.
- La accuracy permanece ausente, como exige el contrato: todavía no existe medición contra `data/predictions_log.json`.
- UI productiva verificada en desktop y 390 px: BTC/ETH, línea punteada, copy simple, «Datos al día» y entrenamiento de las 11:50 CDMX; cero errores de consola y cero overflow.
- QA-Guardian aprobó el cierre sin hallazgos. El bundle productivo es byte-idéntico a Chart.js 4.4.9 y no existe dependencia de jsDelivr.
- Checklist de `docs/04_QA.md` completo: CI/tests, responsive, dark fijo (tema del sistema no aplica), estados cubiertos por tests, disclaimers, cero debug/keys, redondeo y CDMX, Lighthouse remoto limpio 98/100 y documentación al día.
- **Warning no bloqueante:** GitHub Actions avisa que algunas actions v4 apuntan a Node 20 y las fuerza a Node 24. El run pasó; revisar el upgrade al preparar la Fase 3.

### FASE 1 — Fundación · «la página viva» — CERRADA

**Objetivo**: sitio público en Netlify que muestra precio BTC/ETH actualizado cada hora con gráfica de 30 días. *(Entregado por encima del objetivo: la cadencia real es cada 15 min.)*

| # | Tarea | Estado |
|---|---|---|
| 1.1 | Repo con estructura de carpetas + `docs/` + agentes | ☑ Hecha |
| 1.2 | Conectar repo a Netlify, verificar deploy del esqueleto | ☑ Hecha (`likelycoin.netlify.app`, `main`) |
| 1.3 | Key demo de CoinGecko → env vars de Netlify | ☑ Hecha (`COINGECKO_DEMO_API_KEY`) |
| 1.4 | `predict.mjs` v0: precio actual → snapshot con `stale` | ☑ Hecha y verificada en Netlify |
| 1.5 | Schedule + verificar 3 corridas | ☑ Hecha. Cadencia **cada 15 min** (`*/15 * * * *`) confirmada en producción con 4 corridas automáticas observadas: 16:09, 17:05, 18:08:55 y 18:18:55 CDMX. Ninguna coincide con un deploy. |
| 1.6 | Bootstrap histórico 30 días → `data/history/` | ☑ Hecha (seed de ~720 puntos/activo; el vigente se refresca a Blobs cada 6h) |
| 1.7 | `index.html` + `app.js`: precio, gráfica, estados, responsive | ☑ Hecha (rediseño profesional LikelyCoin verificado en 390px y desktop) |
| 1.8 | Footer disclaimer + timestamp CDMX | ☑ Hecha |
| 1.9 | `ci.yml` con validación de schema de `latest.json` | ☑ Hecha (28 tests verdes) |
| 1.10 | Checklist de QA y cierre de fase | ☑ Hecha. Checklist 9/9 (Lighthouse: perf 94, a11y 100). Resumen en `CHANGELOG.md`. |

## Arquitectura del refresh (decisión cerrada)

Todo el estado vivo vive en **Netlify Blobs** (store `market-data`) y nada mutable se commitea, porque cada commit a `main` es un deploy de 15 créditos:

| Qué | Quién lo escribe | Quién lo sirve | Fallback |
|---|---|---|---|
| `latest.json` (precio) | `predict.mjs`, cada 15 min | `GET /api/latest` | seed `data/latest.json` |
| `history/<asset>.json` (30 días) | `refresh-history.mjs`, cada 6h | `GET /api/history?asset=` | seed `data/history/` |

Los seeds del repo los copia el build a `public/data/`; el frontend pide el endpoint y cae al seed si falla. Detalle completo en `01_ARQUITECTURA.md` §1 y §2.2.

## Validación de producción

- Sitio público: `https://likelycoin.netlify.app` responde HTTP 200.
- `GET /api/latest` responde HTTP 200 desde la Function desplegada.
- Ejecución manual de `predict` a las 14:09 CDMX: HTTP 200, snapshot en Netlify Blobs con `stale: false`, BTC y ETH con precios reales.
- Rediseño LikelyCoin desplegado en producción (`3d42b6b`): esfera y emojis decorativos eliminados, identidad geométrica de señal, jerarquía editorial y atribución de CoinGecko.
- UI productiva verificada: marca LikelyCoin, «Datos al día», precio real, sin errores de consola ni desbordamiento horizontal. QA responsive previo en 1440px/390px.
- Snapshot fresco observado a las 16:09 CDMX después del redeploy (`stale: false`).
- **1.5 cerrada**: corridas automáticas a las 16:09, 17:05, **18:08:55 y 18:18:55** CDMX. Ninguna coincide con un deploy (13:25, 14:23, 16:26, 16:52, 17:14, 17:57), así que son del cron. Netlify **sí honra cadencias sub-horarias** en el plan Free.
- **`refresh-history` verificada**: primera corrida automática a las **18:04:49** CDMX (slot de 00:00 UTC). Escribió 721 puntos con el último de las 18:04 de hoy → el histórico ya no depende del bootstrap.
- **Cadena completa verificada en producción a las 18:22**: precio USD 63,840 de las 18:18, «−1.4 %» en rojo, «Datos al día», «Próxima lectura 06:33 p.m.» (= 18:18 + 15 min), y la gráfica sirviéndose de `/api/history` con 721 puntos frescos.
- **El scheduler de Netlify llega tarde y a minutos variables** (:09, :05). Por eso «Próxima lectura» ya no se ancla a la frontera de reloj sino a `generated_at + 15 min`, y dice «En cualquier momento» si esa estimación pasa.
- **Bug corregido en producción**: `change24h()` calculaba el % entre los dos últimos puntos del histórico (congelados) mientras el precio venía vivo del API → mostraba BTC en ▲ 0.0 % verde cuando realmente caía −1.16 %. Ahora ancla el % al precio mostrado y lo oculta si el histórico no cubre esa ventana ±2h. El arreglo quedó absorbido dentro del commit `3d42b6b` del rediseño.
- **Fase 2 operativa en producción**: `/js/vendor/chart.umd.js` responde HTTP 200 con 206670 bytes; el forecast real está fresco y anclado desde las 11:52:05 CDMX, con 48 puntos para BTC y ETH.
- La fase consumió un único deploy productivo de **15 créditos**. Los commits posteriores que solo actualizaron documentación fueron ignorados por Netlify y no generaron deploy.

## Hueco del histórico congelado: RESUELTO

El histórico ya no depende del bootstrap. `refresh-history.mjs` reescribe la ventana de 30 días en Blobs cada 6h y `GET /api/history?asset=` la sirve; `data/history/` quedó como seed de fallback. Se descartó la opción del Action diario que commitea: **habría costado 450 créditos/mes contra un presupuesto de 300** (ver `06_PRESUPUESTO.md`).

**Decisión aplicada en Fase 2**: el diseño original decía commitear `models/model_YYYYMMDD.json` a diario. Eso no cabe en el presupuesto; `train.yml` escribe el artefacto a Blobs con `NETLIFY_AUTH_TOKEN` + `NETLIFY_SITE_ID` sin tocar el repo.

## Reparto de la Fase 2 (decidido por Antonio, 2026-07-16)

- **Construye: Codex** (sesión con `AGENTS.md` y `.codex/agents/`).
- **Revisa: Claude** al final de la fase, antes de darla por cerrada — el checklist de `04_QA.md` no se ejecuta a sí mismo dos veces: quien construye no es quien cierra.
- **Coordinación**: una sola herramienta a la vez sobre el working tree. Durante la Fase 2, Claude no toca el repo salvo para la revisión (en esta fase ya hubo un fix absorbido por un `git add -A` ajeno; ver bitácora).

## Siguiente paso (uno solo)

➡️ Preparar la Fase 3 —`predictions_log`, evaluación y accuracy real medida— sin implementarla hasta documentar su alcance y completar su apertura formal.

**Restricción de diseño ya decidida para la Fase 2**: el artefacto del modelo NO se commitea al repo (cada commit = deploy de 15 créditos). `train.yml` lo escribe a Netlify Blobs con `NETLIFY_AUTH_TOKEN` + `NETLIFY_SITE_ID` como secrets de GitHub. Ver `06_PRESUPUESTO.md` §4.

**Prerequisito de Antonio — COMPLETO el 19 jul**: repository secrets confirmados por nombre en GitHub Actions:
1. `NETLIFY_AUTH_TOKEN` — se genera en Netlify: User settings → Applications → Personal access tokens.
2. `NETLIFY_SITE_ID` — ya conocido: `3cf1b734-b2b4-4b52-b8a2-a215aae09153` (el "Project ID" de likelycoin).

**Recordatorios de presupuesto para quien construya** (`06_PRESUPUESTO.md`): iterar en `feature/*` o `dev` (branch deploys gratis), batchear el merge a `main` (cada uno = 15 créditos), y los pushes solo-docs no construyen. Plan B del modelo si Prophet da guerra >1 sesión: statsmodels o GBM ligero (R-07) — el contrato del artefacto es agnóstico.
