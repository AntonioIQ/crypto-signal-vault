export const MAX_ANALYST_WORDS = 120;

export const ANALYST_INTENTS = Object.freeze({
  ADVICE: "advice",
  // What used to be OUT_OF_SCOPE now only covers attempts to steer the analyst
  // off its instructions. Everything else that isn't ours became GENERAL, which
  // is the whole point of the conversational chat: a question about another
  // topic is answered, not refused.
  PROMPT_ATTACK: "prompt_attack",
  PRICE: "price",
  FORECAST: "forecast",
  CONFIDENCE: "confidence",
  ACCURACY: "accuracy",
  EXPLANATION: "explanation",
  CONCEPT: "concept",
  GENERAL: "general",
});

// The domains whose answers are statements about our own data, and therefore
// carry the published-figures guarantee. GENERAL is deliberately outside it.
export const GROUNDED_INTENTS = Object.freeze([
  ANALYST_INTENTS.PRICE,
  ANALYST_INTENTS.FORECAST,
  ANALYST_INTENTS.CONFIDENCE,
  ANALYST_INTENTS.ACCURACY,
  ANALYST_INTENTS.EXPLANATION,
  ANALYST_INTENTS.CONCEPT,
]);

// Fixed, written by us, never generated: a general-topic answer must announce
// that it is not one of our measurements, and that promise cannot depend on the
// model remembering to keep it.
export const GENERAL_ANSWER_PREFIX = "Esto no sale de lo que medimos en LikelyCoin:";

import { ASSETS } from "./coingecko.mjs";
import { glossaryMatches, glossaryNumbers } from "./analyst-glossary.mjs";

const ASSET_LABELS = Object.freeze(
  Object.fromEntries(Object.entries(ASSETS).map(([asset, meta]) => [asset, meta.name])),
);

