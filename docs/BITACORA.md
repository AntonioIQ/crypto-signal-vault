# BITÁCORA — historial de sesiones de trabajo

> Append-only, entradas más recientes arriba. Cada sesión de trabajo agrega una entrada: fecha, qué se hizo, decisiones tomadas. La foto actual vive en [STATUS.md](STATUS.md).

---

## 2026-07-21 — FASE 4 CERRADA ✅ — el chat está vivo

**Revisión (Claude):** APTA PARA MERGE, sin bloqueantes ni mayores. Tres observaciones menores de conservadurismo (rate limit global cobra tokens a preguntas que no llegan al LLM; bytes como proxy de tokens; filtros de salida amplios) — todas seguras, no bloqueantes. El trabajo de Codex es de alta calidad, con 132 tests que cubren rechazo de asesoría, inyección de prompt, aislamiento de la key, CORS y rate limit.

**Merge y activación:** PR #3 mergeada a `main` (`4237c50`), 1 deploy. `GROQ_API_KEY` puesta bien desde el inicio, pero `CHAT_ENABLED` no se guardó antes del merge → `/api/chat` respondía `enabled:false`. Antonio creó la variable y disparó un redeploy manual; **segundo deploy** (30 créditos en total para la fase).

**Verificado en producción contra Groq real:**
- `GET /api/chat` → `enabled:true`.
- "¿Qué tan seguro está el modelo?" → `degraded:false` (respuesta real de Groq) con confianzas medidas BTC 72.5 % / ETH 87.5 %.
- "¿Debo comprar bitcoin?" → rechazada por el clasificador **sin llamar a Groq**: "No puedo decirte si debes comprar, vender o cuándo entrar… no es asesoría financiera". La regla de oro #3 en vivo.
- La sección "Pregúntale a tu analista" aparece en el sitio con disclaimer, 3 botones rápidos e input.

**Lecciones operativas:** (1) commitear temprano y seguido — el trabajo sin commitear de Codex casi se pierde con el fin de créditos. (2) Crear TODAS las env vars antes del merge que las necesita — el flag faltante costó un deploy extra.

**Roadmap:** Fases 1–4 completas y en línea. No hay Fase 5 obligatoria.

---

## 2026-07-21 — Fase 4 construida por Codex; Claude preserva el trabajo

**Qué pasó:** Codex arrancó la Fase 4 (el chat del Analista) y la dejó casi completa —132 pruebas Node verdes, build OK— pero **se quedó sin créditos antes de commitear**. El working tree quedó intacto pero sin commit ni push: a un `git stash` o un cierre de sesión de distancia de perderse.

**Qué hice:** verifiqué el estado (todo compila, 132 tests pasan, Python intacto, cero fuga de `GROQ_API_KEY` en `public/`), revisé las piezas críticas (CORS, `CHAT_ENABLED` deny-by-default, aislamiento del proveedor, rechazo de asesoría por clasificador antes de llamar al LLM, presupuesto de bytes del prompt) y **commiteé el trabajo tal cual, atribuido a Codex** (`398f481`), luego lo pusheé a `feature/phase-4-analyst`. Completé STATUS/BITÁCORA, que eran lo único que Codex no alcanzó (sí actualizó `01_ARQUITECTURA.md`).

**Lección operativa:** commitear temprano y seguido. El trabajo de un agente sin commitear es frágil ante el fin de créditos. En adelante, checkpoints commiteados en la rama feature (gratis, sin deploy) en vez de un solo commit al final.

**Estado:** el código es de Codex; Claude no escribió lógica de la fase, así que la revisión externa de Claude sigue siendo legítima. Pendiente: revisión, merge único, y `GROQ_API_KEY` + `CHAT_ENABLED=true` en Netlify (prerequisito de Antonio).

---

## 2026-07-21 — FASE 3 CERRADA ✅

**Codex confirmó APTA** tras verificar que los 6 hallazgos quedaron resueltos (segunda pasada sobre `047b95c…568dba3`), con un único residual no bloqueante: `baselinePath` opcional en llamadas directas al publicador. Lo cerré haciéndolo obligatorio en el CLI canónico (`3a0b606`), la biblioteca conserva su default seguro.

**Merge y activación (hechos por Claude con autorización de Antonio):**
- PR #2 mergeada a `main` (`934a78b`). Netlify desplegó la Fase 3 en ~10 s (app.js con `accuracyView`). Un solo deploy de 15 créditos.
- Primera corrida real de `Daily prediction evaluation` (run `29877442181`): **success** en los 15 steps, incluida la publicación a Netlify Blobs sobre un log vacío.
- Verificado en producción: `/api/latest` trae `accuracy.status: available` con ambos activos `insufficient_data` / muestra 0 (correcto: nada medido aún). La UI muestra «MIDIENDO (0)» en BTC y ETH, precio y pronóstico intactos, sin errores de consola.

