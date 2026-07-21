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

#### 2.3 Artefacto canónico de forecast de Fase 2

El artefacto vigente vive en Netlify Blobs, en el store site-wide
`model-artifacts` y bajo la key canónica `forecast/latest.json`. El runtime no
lee un artefacto diario del repo. Para recuperación se conservan también
`forecast/previous.json` y la copia inmutable
`forecast/versions/<artifact_version>.json`; todas estas keys están en el mismo
store. El volumen es mínimo y se mantiene dentro del plan gratuito.

El documento es JSON versionado y **agnóstico al modelo**. `train.yml` puede
producirlo con Prophet, statsmodels, GBM u otro algoritmo, pero sus consumidores
solo conocen factores relativos, timestamps y métricas con semántica estable.
Los metadatos de `producer` son informativos: ninguna Function ni componente de
UI puede decidir su lógica a partir del nombre del algoritmo.

```json
{
  "schema_version": "forecast-artifact/1.0",
  "artifact_version": "20260717T070000Z-a1b2c3d-gh987654321-1",
  "artifact_type": "relative_hourly_forecast",
  "generated_at": "2026-07-17T01:00:00-06:00",
  "data_through": "2026-07-17T00:00:00-06:00",
  "valid_until": "2026-07-18T13:00:00-06:00",
  "expires_at": "2026-07-20T01:00:00-06:00",
  "timezone": "America/Mexico_City",
  "currency": "usd",
  "horizon_hours": 48,
  "step_hours": 1,
  "direction_policy": {
    "horizon_hours": 48,
    "flat_threshold_return": 0.005
  },
  "producer": {
    "model_id": "opaque-model-id",
    "code_revision": "a1b2c3d",
    "run_id": "gh987654321-1"
  },
  "assets": {
    "btc": {
      "id": "bitcoin",
      "symbol": "BTC",
      "reference": {
        "price": 65000.25,
        "observed_at": "2026-07-17T00:00:00-06:00"
      },
      "forecast": [
        { "offset_hours": 1, "return_factor": 1.0004 },
        { "offset_hours": 2, "return_factor": 1.0007 },
        { "offset_hours": 48, "return_factor": 1.018 }
      ],
      "summary": {
        "terminal_return": 0.018,
        "direction": "up",
        "confidence": {
          "value": 72.5,
          "status": "available",
          "method": "rolling_origin_48h_residuals",
          "sample_size": 40
        }
      }
    },
    "eth": {
      "id": "ethereum",
      "symbol": "ETH",
      "reference": {
        "price": 3500.75,
        "observed_at": "2026-07-17T00:00:00-06:00"
      },
      "forecast": [
        { "offset_hours": 1, "return_factor": 0.9998 },
        { "offset_hours": 2, "return_factor": 0.9995 },
        { "offset_hours": 48, "return_factor": 0.993 }
      ],
      "summary": {
        "terminal_return": -0.007,
        "direction": "down",
        "confidence": {
          "value": null,
          "status": "insufficient_validation",
          "method": "rolling_origin_48h_residuals",
          "sample_size": 12
        }
      }
    }
  }
}
```

El ejemplo abrevia los arrays para que sea legible; un artefacto válido contiene
**exactamente 48 elementos** por activo. Sus reglas canónicas son:

- `schema_version` identifica el contrato y `artifact_version` identifica una
  corrida inmutable. Cumple la expresión
  `^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{7,40}-(?:gh[0-9]+-[0-9]+|local[0-9a-f]{32})$`:
  timestamp UTC + revisión del código + `run_id` único. En GitHub Actions el
  sufijo es `gh<GITHUB_RUN_ID>-<GITHUB_RUN_ATTEMPT>`; en una ejecución local es
  `local<UUID-sin-guiones>`. Los tests pueden inyectar un `run_id` fijo para
  conservar determinismo. Dos corridas con el mismo timestamp y revisión no
  pueden reutilizar `artifact_version`.
- `assets` contiene obligatoriamente `btc` y `eth`. Se podrán agregar activos
  sin hacer opcionales esos dos.
- `forecast` está ordenado y contiene una vez cada entero de `offset_hours` de
  `1` a `48`. `return_factor` es un número finito y positivo, relativo al último
  precio observado por entrenamiento: `precio_proyectado = precio_ancla ×
  return_factor`. No se serializan 48 precios absolutos.
