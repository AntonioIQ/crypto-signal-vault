# 01 — ARQUITECTURA

### 1. Persistencia y acceso al snapshot vivo

El snapshot canónico en runtime vive en **Netlify Blobs**, en el store site-wide
`market-data` y bajo la key `latest.json`. Netlify Blobs y Netlify Scheduled
Functions están incluidos en el plan gratuito elegido para el proyecto, por lo
que este flujo cumple la restricción de costo cero.

El flujo de Fase 1 es:

1. `netlify/functions/predict.mjs` corre cada hora como Scheduled Function.
2. Consulta CoinGecko desde el servidor para BTC y ETH.
3. Valida y escribe el snapshot completo en `market-data/latest.json`.
4. `GET /api/latest` lee ese blob y lo expone al frontend.
5. El frontend consume únicamente `/api/latest`; **nunca llama CoinGecko de
   forma directa** ni recibe credenciales.

`data/latest.json` no es el estado vivo: es el **seed/fallback versionado** y el
fixture de referencia para validar el contrato. Durante el build se copia a
`public/data/latest.json` cuando corresponda, de modo que el endpoint pueda
usarlo si todavía no existe un blob válido o si el storage no está disponible.

La consulta server-side usa la CoinGecko Demo API o su acceso keyless. Cuando
existe `COINGECKO_DEMO_API_KEY`, `predict.mjs` envía la credencial en el header
`x-cg-demo-api-key`; la variable nunca se expone al navegador ni se versiona.
Cada intento tiene timeout y se permiten **2 reintentos** después del intento
inicial.

Si se agotan los intentos, el proceso conserva los precios y timestamps del
último snapshot válido y solo lo marca con `stale: true`. En particular,
**no adelanta `generated_at`**: esa fecha siempre representa la última ingesta
exitosa. Si aún no existe un snapshot válido, se sirve el seed stale.

### 2. Contratos de datos

#### 2.1 Snapshot multi-asset de Fase 1

Tanto el blob canónico como `data/latest.json` cumplen esta base:

```json
{
  "schema_version": "1.0",
  "generated_at": "2026-07-15T12:00:00-06:00",
  "timezone": "America/Mexico_City",
  "currency": "usd",
  "stale": false,
  "assets": {
    "btc": {
      "id": "bitcoin",
      "symbol": "BTC",
      "name": "Bitcoin",
      "price": 65000.25,
      "source_updated_at": "2026-07-15T17:59:31Z"
    },
    "eth": {
      "id": "ethereum",
      "symbol": "ETH",
      "name": "Ethereum",
      "price": 3500.75,
      "source_updated_at": "2026-07-15T17:59:29Z"
    }
  }
}
```

Reglas del contrato:

- `schema_version` permite evolucionar el documento de manera explícita.
- `generated_at` es ISO-8601 con offset vigente de CDMX y solo cambia tras una
  ingesta exitosa.
- `timezone` vale `America/Mexico_City` y `currency` vale `usd` en Fase 1.
- `assets` contiene obligatoriamente las keys `btc` y `eth`.
- `source_updated_at` conserva el timestamp reportado por la fuente en formato
  ISO-8601.
- `price` es un número positivo. Solo puede ser `null` en el seed con
  `stale: true` cuando todavía no existe ningún dato válido.
- Los campos de forecast, dirección y confianza se agregan en Fase 2 de forma
  compatible, sin eliminar ni cambiar el significado de esta base.

#### 2.2 Histórico por activo

Cada archivo de `data/history/` representa un activo y cumple el siguiente
contrato:

```json
{
  "schema_version": "1.0",
  "asset": "btc",
  "coin_id": "bitcoin",
  "currency": "usd",
  "generated_at": "2026-07-15T12:00:00-06:00",
  "points": [
    { "timestamp": "2026-07-14T18:00:00Z", "price": 64210.5 }
  ]
}
```

`asset` usa la key interna (`btc` o `eth`), `coin_id` usa el identificador de
CoinGecko y `points` se ordena ascendentemente por `timestamp`. Cada punto tiene
un timestamp ISO-8601 y un precio positivo.