function normalized(text) {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

// Asking to buy, sell or take a position is investment advice no matter what
// else the sentence contains: it is refused on sight, always.
// The stems carry an explicit tail (\w{0,3}) instead of a bare \b: written as
// `recomiend\b` the alternative never fired, because "recomiendas" has no word
// boundary after the stem. Endings stay bounded so "comprendo" is not read as
// "compro".
const TRANSACTIONAL_ADVICE = /\b(compr(?:a|ar|o|e|aria)s?|adquirir|vend(?:e|er|o|a|ria)s?|inviert(?:e|o|a|es|en)|invertir|inversion(?:es)?|mantener|conservar|apostar|entro|entrar|salgo|salir|posicion|cartera|portafolio)\b/;

// Asking for a recommendation is advice only when the subject is money. In a
// chat that now talks about anything, "¿me recomiendas una película?" was being
// answered with "no puedo decirte si debes comprar o vender", which is both
// useless and slightly absurd.
const SOFT_ADVICE = /\b(conviene|debo|deberia|sugier\w{0,3}|sugerencia|aconsej\w{0,4}|consejo|recomiend\w{0,3}|recomendacion|buen momento|que harias|que hago)\b/;
const FINANCIAL_SUBJECT = /\b(precio|mercado|moneda|monedas|cripto|criptomoneda|criptomonedas|dinero|plata|token|invers|bolsa|trading|ganar|perder|rendimiento)\b/;

export function isAdviceQuestion(question, focus = undefined) {
  const text = normalized(question);
  if (TRANSACTIONAL_ADVICE.test(text)) return true;
  if (!SOFT_ADVICE.test(text)) return false;
  // A recommendation asked while looking at a coin is about that coin.
  return MENTIONS_ASSET.test(text)
    || FINANCIAL_SUBJECT.test(text)
    || (typeof focus === "string" && Object.hasOwn(ASSETS, focus));
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

// Every name the configured coins answer to. Built from ASSETS so a coin added
// to the backend is understood here too: this used to hardcode bitcoin and
// ethereum, so after the expansion to 11 coins a question naming any of the
// other nine was classified as off-topic and refused.
const ASSET_TERMS = Object.entries(ASSETS)
  .flatMap(([asset, meta]) => [asset, meta.symbol, meta.id, meta.name])
  .map((term) => normalized(term))
  .filter((term) => term.length > 0)
  .sort((a, b) => b.length - a.length);

const MENTIONS_ASSET = new RegExp(`\\b(?:${ASSET_TERMS.join("|")})\\b`);

// Narrower than the pattern it replaces, on purpose. That one also caught bare
// "sistema" and "clave", which in a chat that now discusses any topic refuses
// ordinary questions ("¿qué es el sistema financiero?"). What stays are the
// phrasings that only exist to move the analyst off its instructions.
const PROMPT_ATTACK_PATTERN = /\b(ignora (?:todo|las|tus|lo)|olvida (?:todo|las|tus)|instrucciones (?:previas|anteriores|del sistema)|system prompt|prompt del sistema|muestra (?:tu|tus) (?:prompt|reglas|instrucciones)|revela (?:tu|tus)|api ?key|groq_api_key|actua como si|actúa como si|cambia de rol|jailbreak|modo desarrollador)\b/;

// A follow-up that names no topic at all ("¿y por qué?", "¿cómo va?", "¿eso qué
// significa?"). It only counts as one when it is short and refers back, so that
// a full question about another subject is not swallowed into our data domain
// just because a coin happens to be on screen.
const FOLLOW_UP_PATTERN = /^(?:y|pero|entonces|ok|okay|ah|osea|o sea|ya|bueno)\b|\b(eso|esa|ese|eso mismo|ahi|ahí|lo anterior|lo que dijiste)\b/;

function isBareFollowUp(text) {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return words <= 4 || (words <= 10 && FOLLOW_UP_PATTERN.test(text));
}

export function classifyAnalystQuestion(question, focus = undefined) {
  const text = normalized(question);
  // These two are answered by fixed templates and never reach the provider, so
  // they are decided before anything else can claim the question.
  if (isAdviceQuestion(question, focus)) return ANALYST_INTENTS.ADVICE;
  if (PROMPT_ATTACK_PATTERN.test(text)) return ANALYST_INTENTS.PROMPT_ATTACK;

  if (/\b(confianza|segura|seguro|certeza)\b/.test(text)) return ANALYST_INTENTS.CONFIDENCE;
  if (/\b(precision|aciert|acert|accuracy|resultado|medid)/.test(text)) return ANALYST_INTENTS.ACCURACY;
  if (/\b(precio|cuesta|cuestan|cotiza|valor|vale|valen)\b/.test(text)) return ANALYST_INTENTS.PRICE;
  if (/\b(prediccion|pronostico|48\s*(?:h|horas)|direccion|subida|bajada|lectura actual)\b/.test(text)) {
    return ANALYST_INTENTS.FORECAST;
  }

  // A term we have a written definition for is answered from that definition.
  if (glossaryMatches(question).length > 0) return ANALYST_INTENTS.CONCEPT;

  if (
    MENTIONS_ASSET.test(text) ||
    /\b(modelo|datos|snapshot|lectura|confianza|precision|prediccion|pronostico|cripto|criptomoneda|moneda|mercado)\b/.test(text)
  ) {
    return ANALYST_INTENTS.EXPLANATION;
  }
  // With a coin on screen, a bare follow-up is plainly about that coin.
  if (typeof focus === "string" && Object.hasOwn(ASSETS, focus) && isBareFollowUp(text)) {
    return ANALYST_INTENTS.EXPLANATION;
  }
  return ANALYST_INTENTS.GENERAL;
}

// A general-topic answer that talks about price, forecast, confidence, accuracy
// or one of our coins is claiming our voice for something we did not measure.
// The model may be wrong about the world; it may not be wrong as LikelyCoin.
export function claimsOurMeasurement(answer) {
  const text = normalized(answer);
  return (
    /\b(precio|precios|pronostico|prediccion|prediccion|confianza|precision|acierto|aciertos|hit rate|likelycoin|medimos|medicion|mediciones|snapshot)\b/.test(text) ||
    /\bel modelo\b/.test(text) ||
    MENTIONS_ASSET.test(text) ||
    /%|\busd\b|\$/.test(text)
  );
}

export function containsUngroundedExplanation(answer) {
  const text = normalized(answer);
  return (
    /\d|%|\$|\busd\b/.test(text) ||
    /\b(bitcoin|btc|ethereum|eth|hoy|ahora|actual|sube|subira|subida|baja|bajara|bajada|plano|lateral|apunta|precio actual|ha acertado)\b/.test(text) ||
    /\b(?:la|su) (?:confianza|precision) (?:es|esta|fue)\b/.test(text)
  );
}

// Figures the analyst is allowed to state: everything the context publishes,
// plus the fixed vocabulary of the product (the 48h horizon, the 7-day accuracy
// window, "24 h", the 120-word cap). Anything else is a number the model made
// up, which is the one failure this product cannot ship.
const PRODUCT_NUMBERS = [0, 24, 30, 48, 90, 100, 120, 7];

// A published timestamp is a published figure. Without this, an answer to "¿cuándo
// fue la última medición?" was refused for saying "21 de julio a las 12:00" — the
// digits of a date we ourselves publish — and the reader got a canned forecast
// instead of an answer.
function timestampNumbers(value) {
  if (typeof value !== "string") return [];
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return [];

  // The digits as written, plus how the site renders them in Mexico City: the
  // analyst may reasonably say either.
  const numbers = (value.match(/\d+/g) ?? []).map(Number).filter(Number.isFinite);
  try {
    const parts = new Intl.DateTimeFormat("es-MX", {
      timeZone: "America/Mexico_City",
      year: "numeric", month: "numeric", day: "numeric",
      hour: "numeric", minute: "numeric", hour12: false,
    }).formatToParts(new Date(parsed));
    for (const part of parts) {
      const numeric = Number(part.value);
      if (Number.isFinite(numeric)) {
        numbers.push(numeric);
        // "las 5" for 17:00 — the analyst writes the way people speak.
        if (part.type === "hour" && numeric > 12) numbers.push(numeric - 12);
      }
    }
  } catch {
    // A malformed timestamp simply grounds nothing extra.
  }
  return numbers;
}

// Published figures come in two kinds, and conflating them was a hole in the
// one guarantee this product cannot lose.
//
// A price or a percentage may legitimately be rounded ("63,935.12" → "63,935"),
// so those tolerate a little slack. A count, an hour and a year may not: they
// are already exact, and the proportional slack turned the year 2026 into a
// licence to state anything from 2016 to 2036 — an invented date passing the
// check that exists to stop invented figures.
function groundedValues(context) {
  const exact = [...PRODUCT_NUMBERS];
  const approximate = [];
  const pushExact = (value) => {
    if (typeof value === "number" && Number.isFinite(value)) {
      exact.push(value, Math.abs(value));
    }
  };
  const pushApproximate = (value) => {
    if (typeof value === "number" && Number.isFinite(value)) {
      approximate.push(value, Math.abs(value));
    }
  };

  exact.push(...timestampNumbers(context?.generated_at));

  for (const item of Object.values(context?.assets ?? {})) {
    pushApproximate(item.price_usd);
    exact.push(...timestampNumbers(item.source_updated_at));
    exact.push(...timestampNumbers(item.accuracy?.measured_through));
    const forecast = item.forecast ?? {};
    pushExact(forecast.horizon_hours);
    pushApproximate(forecast.terminal_change_percent);
    pushApproximate(forecast.confidence?.percent);
    pushExact(forecast.confidence?.sample_size);
    // The scenario board states "N de M escenarios", so that N is a figure the
    // product itself publishes even though it is derived from the other two.
    if (
      typeof forecast.confidence?.percent === "number" &&
      typeof forecast.confidence?.sample_size === "number"
    ) {
      pushExact(Math.round((forecast.confidence.percent / 100) * forecast.confidence.sample_size));
    }
    const accuracy = item.accuracy ?? {};
    pushExact(accuracy.window_days);
    pushApproximate(accuracy.hit_rate_percent);
    pushExact(accuracy.sample_size);
  }
  return { exact, approximate };
}

// A stated figure counts as grounded when it is a published value, or that
// value rounded the way a person would write it. Rounding is only forgiven for
// the kinds of figure a person actually rounds.
function isGrounded(stated, { exact, approximate }) {
  if (exact.some((value) => Number.isFinite(value) && stated === value)) return true;
  return approximate.some((value) => {
    if (!Number.isFinite(value)) return false;
    if (stated === value) return true;
    if (stated === Math.round(value)) return true;
    if (stated === Math.round(value * 10) / 10) return true;
    const scale = Math.max(0.05, Math.abs(value) * 0.005);
    return Math.abs(stated - value) <= scale;
  });
}

export function containsUngroundedNumbers(answer, context, extraValues = []) {
  const published = groundedValues(context);
  // Glossary figures are written by us and already exact ("21 millones"), so
  // they ground themselves and nothing near them.
  const values = { exact: [...published.exact, ...extraValues], approximate: published.approximate };
  // Spanish thousands separators are dots and decimals are commas as often as
  // the reverse, so both are normalized before parsing.
  const matches = String(answer).match(/\d[\d.,]*/g) ?? [];
  return matches.some((raw) => {
    const cleaned = raw.replace(/[.,]$/, "");
    const candidates = new Set([
      Number(cleaned.replace(/,/g, "")),
      Number(cleaned.replace(/\./g, "").replace(",", ".")),
    ]);
    const parsed = [...candidates].filter(Number.isFinite);
    if (!parsed.length) return false;
    return !parsed.some((value) => isGrounded(value, values));
  });
}

export function limitWords(answer, maximum = MAX_ANALYST_WORDS) {
  const words = answer.trim().split(/\s+/).filter(Boolean);
  if (words.length <= maximum) return words.join(" ");
  return `${words.slice(0, maximum).join(" ").replace(/[.,;:!?]+$/, "")}…`;
}

// The summaries take the coins the question actually asked about. They used to
// walk every configured asset, which read fine with two coins and became a wall
// of eleven clauses that the 120-word cap then cut mid-sentence.
function summarised(context, assets) {
  const keys = assets?.length ? assets : Object.keys(context.assets);
  return keys.filter((asset) => context.assets[asset]).map((asset) => [asset, context.assets[asset]]);
}

function priceSummary(context, assets) {
  return summarised(context, assets).map(([asset, item]) => {
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

export function forecastSummary(context, assets) {
  return summarised(context, assets).map(([asset, item]) => {
    if (item.forecast.status === "unavailable") {
      return `${ASSET_LABELS[asset]}: no hay pronóstico disponible`;
    }
    const change = Math.abs(item.forecast.terminal_change_percent);
    return `${ASSET_LABELS[asset]}: el modelo estima ${directionLabel(item.forecast.direction)} de ${change} % en 48 horas, con ${confidencePhrase(item)}`;
  }).join(". ");
}

function confidenceSummary(context, assets) {
  return summarised(context, assets).map(([asset, item]) => {
    if (item.forecast.status === "unavailable") {
      return `${ASSET_LABELS[asset]} sin pronóstico`;
    }
    if (item.forecast.confidence.status === "available") {
      return `${ASSET_LABELS[asset]} ${item.forecast.confidence.percent} %`;
    }
    return `${ASSET_LABELS[asset]} sin porcentaje disponible`;
  }).join("; ");
}

function accuracySummary(context, assets) {
  return summarised(context, assets).map(([asset, item]) => {
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

// The coin the page is showing, used when the question names none. Without it a
// follow-up like "¿y por qué?" answered about bitcoin whatever the reader had
// open.
function requestedAssets(text, focus) {
  const plain = normalized(text);
  const assets = [];
  for (const [asset, meta] of Object.entries(ASSETS)) {
    const terms = [asset, meta.symbol, meta.id, meta.name]
      .map((term) => normalized(term))
      .filter((term) => term.length > 0);
    const pattern = new RegExp(`\\b(?:${terms.join("|")})\\b`);
    if (pattern.test(plain)) assets.push(asset);
  }
  if (assets.length > 0) return assets;
  if (typeof focus === "string" && Object.hasOwn(ASSETS, focus)) return [focus];
  return ["btc", "eth"];
}

function answerHasRequiredConfidence(answer, context, assets) {
  const plain = normalized(answer);
  return assets.every((asset) => {
    const forecast = context.assets[asset].forecast;
    if (forecast.status === "unavailable") return true;
    if (forecast.confidence.status !== "available") {
      return /confianza.{0,40}(?:no disponible|sin porcentaje|insuficiente)/.test(plain);
    }
    // "50 %" and "50 por ciento" are the same statement. Only matching the
    // symbol made the canonical summary get appended to answers that had
    // already said it in words, which put a data dump back on the end of an
    // otherwise conversational reply.
    const value = String(forecast.confidence.percent).replace(".", "[.,]");
    return new RegExp(`(?:^|[^0-9])${value}\\s*(?:%|por\\s?ciento)`).test(plain);
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
  intent = undefined,
  focus = undefined,
) {
  intent = intent ?? classifyAnalystQuestion(question, focus);
  // Answer about the coins the question named. With no coin named this falls
  // back to a couple of them rather than all eleven, which no longer fit.
  const assets = requestedAssets(question, focus);
  let answer;

  if (intent === ANALYST_INTENTS.ADVICE) {
    answer = `No puedo decirte si debes comprar, vender o cuándo entrar. Solo describo lo que ve el modelo. ${forecastSummary(context, assets)}. Esto es educativo y no es asesoría financiera.`;
  } else if (intent === ANALYST_INTENTS.PROMPT_ATTACK) {
    answer = `Mis instrucciones no están a discusión y no las voy a mostrar. Con gusto seguimos: puedo hablarte del precio y las mediciones de las ${Object.keys(ASSETS).length} criptomonedas de LikelyCoin, o de casi cualquier otro tema.`;
  } else if (intent === ANALYST_INTENTS.CONCEPT) {
    const definitions = glossaryMatches(question);
    answer = definitions.length > 0
      ? definitions.map((entry) => entry.definition).join(" ")
      : `Puedo explicarte conceptos de cripto con nuestras propias palabras, pero ese no lo tengo escrito. Pregúntame de otra forma y le entramos.`;
  } else if (intent === ANALYST_INTENTS.GENERAL) {
    // The graceful version of "I can't". A general answer that was rejected by
    // the guards has to leave the conversation open, not slam a door — but it
    // must not pretend to know something it cannot verify either.
    answer = `Esa no la puedo contestar con algo que pueda verificar, así que prefiero no inventarte una respuesta. Donde sí piso firme es en lo que medimos aquí: precio, pronóstico, qué tan consistente es y qué tan seguido ha acertado.`;
  } else if (intent === ANALYST_INTENTS.CONFIDENCE) {
    answer = `Confianza publicada: ${confidenceSummary(context, assets)}. Describe qué tan consistente fue cada dirección en validaciones previas; no garantiza el resultado.`;
  } else if (intent === ANALYST_INTENTS.ACCURACY) {
    answer = `${accuracySummary(context, assets)}. Esta precisión usa precios reales ocurridos, no una prueba histórica ni la medida de confianza.`;
  } else if (intent === ANALYST_INTENTS.PRICE) {
    answer = `${priceSummary(context, assets)}. Son los precios del último snapshot disponible; no son una recomendación.`;
  } else if (intent === ANALYST_INTENTS.FORECAST) {
    answer = `${forecastSummary(context, assets)}. Es una descripción del modelo, no una garantía ni una recomendación.`;
  } else {
    answer = `La confianza describe la consistencia de la dirección estimada; la precisión cuenta resultados comparados con precios reales. Son mediciones distintas. ${forecastSummary(context, assets)}.`;
  }

  return limitWords(answer);
}

export function finalizeAnalystResponse(answer, { question, context, asset }) {
  const intent = classifyAnalystQuestion(question, asset);
  const replacement = () => ({
    answer: templateAnswer(question, context, intent, asset),
    replaced: true,
  });

  if (
    typeof answer !== "string" ||
    answer.trim().length === 0 ||
    containsUnsafeAdvice(answer) ||
    containsPromptLeak(answer)
  ) {
    return replacement();
  }

  // Outside our data, the analyst is allowed to be conversational but not to
  // borrow our authority: an answer about another subject that starts talking
  // about price, forecast or one of the coins is replaced, and one that states
  // any figure is replaced too — a number we did not measure is exactly the
  // thing this product exists to not publish.
  if (intent === ANALYST_INTENTS.GENERAL) {
    if (claimsOurMeasurement(answer) || /\d/.test(answer)) return replacement();
    const spoken = limitWords(
      `${GENERAL_ANSWER_PREFIX} ${answer.replace(/\s+/g, " ").trim()}`,
    );
    return { answer: spoken, replaced: false };
  }

  // The analyst may now talk about the data instead of handing back a fixed
  // string, so the guarantee moves from "it states no figures at all" to "every
  // figure it states is one we published". A made-up number falls back to the
  // canonical template, which is the answer that can never be wrong. A concept
  // answer may also use the figures written into its own definition.
  const allowed = intent === ANALYST_INTENTS.CONCEPT
    ? glossaryNumbers(glossaryMatches(question))
    : [];
  if (containsUngroundedNumbers(answer, context, allowed)) {
    return replacement();
  }

  let safe = limitWords(answer.replace(/\s+/g, " ").trim());
  if (mentionsForecast(safe)) {
    const assets = requestedAssets(`${question} ${safe}`, asset);
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