- `reference` documenta el precio usado para producir el camino, pero Netlify
  no lo usa como nivel. En cada ingesta, `predict.mjs` ancla el camino al precio
  vivo del mismo activo y calcula `target_at = anchored_at + offset_hours`.
  Así, los 48 puntos siempre quedan en el futuro respecto de la lectura actual.
- `generated_at`, `data_through`, `valid_until`, `expires_at` y
  `reference.observed_at` son ISO-8601 con offset explícito. La zona semántica
  es `America/Mexico_City`; timestamps de una fuente externa pueden conservar
  `Z`. `data_through` no puede ser posterior a `generated_at` ni tener más de
  12 horas de antigüedad al generar el artefacto. Cada
  `reference.observed_at` cumple la misma edad máxima de 12 horas, no es futuro,
  y los timestamps de referencia de BTC y ETH difieren como máximo 1 hora. El
  artefacto completo es inválido si falla cualquiera de estas condiciones.
  `valid_until` es `generated_at + 36 h` (un ciclo diario más 12 h de gracia) y
  `expires_at` es `generated_at + 72 h`; ambas relaciones deben validarse.
- `horizon_hours` vale `48`, `step_hours` vale `1`, `currency` vale `usd` y
  `artifact_type` vale `relative_hourly_forecast` en esta versión.
- `terminal_return` es exactamente el `return_factor` del offset 48 menos 1.
  `direction` usa el enum `up | down | flat` y el umbral fijo `τ = 0.005`
  (0.5 %): `up` si el retorno es mayor o igual a `+τ`, `down` si es menor o
  igual a `-τ`, y `flat` en el intervalo abierto entre ambos límites.

**Ventana de entrenamiento y huecos.** Para cada activo, `train.py` normaliza
las observaciones a buckets UTC de una hora, descarta precios/timestamps
inválidos, conserva la observación válida más reciente de cada bucket y ordena
ascendentemente. No interpola ni rellena horas ausentes. Desde el punto más
reciente recorre hacia atrás y usa únicamente el sufijo de buckets horarios
contiguos hasta el primer hueco; datos anteriores al hueco no participan ni en
entrenamiento ni en validación.

Cada activo necesita al menos **168 puntos horarios contiguos** (7 días) para
entrenar. Como BTC y ETH son obligatorios, si cualquiera de los dos no alcanza
168 puntos, la corrida falla y no publica artefacto. Los folds rolling-origin
se construyen solo dentro del sufijo contiguo del activo y nunca cruzan un
hueco. Con entrenamiento mínimo de 168 puntos y horizonte de 48 h, hacen falta
**235 puntos contiguos** para obtener 20 residuales fuera de muestra
(`168 + 48 + 19`): entre 168 y 234 puntos se permite publicar el forecast, pero
su confianza debe quedar `insufficient_validation` y `value: null`.

**Confianza, no accuracy.** `confidence.value` estima cuánta evidencia respalda
la dirección de **este** forecast; no representa el porcentaje histórico de
aciertos. Se calcula exclusivamente con validación rolling-origin fuera de
muestra a 48 h. Para cada residual válido `eᵢ = retorno_realᵢ −
retorno_predichoᵢ`, se forma el escenario `rᵢ* = terminal_return + eᵢ`, se
clasifica con el mismo umbral `τ`, y la confianza es
`100 × escenarios_con_la_dirección_emitida / n`, redondeada a un decimal. Con
al menos 20 residuales, `status` vale `available` y `value` está entre 0 y 100;
con menos de 20, `status` vale `insufficient_validation` y `value` es `null`.
No se rellena con accuracy, un valor esperado, residuales de entrenamiento ni
un mínimo artificial. La accuracy solo podrá calcularse con predicciones
resueltas del registro descrito en §2.4.

**Validación, publicación y fallback.** `train.py` valida antes de publicar:
versión de schema soportada, BTC + ETH presentes, 48 offsets completos y
ordenados, factores/precios finitos y positivos, coherencia de timestamps,
frescura/sincronía de las referencias, sufijo mínimo de 168 horas,
`artifact_version` coherente con `producer.run_id`, terminal/dirección
reproducibles y confianza coherente con su `status`. `NaN`, `Infinity`, arrays
parciales y campos desconocidos que cambien la semántica invalidan la corrida.