**Dónde vive y quién lo refresca.** El histórico vigente es un blob por activo
en el store `market-data`, bajo la key `history/<asset>.json`; lo expone
`GET /api/history?asset=btc`. Los archivos de `data/history/` en el repo son el
**seed versionado** que el build copia a `public/data/`: el frontend pide el
endpoint y cae al seed si no hay blob válido (404) o si el storage falla.

`netlify/functions/refresh-history.mjs` corre cada 6 horas y **reescribe la
ventana completa de 30 días** en lugar de agregar el punto más reciente. El
overwrite es idempotente y auto-sanable: una corrida perdida no deja hueco que
reconciliar, y con 4 corridas diarias hay 3 reintentos antes de que algo se
degrade (el % de 24h aguanta hasta 26h de histórico viejo). Cuesta ~240
llamadas/mes a CoinGecko contra una cuota de 10,000.

Esto reemplaza la idea original de refrescar el histórico commiteando el delta
desde el job de entrenamiento: **cada commit a `main` es un deploy de 15
créditos** y un refresh diario por commit costaría 450 créditos/mes contra un
presupuesto de 300. Ver `06_PRESUPUESTO.md`.

#### 2.3 Contratos de fases posteriores

- **Artefacto del modelo** — el Action **pre-computa el forecast completo de 48h** (pasos horarios) y lo serializa. La scheduled function **solo lo ancla** al precio actual (ajuste de nivel). Esto elimina toda inferencia pesada del lado de Netlify y hace el contrato **agnóstico al modelo** (Prophet, statsmodels, GBM: da igual).
- **`data/predictions_log.json`** — append-only, rotación mensual:

```json
[{ "made_at": "...", "asset": "btc", "horizon_h": 24, "predicted": 65100,
   "direction": "up", "actual": null, "resolved_at": null, "hit": null }]
```

### 3. System prompt del Analista (v1)

```
Eres "el Analista" de Crypto Signal Vault. Respondes SOLO con base en el
CONTEXTO proporcionado (predicción actual, métricas del modelo, precisión
reciente y features usadas). Reglas estrictas:
1. Nunca das asesoría de inversión. Si te piden "¿compro?/¿vendo?/¿cuándo
   entro?", explica amablemente que solo describes lo que ve el modelo.
2. Si la pregunta requiere información fuera del CONTEXTO (noticias, otras
   monedas, macroeconomía), di que no la tienes y ofrece lo que sí sabes.
3. Lenguaje simple, sin jerga financiera. Español latino, tono cercano.
4. Máximo 120 palabras por respuesta.
5. Siempre que menciones la predicción, incluye el % de confianza.
CONTEXTO:
{snapshot_json}
```

### 4. Estructura del repositorio

```
crypto-signal-vault/
├── netlify.toml                  # build, ignore de docs, redirects, crons
├── package.json                  # deps de functions (groq via fetch nativo)
├── public/                       # frontend estático (publish dir)
│   ├── index.html
│   ├── css/styles.css
│   ├── js/app.js                 # render dashboard
│   ├── js/chat.js                # UI del analista
│   └── data/                     # copia de seeds/fixtures durante el build
├── netlify/functions/
│   ├── predict.mjs               # scheduled, horario: precio → blob
│   ├── refresh-history.mjs       # scheduled, cada 6h: ventana 30d → blob
│   ├── latest.mjs                # GET /api/latest: blob + fallback versionado
│   ├── history.mjs               # GET /api/history?asset=: blob, 404 → seed
│   └── chat.mjs                  # on-demand, Groq + rate limit
├── ml/
│   ├── train.py                  # entrenamiento + serialización
│   ├── evaluate.py               # resolución de predicciones + drift
│   ├── features.py
│   └── requirements.txt
├── models/                       # seed del artefacto; el vigente vive en Blobs
├── metrics/                      # seed de métricas; las vigentes en Blobs
├── data/                         # seeds/fixtures de latest.json e history/
├── .github/workflows/
│   ├── ci.yml                    # pruebas + build
│   ├── train.yml
│   └── evaluate.yml
├── docs/                         # documentos 00–06
└── tests/
    ├── test_features.py
    ├── test_train_contract.py    # valida schema de artefactos
    ├── market-contract.test.mjs  # contrato de snapshot e histórico
    ├── functions.test.mjs        # latest/predict: fallbacks y stale
    └── history-functions.test.mjs # refresh/history: aislamiento y 404 → seed
```