**Estado del ciclo:** `predict` (cada 15 min) ya corre con el código nuevo y registra predicciones al anclar; `evaluate` corre a diario. La primera accuracy con porcentaje aparece cuando se acumulen ≥20 predicciones resueltas por activo (~48 h). Resumen completo en `CHANGELOG.md`.

**Siguiente:** dejar acumular; luego Fase 4 (el chat del Analista).

---

## 2026-07-21 — Fase 3: correcciones de la revisión de Codex

Codex revisó la PR #2 y encontró 1 bloqueante, 4 mayores y 1 menor — una revisión buena, casi todo real. Corregidos los seis:

- **Bloqueante (pérdida de predicciones por concurrencia):** `predict.mjs` y el `evaluate` diario hacían read-modify-write del log completo sin control de concurrencia; si `predict` agregaba entre la descarga y la publicación, el republish del día lo perdía. Añadí `netlify/lib/blob-log.mjs` con compare-and-swap por ETag y reintento; el recorder lo usa, y el publicador además hace merge con el baseline descargado para conservar cualquier append concurrente. Prueba de concurrencia real.
- **Mayor (accuracy sin umbral):** el contrato aceptaba `available` con 1 muestra. Ahora impone ≥20 para `available`, <20 para `insufficient_data`, y `window_days===7`; la UI repite el guard.
- **Mayor (verdad semántica del registro):** el validador solo miraba forma. Ahora recalcula `direction` desde `predicted/anchor`, verifica `hit` contra el precio real, y exige `resolved_at ≥ target_at`.
- **Mayor (store predictions no aislado):** `getStoreFn(PREDICTIONS_STORE)` estaba en el try general de ingesta; un fallo del factory devolvía stale con precio null. Movido a su propio try.
- **Mayor (health no detectaba huecos):** `data_health` corría sobre el sufijo contiguo (sin huecos por construcción). Separé `normalized_hourly_series` (completa) de `contiguous_suffix`; evaluate usa la completa para resolución y health, y cuenta separaciones > 1 h.
- **Menor (rotación inexistente):** la doc prometía `log/archive/` nunca implementado. Ajusté §2.4 a la retención real (poda 30 d) y a «por activo».

**Verificación:** 94 Node + 39 Python verdes; build, audit, diff limpios; e2e Python→JS revalidado con el contrato endurecido (25 predicciones, todas pasan las nuevas verificaciones semánticas). Sin merge ni deploy.

**Pendiente:** re-revisión de Codex, merge único, primera corrida real de `evaluate.yml`.

---

## 2026-07-21 — FASE 3 construida por Claude (pendiente revisión de Codex)

**Reparto invertido:** esta fase la construye Claude y la revisa Codex, para que quien construye no sea quien cierra.

**Decisión de arquitectura (documentada antes del código, `01_ARQUITECTURA.md` §2.4):** el registro de predicciones y las métricas son estado mutable que crece a diario → **viven en Netlify Blobs, nunca en el repo**. El `data/predictions_log.json` commiteado del diseño original queda descartado por presupuesto (un commit diario = 450 créditos/mes). Store dedicado `predictions` con `log/current.json`, `metrics/accuracy.json`, `metrics/health.json`.

**Construido:**
- `netlify/lib/contract-helpers.mjs`: helpers de validación compartidos (extraídos para no reintroducir la duplicación que la revisión de Fase 2 marcó; no toqué `forecast-contract.mjs`).
- `netlify/lib/prediction-contract.mjs`: contrato `prediction-log/1.0` (registro + bloque público `accuracy`), id horario idempotente, dedup, direcciones con umbral 0.5 %.
- `netlify/lib/prediction-store.mjs` + `predict.mjs`: registra una predicción por activo al anclar un forecast `fresh`, aislado; y lee el bloque `accuracy` para el snapshot. Un fallo del store no rompe el precio.
- `netlify/lib/market-contract.mjs`: `accuracy` como campo opcional compatible del snapshot `1.0` (igual que `forecast`).
- `ml/evaluate.py`: resuelve predicciones vencidas contra el precio real más cercano ±1h (sin interpolar), calcula accuracy rolling de 7d (≥20 muestras o `insufficient_data`), reporta huecos/pendientes, y poda el log a 30d.
- `scripts/publish-evaluation.mjs` + `.github/workflows/evaluate.yml` (07:30 UTC): descarga el log, corre `evaluate.py`, valida y publica a Blobs con secrets. Cero commits, cero deploys.
- UI: `forecast-ui.js accuracyView` + tarjeta «Precisión de 7 días» cableada en `app.js`.

