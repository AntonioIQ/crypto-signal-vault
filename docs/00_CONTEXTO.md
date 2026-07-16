# 00 — CONTEXTO

### 1. Qué es

**Crypto Signal Vault** es una plataforma web de predicción de precios de criptomonedas (BTC y ETH inicialmente) con un pipeline de MLOps completo y un chatbot analista tipo RAG. Proyecto personal de portafolio de **Antonio**, con tres objetivos:

La marca pública del producto es **LikelyCoin**. «Crypto Signal Vault» se conserva como nombre interno del repositorio y de la arquitectura. La interfaz pública usa una identidad sobria de producto de datos y evita la esfera de adivinación, emojis decorativos y recursos que hagan parecer infantil la predicción.

1. **Portafolio profesional**: demostrar ciencia de datos aplicada + MLOps end-to-end (no solo un notebook), complementando su perfil de arquitectura de datos (Data Vault 2.0, PySpark, Hive/Impala).
2. **Aprendizaje**: primer proyecto propio con ciclo completo de ML productivo (entrenamiento programado, serving, monitoreo de drift).
3. **Producto usable**: página pública, entendible para no financieros, con precio actual, predicción a 24–48h y un "analista" conversacional acotado a los datos del modelo.

### 2. Perfil del dueño del proyecto

- Data architect/engineer. Domina: PySpark, SQL, Hive/Impala, modelado Data Vault 2.0, pipelines batch.
- Experiencia web: Vanilla JS + HTML/CSS en **Netlify** (proyecto previo: quiniela Mundial 2026 en `wc26-tracker.netlify.app`, con login, picks, standings, cron de resultados vía APIs deportivas).
- **NO** es experto en finanzas ni trading. El producto debe evitar jerga financiera de cara al usuario.
- Familiarizado con GitHub, GitHub Actions (básico), Ollama/modelos locales, diseño de sistemas multi-agente con Claude.
- Trabaja en español; producto y documentación en español.

### 3. Restricción rectora: COSTO CERO

**Toda decisión técnica está subordinada a esta restricción.** El proyecto debe correr 24/7 con $0 de gasto.

| Necesidad | Solución elegida | Por qué |
|---|---|---|
| Hosting frontend | Netlify (free tier) | Ya lo conoce; deploy automático desde GitHub |
| Cron de predicción (horario) | Netlify Scheduled Functions | Nativo, gratis en tier básico |
| Entrenamiento diario | GitHub Actions (cron) | 2,000 min/mes gratis; Python sin restricciones |
| Datos de mercado | CoinGecko API (free) | Buen rate limit, OHLCV suficiente |
| Sentimiento | Fear & Greed Index (alternative.me) | Simple, sin auth |
| LLM del chatbot | **Groq free tier** (Llama 3.3 70B u 8B) | Open-weight, gratis, rápido, sin tarjeta = imposible cobro accidental |
| Storage de estado | Netlify Blobs + JSON commiteados al repo | Gratis, suficiente para el volumen |
| Modelo servido | Artefacto `.json`/`.pkl` versionado en el repo | Evita bucket de pago |

**Decisiones descartadas (no re-proponer sin nueva justificación):**

- ❌ **Airflow**: overkill para 2 crons; GitHub Actions + Netlify Scheduled Functions bastan.
- ❌ **LLM self-hosted en Netlify Functions**: no cabe (~1 GB RAM, sin GPU, timeout corto).
- ❌ **LLM local expuesto con ngrok**: no viable 24/7 para usuarios externos (solo dev/demo).
- ❌ **Pinecone/Weaviate**: el corpus RAG es diminuto (datos propios del modelo); similitud en memoria o Chroma basta.
- ❌ **APIs de pago (OpenAI/Anthropic) para el chat**: rompe la restricción de costo cero.
- ⏸️ **Hugging Face Spaces como host del LLM**: alternativa válida si Groq falla, pero más lenta (CPU).

### 4. Decisiones de producto ya tomadas

1. **Público objetivo**: personas SIN conocimiento financiero. Nada de RSI/MACD/velas japonesas en la UI; esos features viven "atrás del telón".
2. **Pantalla principal** (mockup aprobado):
   - Precio actual grande (BTC, luego ETH).
   - Gráfica: línea sólida = precio real 30 días; línea punteada = predicción 24–48h.
   - Indicador simple: 🔼 "probablemente suba" / 🔽 "probablemente baje" / ➡️ "estable" + % de confianza.
   - 3 tarjetas de MLOps visibles: último entrenamiento, precisión 7 días, próxima actualización.
3. **Sección "Pregúntale a tu analista"** (mockup aprobado):
   - Chat acotado a los datos del modelo (RAG sobre datos propios, NO noticias externas).
   - Botones de preguntas rápidas ("¿Qué tan seguro está?", "Compara con ayer").
   - Disclaimer permanente: no es asesoría financiera; el bot lo repite si le piden consejos de inversión.

---

## APÉNDICE — Reglas de oro para cualquier sesión nueva

1. **Costo cero es innegociable.** Si una solución cuesta dinero, no existe.
2. **No se abre una fase sin cerrar la anterior.** R-03 es el riesgo crítico.
3. **La accuracy que se muestra es la que se midió.** Nunca la esperada, nunca la del backtest.
4. **Cero jerga financiera en pantalla.** Los features técnicos viven atrás del telón.
5. **El contrato del artefacto es agnóstico al modelo.** Si Prophet estorba, se cambia sin tocar nada más.
6. **Código y commits en inglés; UI y docs en español; fechas en CDMX.**
7. **Ningún secreto sale de las env vars de Netlify.**