**Nada mutable se versiona.** `models/`, `metrics/` y `data/` guardan seeds y
fixtures; lo que cambia a diario u horariamente vive en Blobs, porque cada
commit a `main` cuesta un deploy (`06_PRESUPUESTO.md`).

### 5. Cuota de Groq

El cuello real es **TPM/TPD, no requests/día** → mantener prompts cortos y contexto compacto.

### 6. Convenciones del proyecto

- Idioma de código y commits: **inglés**. Idioma de UI y docs: **español**.
- Ramas: `main` (producción, auto-deploy Netlify), `dev` (integración), `feature/*`.
- Artefactos versionados en `models/` como `model_YYYYMMDD.json` + `metrics_YYYYMMDD.json`.
- Ningún secreto en el repo: `GROQ_API_KEY` y `COINGECKO_DEMO_API_KEY` viven en variables de entorno de Netlify.
- Todo número mostrado al usuario se redondea; toda fecha en zona horaria de **CDMX**.

### 7. Flujos temporales (quién corre cuándo)

| Hora (UTC) | Proceso | Dónde |
|---|---|---|
| 07:00 diario | Entrenamiento + artefacto + métricas → **a Blobs, no al repo** | GitHub Actions |
| 07:30 diario | Evaluación de aciertos + drift | GitHub Actions |
| cada 15 min | Ingesta/anclaje + refresh de `market-data/latest.json` | Netlify Scheduled Fn |
| cada 6 h | Refresh de `market-data/history/<asset>.json` (ventana de 30 días) | Netlify Scheduled Fn |
| on-demand | Chat del analista | Netlify Function |
| en cada push a `main` con código | Redeploy del sitio (**15 créditos**) | Netlify CI |
| en cada push a `main` solo con docs | Build cancelado por el comando `ignore` (0 créditos) | Netlify CI |

**Observado en producción**: el scheduler de Netlify dispara con varios minutos
de retraso y a minutos variables (se observó :09 y :05, no en punto). Por eso la
tarjeta «Próxima lectura» se calcula como `generated_at + 15 min` —anclada a la
última corrida real, no a una frontera de reloj— y cuando esa estimación pasa
dice «En cualquier momento» en lugar de nombrar una hora que no controlamos.

**Por qué 15 minutos y no una hora**: la tarjeta de precio dice «EN VIVO», y con
cadencia horaria eso era falso hasta por 55 minutos. Cuesta ~2,880 de los 10,000
créditos mensuales de CoinGecko (31%) y ~16 de los 300 de Netlify. **Corre 24/7 a
propósito**: es un sitio de portafolio con visitantes en cualquier huso horario y
el cripto se mueve todo el día; una ventana nocturna sin refresh mostraría un
precio de 8 horas de antigüedad a quien lo abra de madrugada.

**Umbral de `stale`**: el frontend marca «Datos de hace N horas» pasada 1 hora sin
ingesta — 4 corridas perdidas. Por debajo de eso, la deriva del scheduler no debe
disparar falsas alarmas.

### 8. Seguridad y privacidad

- `GROQ_API_KEY` solo en env vars de Netlify; jamás en el cliente ni en el repo.
- El frontend nunca habla con CoinGecko ni con otras APIs externas; el snapshot vivo se obtiene de `GET /api/latest` y los fallbacks son JSON estáticos del mismo sitio.
- No se almacenan preguntas del chat ni datos personales; `sessionId` es un UUID efímero generado en el cliente.
- Rate limiting en dos capas (sesión + global) protege la cuota de Groq y evita abuso.
- CoinGecko se consume en modo Demo o keyless solo desde Actions/Functions. Si existe `COINGECKO_DEMO_API_KEY`, se envía como `x-cg-demo-api-key` exclusivamente desde el servidor.

### 9. Escalabilidad y evolución (fuera de alcance v1, documentado para no perderlo)

- Altcoins adicionales: el contrato de `latest.json` ya es multi-asset desde BTC/ETH.
- RAG real con embeddings (Chroma) si el corpus crece (ej. explicaciones históricas por día).
- Migrar storage de JSON-en-repo a Cloudflare R2 free si el histórico pesa.
- Notificaciones push / bot de Telegram cuando la confianza supere umbral.
- Mapa geoespacial de volumen por zona horaria (idea original de visualización geo).