`train.yml` corre a diario, genera y valida localmente el JSON, escribe primero
`forecast/versions/<artifact_version>.json`, conserva el último documento
válido como `forecast/previous.json` y solo entonces promueve los mismos bytes a
`forecast/latest.json`. Usa `NETLIFY_AUTH_TOKEN` y `NETLIFY_SITE_ID` como
secrets de GitHub Actions, y deriva el `run_id` de `GITHUB_RUN_ID` más
`GITHUB_RUN_ATTEMPT`; las ejecuciones locales generan un UUID. **No crea
commits, no hace push y no dispara un deploy**; el estado diario queda
únicamente en Blobs.

`predict.mjs` vuelve a validar el artefacto al leerlo. Prefiere `latest`; si
falta, está corrupto o usa un schema no soportado, intenta `previous`. Un
artefacto es `fresh` hasta `valid_until`, es `stale` después de ese instante y
puede usarse con aviso hasta `expires_at`; pasada esa fecha se considera
`unavailable`.

**Bloque público `forecast` del snapshot.** El snapshot conserva
`schema_version: "1.0"`: `forecast` es una adición compatible al contrato base
de §2.1. Está siempre presente en todo snapshot nuevo. Los seeds legacy pueden
omitirlo; cualquier consumidor debe interpretar esa ausencia exactamente como
`{ "status": "unavailable" }`.

Si no existe un artefacto completo y utilizable, la forma mínima es:

```json
{
  "forecast": {
    "status": "unavailable"
  }
}
```

Un estado `unavailable` no contiene `assets`, puntos, dirección, confianza ni
valores sustitutos. Nunca se inventa una línea plana, ceros, confidence o
accuracy. Si el artefacto está disponible, la forma exacta es:

```json
{
  "forecast": {
    "status": "fresh",
    "artifact_version": "20260717T070000Z-a1b2c3d-gh987654321-1",
    "anchored_at": "2026-07-17T02:15:00-06:00",
    "valid_until": "2026-07-18T13:00:00-06:00",
    "expires_at": "2026-07-20T01:00:00-06:00",
    "assets": {
      "btc": {
        "direction": "up",
        "terminal_return": 0.018,
        "confidence": {
          "value": 72.5,
          "status": "available",
          "method": "rolling_origin_48h_residuals",
          "sample_size": 40
        },
        "points": [
          {
            "offset_hours": 1,
            "target_at": "2026-07-17T03:15:00-06:00",
            "price": 65100.25
          }
        ]
      },
      "eth": {
        "direction": "down",
        "terminal_return": -0.007,
        "confidence": {
          "value": null,
          "status": "insufficient_validation",
          "method": "rolling_origin_48h_residuals",
          "sample_size": 12
        },
        "points": [
          {
            "offset_hours": 1,
            "target_at": "2026-07-17T03:15:00-06:00",
            "price": 3498.1
          }
        ]
      }
    }
  }
}
```

El ejemplo abrevia `points`; tanto `btc` como `eth` contienen exactamente 48
elementos, ordenados y con `offset_hours` de 1 a 48 sin huecos. Para cada punto,
`target_at = anchored_at + offset_hours` y
`price = assets[asset].price vivo × return_factor` del mismo offset. `price` es
finito y positivo. `anchored_at`, `target_at`, `valid_until` y `expires_at` son
ISO-8601 con offset vigente de CDMX. `direction`, `terminal_return` y el objeto
`confidence` se copian exactamente del artefacto validado; Netlify no los
recalcula. El snapshot público no expone `reference` ni `return_factor`.

El enum de `forecast.status` disponible es `fresh | stale` y depende solo de
`valid_until`/`expires_at` del artefacto. Es independiente del booleano
top-level `stale`, que describe la ingesta de mercado. Solo se genera un nuevo
anclaje después de una ingesta fresca y completa de CoinGecko para BTC y ETH;
en ese caso `anchored_at` coincide con el nuevo `generated_at` del snapshot y
el precio base de cada camino coincide con el `assets[asset].price` servido.

