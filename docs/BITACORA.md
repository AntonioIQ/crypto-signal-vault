# BITÁCORA — historial de sesiones de trabajo

> Append-only, entradas más recientes arriba. Cada sesión de trabajo agrega una entrada: fecha, qué se hizo, decisiones tomadas. La foto actual vive en [STATUS.md](STATUS.md).

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
