# 02 — ANÁLISIS DE RIESGOS

> Matriz viva. Escala: Baja / Media / Alta. Severidad = P×I. Revisar al cierre de cada fase.

### Resumen ejecutivo

Los riesgos dominantes **no son técnico-algorítmicos** (el modelo puede ser mediocre y el proyecto sigue siendo valioso como portafolio de MLOps). Los dominantes son: **(a)** dependencia de free tiers de terceros que pueden cambiar sin aviso, **(b)** abandono por alcance excesivo (scope creep) siendo un proyecto de una sola persona con trabajo de tiempo completo, y **(c)** fricción del ciclo commit-diario-al-repo que puede ensuciar el historial y romper el deploy.

### R-01 · Cambio o eliminación del free tier de Groq
**Dependencia externa · P: Media · I: Alto (Fase 4 inoperante) · Severidad: ALTA**
- *Señal temprana*: emails de Groq sobre pricing; aumento de 429 sin cambio de tráfico.
- *Mitigación*: (1) la arquitectura aísla al proveedor en un solo módulo — `chat.mjs` usa endpoint OpenAI-compatible → cambiar de proveedor = cambiar base URL y modelo; (2) fallback degradado ya diseñado: si el LLM no responde, el chat contesta con plantillas + datos crudos del snapshot; (3) alternativas pre-identificadas: OpenRouter free models, HF Spaces, Google AI Studio free tier.
- *Contingencia*: feature flag `CHAT_ENABLED=false` que oculta la sección de chat sin tocar el resto del sitio.

### R-02 · Rate limits / cambios de la API de CoinGecko
**Dependencia externa · P: Media · I: Alto (sin datos no hay nada) · Severidad: ALTA**
- *Detalle*: el tier sin key ha endurecido límites históricamente; el histórico de 365 días puede requerir key demo (gratuita con registro).
- *Mitigación*: (1) registrar key demo gratuita **desde el día 1**; (2) cachear el histórico en `data/history/` para que cada entrenamiento pida solo el delta; (3) capa de abstracción `fetch_prices()` para cambiar a Binance public API o CoinCap sin tocar el resto.
- *Contingencia*: si falla la ingesta horaria, la function conserva el último `latest.json` válido y marca `stale: true` → el frontend muestra "datos de hace X horas".

### R-03 · Abandono / scope creep
**Ejecución · P: Alta · I: Alto · Severidad: CRÍTICA**
- *Detalle*: **es el riesgo #1 real.** Trabajo de tiempo completo (migración DV2), quiniela activa durante el Mundial, y tendencia natural a agregar features (chat, geoespacial, más monedas) antes de cerrar lo básico.
- *Mitigación*: (1) plan por fases con entregable **desplegado** por fase — la regla "no se avanza con lo anterior a medias" es contractual; (2) cada fase dimensionada para 1–2 fines de semana máximo; (3) el backlog separa explícitamente v1 de "ideas futuras"; (4) el primer entregable (Fase 1) llega en días, no semanas → momentum temprano.
- *Indicador*: si una fase lleva >3 semanas abierta, **recortar alcance de la fase, no extender plazo**.

### R-04 · El modelo predice mal y desmotiva / avergüenza públicamente
**Producto/ML · P: Alta (predecir cripto a 48h es genuinamente difícil) · I: Medio · Severidad: MEDIA-ALTA**
- *Detalle*: accuracy direccional realista de un modelo simple: **50–60%**. Un dashboard que presume "81% de precisión" y muestra 52% real daña la credibilidad del portafolio.
- *Mitigación*: mostrar la precisión **real** medida (rolling 7 días) como feature de honestidad del producto, no esconderla; el valor del portafolio está en el MLOps, no en ganarle al mercado.

### R-07 · Incompatibilidad Prophet/Python en GitHub Actions
**Técnica/ML · P: Media · I: Bajo-Medio · Severidad: MEDIA-BAJA**
- *Detalle*: Prophet arrastra cmdstan; instalaciones lentas o quebradizas en runners (análogo a lo vivido con `F.pmod` en Spark 3.2: la herramienta "estándar" no siempre está donde la necesitas).
- *Mitigación*: (1) cache de pip en el workflow; (2) **plan B definido de antemano**: si Prophet da guerra >1 sesión de trabajo, cambiar a `statsmodels` (Holt-Winters/SARIMA) o a un GBM ligero — el contrato del artefacto (JSON de forecast pre-computado) es agnóstico al modelo; ese desacople existe exactamente para esto.

### R-08 · Exposición o fuga de la API key de Groq
**Seguridad · P: Baja · I: Medio · Severidad: MEDIA-BAJA**
- *Mitigación*: key solo en env vars de Netlify; nunca en el cliente; `.gitignore` de `.env`; secret scanning de GitHub activado (gratis en repos públicos); rotación inmediata si aparece en un commit.

### R-09 · Abuso del endpoint de chat (spam, prompt injection, uso como LLM gratis)
**Seguridad/producto · P: Media (si el sitio se comparte) · I: Medio · Severidad: MEDIA**
- *Detalle*: alguien puede scriptear el endpoint para usar tu cuota de Groq como proxy gratuito, o intentar prompt injection.
- *Mitigación*: (1) rate limit doble; (2) el system prompt acota alcance y longitud (≤120 palabras); (3) validación de entrada: longitud máx. 400 caracteres, un solo turno con contexto controlado (sin historial libre en v1); (4) el contexto se arma **server-side** — el usuario nunca inyecta nada al system prompt más que su pregunta; (5) CORS restringido al dominio propio.

### R-10 · Riesgo reputacional/legal por percepción de asesoría financiera
**Legal/reputacional · P: Baja · I: Medio · Severidad: MEDIA-BAJA**
- *Mitigación*: (1) disclaimer visible y permanente en el sitio y en cada respuesta relevante del analista; (2) el bot rechaza explícitamente "¿compro/vendo?"; (3) nunca usar lenguaje imperativo ("compra", "es buen momento") en UI ni en predicciones; (4) el proyecto se presenta como **experimento educativo de ML**.

### R-11 · Datos horarios con huecos (function falla en silencio)
**Calidad de datos · P: Media · I: Bajo (se acumula) · Severidad: MEDIA-BAJA**
- *Mitigación*: (1) `evaluate.yml` reporta huecos >2h en las últimas 24h como warning en `metrics/health.json`; (2) el frontend tolera huecos (Chart.js con `spanGaps`); (3) la evaluación de aciertos usa el precio real más cercano ±1h y descarta la predicción si no hay dato (marcada `unresolved`).