Si CoinGecko falla, se conservan los precios, `generated_at`, `anchored_at` y
los 48 puntos del último snapshot válido y solo se marca el `stale` de mercado:
no se reancla al reloj, a precios parciales ni a un artefacto recién publicado.
El bloque conservado solo puede cambiar de `fresh` a `stale` por tiempo sin
modificar el anclaje ni los precios proyectados, y pasa a `unavailable` al
superar su `expires_at`. Tras la siguiente ingesta fresca, la selección para un
nuevo anclaje vuelve a ser `latest` y después `previous`; si ambos están
corruptos, no soportados o expirados, `forecast` queda
`{ "status": "unavailable" }` sin crear puntos nuevos.

#### 2.4 Registro de predicciones y accuracy medida (Fase 3)

La Fase 3 llena la tarjeta «Precisión de 7 días», hoy vacía, con accuracy
**real medida** contra el precio que efectivamente ocurrió — nunca con backtest
ni con la confianza del modelo. Esto es la regla de oro #3 hecha producto.

**Dónde vive.** Igual que el artefacto de Fase 2, el registro y las métricas son
estado mutable que crece a diario, así que **viven en Netlify Blobs, nunca en el
repo** (un commit diario = un deploy de 15 créditos = 450/mes, imposible; ver
`06_PRESUPUESTO.md`). El diseño original de `data/predictions_log.json`
commiteado queda descartado por esa razón. Store dedicado `predictions`:

| Key | Qué | Quién escribe |
|---|---|---|
| `log/current.json` | Registro append-only; se poda a 30 días para acotarlo | `predict.mjs` (registra) y `evaluate` (resuelve + poda) |
| `metrics/accuracy.json` | Accuracy rolling de 7 días ya calculada | `evaluate` |
| `metrics/health.json` | Huecos de datos y señales de drift | `evaluate` |

**Contrato de un registro (`prediction-log/1.0`).** Cada entrada:

```json
{
  "id": "btc:2026-07-21T18:00:00Z:48",
  "made_at": "2026-07-21T12:00:00-06:00",
  "asset": "btc",
  "horizon_h": 48,
  "artifact_version": "20260721T070000Z-a1b2c3d-gh987654321-1",
  "anchor_price": 64980.0,
  "predicted": 66150.5,
  "direction": "up",
  "target_at": "2026-07-23T12:00:00-06:00",
  "actual": null,
  "resolved_at": null,
  "hit": null
}
```

Reglas: `id = <asset>:<hora-UTC-truncada>:<horizon_h>` — determinista y con
resolución horaria, de modo que registrar el mismo activo/hora/horizonte es
idempotente aunque `predict.mjs` corra cada 15 min. `horizon_h` es `48` para
medir exactamente la dirección que muestra la UI (la terminal del artefacto).
`direction`, `anchor_price` (precio vivo del anclaje) y `predicted`
(`points[48].price`) se copian del snapshot anclado. Mientras no se resuelva,
`actual`, `resolved_at` y `hit` son `null`.

**Registro (`predict.mjs`).** Cuando produce un snapshot fresco con forecast
`fresh`, además registra —en un bloque aislado, sin poder romper el precio— una
predicción por activo, deduplicada al bucket horario por `id`. ~24 registros por
activo al día. Si el store de predicciones falla, el precio y el forecast siguen
intactos.

**Resolución y accuracy (`ml/evaluate.py` + `evaluate.yml`, 07:30 UTC).** Diario:
descarga los históricos por `/api/history`, lee `log/current.json`, y para cada
registro sin resolver cuyo `target_at` ya pasó busca el precio real más cercano
±1 h. Si lo encuentra: `actual`, `resolved_at`, y
`hit = (dirección real == dirección predicha)` con el mismo umbral `τ = 0.005`.
Un registro sin dato real tras 24 h de gracia se marca resuelto con
`hit: null` (no computa) para no quedar pendiente para siempre. La accuracy de
7 días es `aciertos / resueltos` sobre los registros con `resolved_at` en los
últimos 7 días y `hit` no nulo, **por activo**; con menos de **20** muestras
resueltas el estado es `insufficient_data` y no se publica porcentaje. La
resolución y el `health` usan la **serie horaria completa** (no el sufijo
contiguo de entrenamiento), de modo que los huecos reales siguen siendo
visibles: `health` cuenta cualquier separación mayor a 1 h en las últimas 24 h.
No se commitea nada: `evaluate.yml` escribe a Blobs con `NETLIFY_AUTH_TOKEN` +
`NETLIFY_SITE_ID`, igual que `train.yml`.

