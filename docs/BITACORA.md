# BITÁCORA — historial de sesiones de trabajo

> Append-only, entradas más recientes arriba. Cada sesión de trabajo agrega una entrada: fecha, qué se hizo, decisiones tomadas. La foto actual vive en [STATUS.md](STATUS.md).

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
