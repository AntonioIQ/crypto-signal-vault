# 01 — ARQUITECTURA

### 1. Contratos de datos (estado público)

- **`data/latest.json`** — snapshot vigente que consume el frontend. Multi-asset desde v1. Incluye `generated_at`, precio actual por activo, forecast anclado, dirección, confianza, y bandera `stale: true` cuando la ingesta falla.
- **`data/history/`** — histórico de precios cacheado (30–365 días). Cada entrenamiento solo pide el delta.
- **Artefacto del modelo** — el Action **pre-computa el forecast completo de 48h** (pasos horarios) y lo serializa. La scheduled function **solo lo ancla** al precio actual (ajuste de nivel). Esto elimina toda inferencia pesada del lado de Netlify y hace el contrato **agnóstico al modelo** (Prophet, statsmodels, GBM: da igual).
- **`data/predictions_log.json`** — append-only, rotación mensual:

```json
[{ "made_at": "...", "asset": "btc", "horizon_h": 24, "predicted": 65100,
   "direction": "up", "actual": null, "resolved_at": null, "hit": null }]
```

### 2. System prompt del Analista (v1)

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

### 3. Estructura del repositorio

```
crypto-signal-vault/
├── netlify.toml                  # build, redirects, cron de scheduled fn
├── package.json                  # deps de functions (groq via fetch nativo)
├── public/                       # frontend estático (publish dir)
│   ├── index.html
│   ├── css/styles.css
│   ├── js/app.js                 # render dashboard
│   ├── js/chat.js                # UI del analista
│   └── data/ → symlink/copia de data/ en build
├── netlify/functions/
│   ├── predict.mjs               # scheduled, horario
│   └── chat.mjs                  # on-demand, Groq + rate limit
├── ml/
│   ├── train.py                  # entrenamiento + serialización
│   ├── evaluate.py               # resolución de predicciones + drift
│   ├── features.py
│   └── requirements.txt
├── models/                       # artefactos versionados
├── metrics/                      # métricas por entrenamiento + rolling
├── data/                         # estado público (latest, history, log)
├── .github/workflows/
│   ├── train.yml
│   └── evaluate.yml
├── docs/                         # documentos 00–05
└── tests/
    ├── test_features.py
    ├── test_train_contract.py    # valida schema de artefactos
    └── functions.test.mjs        # rate limit, fallbacks del chat
```

### 4. Cuota de Groq

El cuello real es **TPM/TPD, no requests/día** → mantener prompts cortos y contexto compacto.

### 5. Convenciones del proyecto

- Idioma de código y commits: **inglés**. Idioma de UI y docs: **español**.
- Ramas: `main` (producción, auto-deploy Netlify), `dev` (integración), `feature/*`.
- Artefactos versionados en `models/` como `model_YYYYMMDD.json` + `metrics_YYYYMMDD.json`.
- Ningún secreto en el repo: `GROQ_API_KEY` vive en variables de entorno de Netlify.
- Todo número mostrado al usuario se redondea; toda fecha en zona horaria de **CDMX**.

### 6. Flujos temporales (quién corre cuándo)

| Hora (UTC) | Proceso | Dónde |
|---|---|---|
| 07:00 diario | Entrenamiento + artefacto + métricas | GitHub Actions |
| 07:30 diario | Evaluación de aciertos + drift | GitHub Actions |
| :00 cada hora | Predicción anclada + refresh de `latest.json` | Netlify Scheduled Fn |
| on-demand | Chat del analista | Netlify Function |
| en cada push a `main` | Redeploy del sitio | Netlify CI |

### 7. Seguridad y privacidad

- `GROQ_API_KEY` solo en env vars de Netlify; jamás en el cliente ni en el repo.
- El frontend nunca habla con APIs externas; todo pasa por functions o por JSON estáticos.
- No se almacenan preguntas del chat ni datos personales; `sessionId` es un UUID efímero generado en el cliente.
- Rate limiting en dos capas (sesión + global) protege la cuota de Groq y evita abuso.
- CoinGecko sin API key en v1; si se requiere key (tier demo), va también a env vars y solo se usa desde Actions/Functions.

### 8. Escalabilidad y evolución (fuera de alcance v1, documentado para no perderlo)

- ETH + altcoins adicionales: el contrato de `latest.json` ya es multi-asset.
- RAG real con embeddings (Chroma) si el corpus crece (ej. explicaciones históricas por día).
- Migrar storage de JSON-en-repo a Cloudflare R2 free si el histórico pesa.
- Notificaciones push / bot de Telegram cuando la confianza supere umbral.
- Mapa geoespacial de volumen por zona horaria (idea original de visualización geo).