**Bloque público `accuracy` del snapshot.** `predict.mjs` lee
`metrics/accuracy.json` (aislado, como el forecast) y lo adjunta al snapshot como
adición compatible al contrato base `1.0`. Ausente o no medible ⇒
`{ "status": "unavailable" }`; nunca se inventa un porcentaje.

```json
{
  "accuracy": {
    "status": "available",
    "window_days": 7,
    "measured_through": "2026-07-21T01:30:00-06:00",
    "assets": {
      "btc": { "status": "available", "hit_rate": 58.3, "sample_size": 96 },
      "eth": { "status": "insufficient_data", "hit_rate": null, "sample_size": 11 }
    }
  }
}
```

`hit_rate` es porcentaje redondeado a un decimal (0–100) solo cuando
`sample_size` alcanza el mínimo; si no, `insufficient_data` y `hit_rate: null`.
La UI muestra el número por activo únicamente cuando existe; jamás rellena con la
confianza del modelo ni con un valor esperado.

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
├── netlify/lib/                  # contratos y helpers compartidos (validación)
│   ├── contract-helpers.mjs      # primitivas de validación comunes
│   ├── blob-log.mjs              # compare-and-swap por ETag para el log
│   ├── market-contract.mjs       # snapshot: forecast + accuracy opcionales
│   ├── forecast-contract.mjs     # artefacto forecast-artifact/1.0
│   ├── prediction-contract.mjs   # registro prediction-log/1.0 + accuracy
│   └── prediction-store.mjs      # registrar predicciones / leer accuracy
├── scripts/
│   ├── publish-forecast.mjs      # Fase 2: artefacto → Blobs
│   └── publish-evaluation.mjs    # Fase 3: fetch log / publicar métricas → Blobs
├── ml/
│   ├── train.py                  # entrenamiento + serialización
│   ├── evaluate.py               # resolución de predicciones + accuracy + health
│   ├── features.py
│   └── requirements.txt
├── models/                       # fixtures de contrato; el vigente vive en Blobs
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
    ├── test_evaluate.py          # resolución, accuracy rolling, huecos, poda
    ├── market-contract.test.mjs  # contrato de snapshot e histórico
    ├── functions.test.mjs        # latest/predict: fallbacks y stale
    ├── history-functions.test.mjs # refresh/history: aislamiento y 404 → seed
    ├── prediction-contract.test.mjs # registro + accuracy: forma y honestidad
    └── prediction-store.test.mjs # registrar/leer accuracy: aislamiento
```

**Nada mutable se versiona.** `models/`, `metrics/` y `data/` guardan seeds y
fixtures; lo que cambia a diario u horariamente vive en Blobs, porque cada
commit a `main` cuesta un deploy (`06_PRESUPUESTO.md`).

### 5. Cuota de Groq

El cuello real es **TPM/TPD, no requests/día** → mantener prompts cortos y contexto compacto.

### 6. Convenciones del proyecto

- Idioma de código y commits: **inglés**. Idioma de UI y docs: **español**.
- Ramas: `main` (producción, auto-deploy Netlify), `dev` (integración), `feature/*`.
- Artefacto vigente de forecast en `model-artifacts/forecast/latest.json`
  (Netlify Blobs); las versiones diarias y métricas vivas no se commitean.
- Ningún secreto en el repo: `GROQ_API_KEY` y `COINGECKO_DEMO_API_KEY` viven en variables de entorno de Netlify.
- Todo número mostrado al usuario se redondea; toda fecha en zona horaria de **CDMX**.

### 7. Flujos temporales (quién corre cuándo)

| Hora (UTC) | Proceso | Dónde |
|---|---|---|
| 07:00 diario | Entrenamiento + `model-artifacts/forecast/latest.json` + métricas → **a Blobs, no al repo** | GitHub Actions |
| 07:30 diario | Resolución de predicciones + accuracy 7d + health → **a Blobs (store `predictions`), no al repo** | GitHub Actions |
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