**Verificación:** 85 Node + 38 Python verdes; build, `node --check`, `git diff --check` OK. E2e: el JSON de `evaluate.py` pasa la validación JS al publicar y al leer; 25 predicciones sintéticas resueltas al 100 %. Navegador: BTC «58 % / 96 medidas», ETH «— / MIDIENDO (11)», sin errores de consola.

**Un test de Fase 2 se actualizó** (`forecast-functions.test.mjs`): ahora `runPrediction` toca también el store `predictions`, así que su aserción de stores incluye `predictions` — comportamiento nuevo y legítimo, no un aflojamiento.

**Pendiente:** revisión de Codex, merge único y primera ejecución real de `evaluate.yml`.

---

## 2026-07-21 — FASE 2 CERRADA ✅

**Pipeline real verificado:** `Daily forecast training` #1 —run `29854592038`, job `88715662743`, sobre `main` en `a44db3e`— terminó en **success**. Ejecutó 26 pruebas Python, 72 Node, entrenamiento y publicación. El artefacto `20260721T175020Z-a44db3e34bc969fc02f31132bcb22bb538c7421d-gh29854592038-1` quedó publicado y verificado en Netlify Blobs.

**Anclaje y producto:** una única ejecución directa de `/.netlify/functions/predict` respondió HTTP 200 y ancló a `2026-07-21T11:52:05-06:00`. `/api/latest` quedó fresco (`stale: false`, `forecast.status: fresh`) con 48 puntos para BTC y 48 para ETH. BTC reportó dirección `down`, −3.1511 % y confianza 72.5 % con muestra 40; ETH, `down`, −3.4374 % y confianza 87.5 % con muestra 40. La accuracy permanece ausente hasta que la Fase 3 la mida contra el log real.

**QA final:** la UI productiva pasó desktop y 390 px con BTC/ETH, línea punteada, lenguaje simple, «Datos al día», entrenamiento 11:50 CDMX, cero consola y cero overflow. QA-Guardian aprobó sin hallazgos; Chart.js es byte-idéntico a 4.4.9 y no usa jsDelivr. El checklist de `docs/04_QA.md` quedó completo: CI/tests, responsive, dark fijo —tema del sistema no aplica—, estados cubiertos por tests, disclaimers, sin debug ni claves, redondeo/CDMX, Lighthouse remoto limpio 98/100 y docs actualizados. Claude ya había confirmado **«CONFIRMACIÓN FINAL FASE 2: APTA PARA MERGE»** sin hallazgos.

**Presupuesto:** hubo un solo deploy productivo de 15 créditos. Los commits posteriores solo-documentación fueron ignorados por Netlify y no desplegaron.

**Deuda no bloqueante:** GitHub Actions advierte que actions v4 apuntan a Node 20 y las fuerza a Node 24. El run pasó; revisar el upgrade al preparar Fase 3.

**Siguiente:** preparar Fase 3 (`predictions_log`, evaluación y accuracy real) sin implementarla todavía.

---

## 2026-07-21 — Handoff de autenticación para el primer training

Antonio autorizó iniciar `Daily forecast training` desde el navegador integrado. La página del workflow abrió correctamente, pero GitHub mostró la sesión cerrada; se dejó visible la pantalla oficial de acceso para que Antonio inicie sesión sin compartir credenciales. Al responder «listo», Codex continuará con **Run workflow**, validación de la publicación en Blobs y cierre de Fase 2.

---

## 2026-07-21 — Fase 2 integrada; activación del forecast pendiente

**Revisión y merge:** Claude confirmó exactamente **«CONFIRMACIÓN FINAL FASE 2: APTA PARA MERGE»**, sin hallazgos. La PR #1 quedó integrada por fast-forward estricto a `main` en `4a41cb7`.

**Producción verificada:** Netlify ya sirve `/js/vendor/chart.umd.js` con HTTP 200 y 206670 bytes. `/api/latest` continúa entregando un snapshot fresco, pero legacy y todavía sin `forecast`; la señal aparecerá después de ejecutar `Daily forecast training` y de que posteriormente corra `predict`.

**Bloqueo operativo:** el conector de GitHub carece de permisos para Actions y merge, mientras que `gh` local tiene autenticación inválida. El siguiente paso único es obtener autorización de Antonio para usar el navegador con su sesión y pulsar **Run workflow**, o que él pulse el botón directamente. La Fase 2 permanece abierta hasta publicar y verificar el primer forecast real.

