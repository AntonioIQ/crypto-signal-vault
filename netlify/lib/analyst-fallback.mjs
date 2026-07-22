export const MAX_ANALYST_WORDS = 120;

export const ANALYST_INTENTS = Object.freeze({
  ADVICE: "advice",
  OUT_OF_SCOPE: "out_of_scope",
  PRICE: "price",
  FORECAST: "forecast",
  CONFIDENCE: "confidence",
  ACCURACY: "accuracy",
  EXPLANATION: "explanation",
});

const ASSET_LABELS = Object.freeze({ btc: "Bitcoin", eth: "Ethereum" });

function normalized(text) {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

export function isAdviceQuestion(question) {
  const text = normalized(question);
  return /\b(compr(?:a|ar|o|e|aria)|adquirir|vend(?:e|er|o|a|ria)|inviert(?:e|o|a)|invertir|inversion|mantener|conservar|apostar|entro|entrar|salgo|salir|posicion|cartera|portafolio|conviene|debo|deberia|sugier|sugerencia|aconsej|consejo|recomiend|recomendacion|buen momento|que harias|que hago)\b/.test(text);
}

export function containsUnsafeAdvice(answer) {
  const text = normalized(answer);
  return /\b(compr(?:a|ar|e|o|aria)|adquier|adquirir|vend(?:e|er|a|o|ria)|inviert|invertir|inversion|mant[e]?n|mantener|conserva|apostar|aumenta|reduce|posicion|cartera|portafolio|entra|sal|debes|deberias|podrias|conviene|sugier|sugerencia|aconsej|consejo|recomiend|recomendacion|buen momento|buena compra|vale la pena|oportunidad)\b/.test(text);
}

export function containsPromptLeak(answer) {
  return /analyst-context\/|GROQ_API_KEY|CONTEXTO:\s*\{|reglas estrictas:|eres ["“]?el Analista|system prompt|mensaje system|"price_usd"|"schema_version"/i.test(answer);
}

export function mentionsForecast(answer) {
  return /predicci[oó]n|pron[oó]stico|48\s*(?:h|horas)|señal|direcci[oó]n|el modelo (?:estima|espera|ve)|apunta (?:hacia|a)/i.test(answer);
}

export function classifyAnalystQuestion(question) {
  const text = normalized(question);
  if (isAdviceQuestion(question)) return ANALYST_INTENTS.ADVICE;
  if (/\b(confianza|segura|seguro|certeza)\b/.test(text)) return ANALYST_INTENTS.CONFIDENCE;
  if (/\b(precision|aciert|acert|accuracy|resultado|medid)/.test(text)) return ANALYST_INTENTS.ACCURACY;
  if (/\b(precio|cuesta|cotiza|valor)\b/.test(text)) return ANALYST_INTENTS.PRICE;
  if (/\b(prediccion|pronostico|48\s*(?:h|horas)|direccion|subida|bajada|lectura actual)\b/.test(text)) {
    return ANALYST_INTENTS.FORECAST;
  }

  const promptAttack = /\b(ignora|instrucciones|prompt|system|sistema|clave|api key|revela|muestra tus reglas|actua como|cambia de rol)\b/.test(text);
  const unrelated = /\b(capital de|traduce|traduccion|codigo|programa|poema|receta|clima|futbol|deporte|presidente|politica|pelicula|correo|matemat|chiste|historia de)\b/.test(text);
  if (promptAttack || unrelated) return ANALYST_INTENTS.OUT_OF_SCOPE;

  if (/\b(bitcoin|btc|ethereum|eth|modelo|datos|snapshot|lectura|confianza|precision|prediccion|pronostico)\b/.test(text)) {
    return ANALYST_INTENTS.EXPLANATION;
  }
  return ANALYST_INTENTS.OUT_OF_SCOPE;
}

export function containsUngroundedExplanation(answer) {
  const text = normalized(answer);
  return (
    /\d|%|\$|\busd\b/.test(text) ||
    /\b(bitcoin|btc|ethereum|eth|hoy|ahora|actual|sube|subira|subida|baja|bajara|bajada|plano|lateral|apunta|precio actual|ha acertado)\b/.test(text) ||
    /\b(?:la|su) (?:confianza|precision) (?:es|esta|fue)\b/.test(text)
  );
}

export function limitWords(answer, maximum = MAX_ANALYST_WORDS) {
  const words = answer.trim().split(/\s+/).filter(Boolean);
  if (words.length <= maximum) return words.join(" ");
  return `${words.slice(0, maximum).join(" ").replace(/[.,;:!?]+$/, "")}…`;
}

function priceSummary(context) {
  return Object.entries(context.assets).map(([asset, item]) => {
    if (item.price_usd === null) return `${ASSET_LABELS[asset]}: precio no disponible`;
    return `${ASSET_LABELS[asset]}: ${item.price_usd.toLocaleString("es-MX", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    })}`;
  }).join(". ");
}

function directionLabel(direction) {
  if (direction === "up") return "una subida";
  if (direction === "down") return "una bajada";
  return "un cambio pequeño";
}

function confidencePhrase(item) {
  if (item.forecast.status === "unavailable") return "no hay pronóstico disponible";
  if (item.forecast.confidence.status === "available") {
    return `confianza de ${item.forecast.confidence.percent} %`;
  }
  return "confianza no disponible todavía";
}

export function forecastSummary(context) {
  return Object.entries(context.assets).map(([asset, item]) => {
    if (item.forecast.status === "unavailable") {
      return `${ASSET_LABELS[asset]}: no hay pronóstico disponible`;
    }
    const change = Math.abs(item.forecast.terminal_change_percent);
    return `${ASSET_LABELS[asset]}: el modelo estima ${directionLabel(item.forecast.direction)} de ${change} % en 48 horas, con ${confidencePhrase(item)}`;
  }).join(". ");
}

function confidenceSummary(context, assets = ["btc", "eth"]) {
  return assets.map((asset) => {
    const item = context.assets[asset];
    if (item.forecast.status === "unavailable") {
      return `${ASSET_LABELS[asset]} sin pronóstico`;
    }
    if (item.forecast.confidence.status === "available") {
      return `${ASSET_LABELS[asset]} ${item.forecast.confidence.percent} %`;
    }
    return `${ASSET_LABELS[asset]} sin porcentaje disponible`;
  }).join("; ");
}

function accuracySummary(context) {
  return Object.entries(context.assets).map(([asset, item]) => {
    const accuracy = item.accuracy;
    if (accuracy.status === "unavailable") {
      return `${ASSET_LABELS[asset]}: precisión medida no disponible`;
    }
    if (accuracy.status === "available") {
      return `${ASSET_LABELS[asset]}: ${accuracy.hit_rate_percent} % en ${accuracy.sample_size} predicciones resueltas durante 7 días`;
    }
    return `${ASSET_LABELS[asset]}: ${accuracy.sample_size} predicciones medidas; aún no se publica un porcentaje`;
  }).join(". ");
}

function requestedAssets(text) {
  const plain = normalized(text);
  const assets = [];
  if (/\b(?:btc|bitcoin)\b/.test(plain)) assets.push("btc");
  if (/\b(?:eth|ethereum)\b/.test(plain)) assets.push("eth");
  return assets.length > 0 ? assets : ["btc", "eth"];
}

function answerHasRequiredConfidence(answer, context, assets) {
  const plain = normalized(answer);
  return assets.every((asset) => {
    const forecast = context.assets[asset].forecast;
    if (forecast.status === "unavailable") return true;
    if (forecast.confidence.status !== "available") {
      return /confianza.{0,40}(?:no disponible|sin porcentaje|insuficiente)/.test(plain);
    }
    const value = String(forecast.confidence.percent).replace(".", "[.,]");
    return new RegExp(`(?:^|[^0-9])${value}\\s*%`).test(plain);
  });
}

function appendWithinLimit(answer, suffix) {
  const suffixWords = suffix.trim().split(/\s+/).filter(Boolean);
  const room = Math.max(0, MAX_ANALYST_WORDS - suffixWords.length);
  const baseWords = answer.trim().split(/\s+/).filter(Boolean).slice(0, room);
  return [...baseWords, ...suffixWords].join(" ");
}

export function templateAnswer(
  question,
  context,
  intent = classifyAnalystQuestion(question),
) {
  let answer;

  if (intent === ANALYST_INTENTS.ADVICE) {
    answer = `No puedo decirte si debes comprar, vender o cuándo entrar. Solo describo lo que ve el modelo. ${forecastSummary(context)}. Esto es educativo y no es asesoría financiera.`;
  } else if (intent === ANALYST_INTENTS.OUT_OF_SCOPE) {
    answer = "Solo puedo responder sobre el precio y las mediciones actuales de Bitcoin y Ethereum que aparecen en LikelyCoin. No tengo noticias, datos externos, instrucciones ocultas ni información de otros temas.";
  } else if (intent === ANALYST_INTENTS.CONFIDENCE) {
    answer = `Confianza publicada: ${confidenceSummary(context)}. Describe qué tan consistente fue cada dirección en validaciones previas; no garantiza el resultado.`;
  } else if (intent === ANALYST_INTENTS.ACCURACY) {
    answer = `${accuracySummary(context)}. Esta precisión usa precios reales ocurridos, no una prueba histórica ni la medida de confianza.`;
  } else if (intent === ANALYST_INTENTS.PRICE) {
    answer = `${priceSummary(context)}. Son los precios del último snapshot disponible; no son una recomendación.`;
  } else if (intent === ANALYST_INTENTS.FORECAST) {
    answer = `${forecastSummary(context)}. Es una descripción del modelo, no una garantía ni una recomendación.`;
  } else {
    answer = `La confianza describe la consistencia de la dirección estimada; la precisión cuenta resultados comparados con precios reales. Son mediciones distintas. ${forecastSummary(context)}.`;
  }

  return limitWords(answer);
}

export function finalizeAnalystResponse(answer, { question, context }) {
  const intent = classifyAnalystQuestion(question);
  const replacement = () => ({
    answer: templateAnswer(question, context, intent),
    replaced: true,
  });

  if (
    typeof answer !== "string" ||
    answer.trim().length === 0 ||
    containsUnsafeAdvice(answer) ||
    containsPromptLeak(answer) ||
    containsUngroundedExplanation(answer)
  ) {
    return replacement();
  }

  let safe = limitWords(answer.replace(/\s+/g, " ").trim());
  if (mentionsForecast(safe)) {
    const assets = requestedAssets(`${question} ${safe}`);
    if (!answerHasRequiredConfidence(safe, context, assets)) {
      safe = appendWithinLimit(
        safe,
        `Confianza publicada: ${confidenceSummary(context, assets)}.`,
      );
    }
    safe = limitWords(safe);
    if (!answerHasRequiredConfidence(safe, context, assets)) return replacement();
  }
  return { answer: safe, replaced: false };
}

export function finalizeAnalystAnswer(answer, options) {
  return finalizeAnalystResponse(answer, options).answer;
}