---

## 2026-07-21 — M1 validado en el deploy remoto limpio

**Publicación de la rama:** los fixes de la revisión externa y Chart.js local quedaron en `feature/phase-2-model` hasta `9f01ea0`. La CI de GitHub y el Deploy Preview de Netlify terminaron en verde; producción permaneció intacta.

**Medición transparente:** Lighthouse móvil sobre la URL colaborativa del preview marcó 78 performance y 1.72 MiB transferidos. El desglose mostró que Netlify Drawer inyectó tres videos y varios scripts ajenos al build. Se repitió la prueba sobre el permalink inmutable del mismo deploy `6a5fa9eceab5c90008c48303`, superficie que [no admite el Drawer](https://docs.netlify.com/deploy/review-deploys/netlify-drawer-for-feedback/troubleshoot-the-netlify-drawer/): **98 performance, 100 accesibilidad, 100 Best Practices**, FCP 0.8 s, LCP 1.5 s, TBT 70 ms, CLS 0 y solo 103 KiB transferidos. El SEO 60 corresponde al `noindex` del preview, no a producción.

**Resultado:** M1 queda cerrado local y remotamente; el umbral móvil de performance ≥85 se supera por 13 puntos en el artefacto limpio. Las cinco observaciones menores de Claude están resueltas y verificadas. Falta únicamente pedir su confirmación breve sobre `8f388fd..9f01ea0`; con esa confirmación se hará un solo merge a `main` y después la primera ejecución manual de `Daily forecast training`.

---

## 2026-07-21 — Chart.js local cierra M1 en QA local

**M1 resuelto localmente:** `chart.js` quedó fijado exactamente en `4.4.9`. El build copia el bundle oficial `dist/chart.umd.js` a `public/js/vendor/chart.umd.js`; el frontend lo carga dinámicamente sin CDN y conserva el fallback si Chart.js no está disponible.

**Validación:** Front-UX y QA-Guardian aprobaron el cambio. Pasaron 72 pruebas Node y 26 Python, además de build, `node --check`, `git diff --check` y `npm audit` con 0 vulnerabilidades. La revisión local en desktop y 390 px mostró BTC/ETH, gráfica y pronóstico correctos, sin overflow ni errores de consola. Lighthouse móvil local midió **93 performance, 100 accesibilidad, 100 Best Practices y 100 SEO**, con FCP 1.0 s, LCP 3.2 s, TBT 10 ms y CLS 0.001.

**Sin efectos remotos:** todavía no hubo commit, push, Deploy Preview nuevo ni deploy de producción. El siguiente paso es publicar el delta batched en `feature/phase-2-model`, esperar CI/preview gratuitos, repetir Lighthouse remoto y pedir a Claude una confirmación breve antes del merge.

---

## 2026-07-20 — Revisión de continuidad de Fase 2

Sin cambios de código ni deploy. La Fase 1 sigue cerrada y la Fase 2 conserva un único pendiente técnico local: servir Chart.js desde el propio build y repetir Lighthouse móvil. Después siguen la confirmación externa, un único merge batched y la primera ejecución manual de training.

---

## 2026-07-19 — Claude aprueba Fase 2; checkpoint de observaciones menores

**Revisión externa recibida:** Claude revisó la PR #1 en `8f388fd` y concluyó **«APROBACIÓN EXTERNA FASE 2: APTA PARA MERGE»**, sin bloqueantes ni hallazgos mayores. Reportó cinco observaciones menores.

**Cuatro observaciones corregidas en el checkpoint local:**
- El publicador ya importa el validador estricto del runtime; se eliminó la implementación duplicada y se agregó una prueba de que aplica el mismo contrato temporal.
- Una falla al leer o anclar el pronóstico ahora emite un warning controlado sin exponer el error ni secretos, manteniendo disponible el precio fresco.
- La CI de PR ahora ejecuta también las 26 pruebas Python en Python 3.12.
- Se retiró `requests` de `ml/requirements.txt` porque no se usa.

**Verificación:** 69 pruebas Node + 26 Python, build y sintaxis verdes. No se hizo merge ni deploy de producción.

**Pendiente para retomar:** resolver M1 instalando `chart.js@4.4.9` para servirlo desde el propio build y repetir Lighthouse móvil. El primer intento de descarga quedó bloqueado por DNS del sandbox; se retiró el cambio incompleto antes de pausar, por lo que el repo conserva un build funcional. Luego corresponde subir el delta, pedir a Claude una confirmación breve sobre los cambios y hacer el único merge productivo.

---

## 2026-07-19 — Secrets listos, PR verde y Lighthouse aprobado

**Desbloqueo externo:** Antonio creó `NETLIFY_AUTH_TOKEN` y `NETLIFY_SITE_ID` como repository secrets de GitHub Actions. Se verificaron únicamente sus nombres; los valores nunca salieron del almacén de GitHub.

**Validación remota sin tocar producción:**
- PR en borrador #1 creada desde `feature/phase-2-model` hacia `main`.
- GitHub Actions CI verde y Netlify Deploy Preview listo en `https://deploy-preview-1--likelycoin.netlify.app`.
- El primer Lighthouse móvil marcó 76 performance: Chart.js bloqueaba el pintado inicial y faltaba favicon.
- Corrección: Chart.js ahora carga en segundo plano y el precio/señal sobreviven si falla el CDN; se agregó favicon SVG propio y prueba de que el HTML inicial no vuelve a bloquearse con Chart.js.
- Resultado posterior: **Lighthouse desktop 99 performance / 100 accesibilidad / CLS 0 / TBT 0 ms**. Móvil quedó en 81 / 100, sin errores de consola; se documenta como riesgo de mejora. SEO 60 del preview se explica por el `noindex` que Netlify inyecta en esa superficie, mientras producción ya había medido SEO 100.
- Suite ampliada a **68 Node + 26 Python**; CI volvió a pasar después de la corrección.

**Producción sigue intacta:** no hubo merge ni production deploy. El próximo paso obligatorio es la revisión externa de Claude acordada para Fase 2. Si aprueba, se hará un solo merge y después la primera ejecución controlada de `Daily forecast training` contra Netlify Blobs.

---

## 2026-07-17 — Fase 2 visible: anclaje aprobado y línea punteada terminada

**Runtime 2.4 cerrado por QA:**
- `latest → previous` ahora también recupera un artefacto previo cuando `latest` contiene bytes JSON malformados; una falla real del store permanece aislada y no rompe el precio vivo.
- Todo snapshot seed nuevo incluye explícitamente `forecast: { status: "unavailable" }`; la omisión queda reservada a seeds legacy.
- QA-Guardian aprobó el paquete sin hallazgos después de las correcciones.

**UI 2.5 implementada y aprobada:**
- La gráfica une el precio ancla con exactamente 48 puntos futuros mediante una línea punteada, distinguible sin depender solo del color.
- Dirección en lenguaje simple: «Probablemente suba», «Probablemente baje» o «Probablemente se mantenga».
- La confianza solo muestra porcentaje cuando está medida; con evidencia insuficiente dice «Aún no medible». La precisión de 7 días permanece vacía hasta Fase 3.
- Estados `fresh`, `stale` y `unavailable` explícitos; un forecast ausente o parcial no dibuja puntos ni inventa señal.
- El último motivo circular del panel fue reemplazado por una línea sobria para mantener la identidad profesional de LikelyCoin.
- Revisión visual local en desktop y 390 px: BTC/ETH, pronóstico disponible/no disponible, sin overflow ni errores de consola. Una regla CSS que mostraba la leyenda punteada sin forecast se detectó y corrigió durante esta revisión.

**Verificación:** 67 pruebas Node + 26 Python verdes, build y `git diff --check` correctos. QA-Guardian aprobó 2.4 y 2.5 sin pendientes de código.

**Pendiente externo:** GitHub Actions sigue sin `NETLIFY_AUTH_TOKEN` ni `NETLIFY_SITE_ID`; no puede hacerse todavía la primera publicación real a Blobs. Después faltan Lighthouse sobre branch deploy, revisión externa de Claude y el merge único a `main`.

---

## 2026-07-16 — Fase 2 iniciada: núcleo del modelo, publicación y anclaje

**Arquitectura primero:**
- Contrato `forecast-artifact/1.0` documentado con 48 factores relativos, dirección `up/down/flat`, confianza rolling-origin separada de accuracy, frescura/expiración y rollback `latest → previous`.
- Estado mutable del modelo en Netlify Blobs (`model-artifacts`); el workflow diario no hace commits, pushes ni deploys.
- Snapshot público extendido de forma compatible con un bloque `forecast` anclado al precio vivo.

**Implementado en `feature/phase-2-model`:**
- `ml/features.py` y `ml/train.py`: Prophet lazy, histórico reciente/contiguo sin interpolación, 48 pasos, validación estricta, confianza con mínimo 20 folds y CLI offline atómico.
- Prophet 1.3.0 probado realmente con históricos públicos frescos: 42 ajustes BTC/ETH en ~17 s y artefacto válido.
- `train.yml` diario + publicador Blobs con versión inmutable, read-back fuerte byte a byte, rollback y gate obligatorio a `main`.
- Anclaje runtime en `predict.mjs`: fresh/stale/unavailable independiente del precio; 48 timestamps/precios sin exponer factores internos.

**QA:**
- ML offline y workflow/publicador aprobados después de corregir hallazgos de frescura, huecos, versionado, falso `modified:true`, validación JS y dispatch desde ramas.
- Estado al checkpoint: **26 pruebas Python y 57 Node verdes**; `git diff --check` limpio.

**Bloqueante externo para la primera publicación real:** faltan en GitHub Actions `NETLIFY_AUTH_TOKEN` y `NETLIFY_SITE_ID`. Los valores no deben compartirse por chat.

**Siguiente:** repase QA del anclaje runtime, frontend con línea punteada/dirección/confianza y revisión final de Claude antes del merge único a `main`.

---

## 2026-07-16 — FASE 1 CERRADA ✅ (checklist 1.10: 9/9)

**Checklist ejecutado contra producción, no contra suposiciones:**
- Estado de **error** forzado (sitio servido sin datos): banner rojo, «Sin datos», sin % inventado. Estado **stale** forzado (snapshot de −5h): «Datos de hace 5 horas», precio último conocido, «En cualquier momento». **Cargando** garantizado por construcción; **fresco** observado en producción.
- Móvil 390px y desktop sin desbordamiento horizontal (medido con `scrollWidth` vs `innerWidth`, no a ojo).
- **Lighthouse (primera medición del proyecto): performance 94, accesibilidad 100, best practices 96, SEO 100** — los umbrales eran ≥85 y ≥90.
- Sin claves ni logs de debug en el cliente (solo un `console.error` legítimo en la ruta de error).
- Disclaimers renderizados en footer y sección de predicción.

**Cierre:** resumen completo de la fase en `CHANGELOG.md`. Entregable: https://likelycoin.netlify.app operando 24/7 a costo $0, con 5+ corridas automáticas verificadas del cron de 15 min y el histórico auto-refrescándose cada 6h.

**Siguiente:** FASE 2 — el modelo y la línea punteada. Restricción ya decidida: el artefacto va a Blobs vía `train.yml` (secrets `NETLIFY_AUTH_TOKEN` + `NETLIFY_SITE_ID`), nunca commiteado.

---

## 2026-07-16 — Precio cada 15 minutos: «EN VIVO» se vuelve cierto

**El planteamiento de Antonio:** ¿por qué no cada 15 min desde ya, en vez de diferirlo a una fase posterior? Tenía razón: cambiar el schedule es **una línea de configuración**, no una feature, y el argumento de diferirlo se caía solo — íbamos a hacer un deploy de todas formas para corregir el copy, y subiendo la cadencia ese copy ya no necesita corrección.

**La cuota que sí manda:** verificada la de CoinGecko Demo = **100 llamadas/min, 10,000 créditos/mes**. `predict` cada 15 min (~2,880/mes) + `refresh-history` cada 6h (~240) = **31% de la cuota**. Cada 5 min llegaría al 89%: ahí sí está el techo. En Netlify el costo es de ~16 créditos/mes de compute (los crons se pagan por GB-hora, no por deploy).

**Hecho:**
- `predict` pasa de `@hourly` a `*/15 * * * *`, 24/7.
- Copy alineado con la realidad: «Frecuencia: cada 15 minutos» y badge «CADA 15 MINUTOS».
- **«Próxima lectura» ya no miente**: se calcula como `generated_at + 15 min` (anclada a la última corrida real, no a la frontera de reloj) y dice «En cualquier momento» cuando esa estimación pasa. Antes prometía la hora en punto y el scheduler llegaba a los :05–:09.
- Umbral de `stale` de 2h → **1h** (4 corridas perdidas): con cadencia de 15 min, seguir diciendo «Datos al día» a las 2 horas era la misma sobrepromesa que «EN VIVO».

**Descartado:** restringir los crons a ciertas horas del día. Ahorra una cuota que no falta (estamos al 31%) y rompe el propósito de portafolio: los visitantes están en cualquier huso horario y el cripto se mueve 24/7 — de madrugada el sitio mostraría un precio de 8 horas y parecería abandonado.

**Verificado local:** con snapshot de hace 49 min → «En cualquier momento»; con snapshot recién generado (17:54) → «18:09 (CDMX)». 28 pruebas verdes.

**Verificado en producción (18:22):**
- **Cadencia de 15 min confirmada**: corridas a las 18:08:55 y 18:18:55 — los slots de `*/15` con deriva variable (8:55 y 3:55 de retraso). **Netlify sí honra cadencias sub-horarias en el plan Free**; no se dio por bueno el copy «Cada 15 minutos» hasta observarlo, porque de no cumplirse habría sido la misma sobrepromesa que se estaba corrigiendo.
- **Tarea 1.5 cerrada**: 4 corridas automáticas observadas (16:09, 17:05, 18:08:55, 18:18:55), ninguna coincidente con un deploy.
- **`refresh-history` estrenada**: primera corrida automática a las 18:04:49 (slot de 00:00 UTC), 721 puntos con el último de las 18:04 de hoy. El histórico congelado quedó resuelto de punta a punta: la gráfica se sirve de `/api/history` con datos de hace minutos, no del bootstrap del 15 de julio.
- Cadena completa: precio USD 63,840 de las 18:18, «−1.4 %» en rojo, «Datos al día», «Próxima lectura 06:33 p.m.» (= 18:18 + 15 min).

---

## 2026-07-16 — El presupuesto de Netlify redefine la arquitectura del estado

**El hallazgo:** la cuenta Free tiene **300 créditos/mes y cada production deploy cuesta 15** — todo lo demás (requests, compute, bandwidth) suma <1 crédito. El presupuesto real son **~20 deploys/mes**, y **si se agotan los créditos el sitio se pausa**. Documentado en el nuevo [`06_PRESUPUESTO.md`](06_PRESUPUESTO.md).

**Lo que esto mató:** la propuesta de refrescar el histórico con un Action diario que commitea. Un commit diario = un deploy diario = **450 créditos/mes contra 300 disponibles**: aritméticamente imposible. La misma cuenta invalida el plan original de commitear `models/model_YYYYMMDD.json` a diario en Fase 2.

**La regla que queda:** el repo solo cambia cuando cambia **código**; todo estado mutable vive en **Netlify Blobs**. Agregada a las reglas de oro de `CLAUDE.md` y `AGENTS.md`.

**Hecho:**
- `refresh-history.mjs`: scheduled cada 6h, reescribe la ventana completa de 30 días en Blobs (overwrite idempotente y auto-sanable: una corrida perdida no deja hueco, y hay 3 reintentos antes de que el % de 24h se degrade a las 26h). ~240 llamadas/mes a CoinGecko contra una cuota de 10k.
- `history.mjs`: `GET /api/history?asset=` sirve el blob; 404 ante blob ausente o corrupto para que el cliente use el seed del build.
- `isValidHistoryDocument()` en el contrato: valida lo que se lee de Blobs, incluido que el activo coincida con la key.
- Frontend: `loadHistory()` pide el endpoint y cae al seed estático. Verificado local: sin endpoint, cae al seed y la gráfica renderiza los 721 puntos.
- **`ignore` en `netlify.toml`**: los pushes que solo tocan `docs/` o `*.md` cancelan el build. Con STATUS/BITACORA actualizándose cada sesión, esto solo salva varios deploys al mes (el commit de STATUS de hoy costó 15 créditos por puro texto).
- 28 pruebas verdes (11 nuevas: aislamiento por activo, ventana previa preservada ante fallo del proveedor, 404 → seed, 400 en activo desconocido, 405, outage de storage).

**Observado en producción:** el schedule `@hourly` de Netlify dispara ~a los **:09**, no en punto. La tarjeta «Próxima lectura» promete la hora exacta y llega ~9 min tarde — pendiente de corregir.

**Siguiente:** verificar el blob del histórico en producción, 3 corridas de `@hourly`, y cerrar 1.10.

---

## 2026-07-16 — Primer deploy productivo en Netlify (1.2–1.4)

**Hecho:**
- Repo `AntonioIQ/crypto-signal-vault` conectado desde `main` al nuevo proyecto Netlify `likelycoin`.
- Build productivo confirmado con `npm run build`, publish directory `public` y functions directory `netlify/functions`.
- Variable privada `COINGECKO_DEMO_API_KEY` configurada por Antonio en Netlify.
- Sitio público `https://likelycoin.netlify.app` y `GET /api/latest` verificados con HTTP 200.
- `predict` ejecutada manualmente a las 14:09 CDMX: escribió en Netlify Blobs un snapshot fresco (`stale: false`) con precios reales de BTC y ETH.
- UI productiva verificada con «Datos al día», BTC renderizado, siguiente actualización horaria, sin errores de consola ni desbordamiento horizontal.

**Resultado:**
- Tareas 1.2, 1.3 y 1.4 cerradas.
- Tarea 1.5 en curso: la función y el schedule `@hourly` están desplegados; faltan tres corridas automáticas consecutivas para validar la operación horaria.

**Corrección visual solicitada:**
- Se confirmó que producción todavía mostraba el encabezado provisional con esfera y una estética demasiado básica.
- Se documentó **LikelyCoin** como marca pública; Crypto Signal Vault permanece como nombre interno del repo y arquitectura.
- Frontend rediseñado con marca geométrica de señal, paleta oscura sobria, jerarquía editorial, precio/gráfica protagonistas y cero emojis decorativos.
- Añadida atribución visible del plan Demo de CoinGecko.
- QA local en 1440px y 390px: BTC/ETH cambian correctamente, sin errores de consola ni desbordamiento horizontal; 17 pruebas verdes.
- Commit `3d42b6b` publicado en `main`; Netlify desplegó el rediseño automáticamente.
- Producción verificada con marca LikelyCoin, sin esfera, precio real, estado «Datos al día», sin errores de consola ni overflow. Snapshot fresco observado a las 16:09 CDMX.

**Siguiente:** comprobar tres avances consecutivos de `generated_at` y ejecutar el checklist de QA 1.10.

---

## 2026-07-16 — Fase 1 casi cerrada: datos, functions, frontend y CI (1.4, 1.6–1.9)

**Hecho:**
- Capa de datos: `netlify/lib/coingecko.mjs` (abstracción del proveedor, timeout 8s + 2 reintentos, header `x-cg-demo-api-key` opcional) y `netlify/lib/market-contract.mjs` (contrato, validación y timestamps en CDMX).
- `netlify/functions/predict.mjs` (scheduled horaria → escribe blob) y `netlify/functions/latest.mjs` (`GET /api/latest`), ambos con fallback a seed stale.
- Bootstrap del histórico corrido: `data/history/{btc,eth}.json` con ~720 puntos horarios de 30 días cada uno.
- Frontend real: precio grande, tabs BTC/ETH, gráfica de 30 días con Chart.js (`spanGaps` por R-11), estados cargando/fresco/stale/error, tarjetas de MLOps con badges "Fase 2/3", disclaimers y timestamp en CDMX.
- Suite de pruebas (17 verdes) + `.github/workflows/ci.yml`.
- Verificación local en navegador: BTC y ETH renderizan con datos reales; sin errores de consola.

**Decisiones:**
- Cerrada la duda del refresh horario: Netlify Blobs como estado vivo + `/api/latest`, seed versionado como fallback (ver STATUS.md y 01_ARQUITECTURA.md §1).
- El snapshot stale **no adelanta `generated_at`**: esa fecha siempre es la de la última ingesta exitosa.
- `public/data/` queda en `.gitignore`: es artefacto de build, se regenera con `npm run build`.

**Bug encontrado y corregido:** la gráfica desbordaba horizontalmente en 375px (los grid items traen `min-width:auto`); se agregó `min-width: 0` a los hijos del contenedor.

**Siguiente:** Antonio conecta Netlify (1.2) y la key de CoinGecko (1.3); eso desbloquea 1.5 y el cierre de fase.

---

## 2026-07-15 — Arranque: scaffold del proyecto (tarea 1.1)

**Hecho:**
- Repo creado en `Some_Scripts_for_chill/crypto-signal-vault` con la estructura completa de `docs/01_ARQUITECTURA.md` §3.
- Handoff maestro (diseño hecho en sesión de claude.ai) dividido en `docs/00–05`.
- 7 subagentes creados en `.claude/agents/` según `docs/03_AGENTES.md`.
- `CLAUDE.md` con las reglas de oro; `README.md` de portafolio; esqueleto de `netlify.toml`, `package.json` y placeholder de `public/` listo para el primer deploy.
- `docs/STATUS.md` + esta bitácora creados para continuidad entre máquinas/sesiones.

**Decisiones:**
- El estado del proyecto vive en el repo (`STATUS.md`/`BITACORA.md`), no en memoria local de una sola máquina.
- Se detectó hueco arquitectónico a resolver en 1.4: el refresh horario de `latest.json` no puede escribir al publish dir → evaluar Netlify Blobs + endpoint vs. refresh solo diario (registrado en STATUS.md).
- Los 7 agentes se usan como roles/checklists, no como pipeline burocrático obligatorio para cada cambio (proteger contra R-03).

**Siguiente:** tareas 1.2/1.3 (Antonio: Netlify + key CoinGecko), luego 1.4 (`predict.mjs` v0).
