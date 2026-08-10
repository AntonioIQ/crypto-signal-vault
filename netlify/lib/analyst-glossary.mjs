// Concept questions used to be refused: "¿qué es la volatilidad?" matched none
// of the data intents and fell through to the off-topic template. Now they are
// answered — but grounded in these definitions rather than in whatever the model
// happens to remember, which is the same standard the rest of the product holds
// itself to.
//
// Keep every definition short, in plain Spanish, and free of the jargon that
// golden rule #4 keeps off the screen. A definition is allowed to name a term
// (that is the point of being asked) but must not require another one to be
// understood.

function normalized(text) {
  return String(text)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

export const ANALYST_GLOSSARY = Object.freeze([
  {
    id: "volatilidad",
    terms: ["volatilidad", "volatil", "volátil"],
    definition:
      "La volatilidad es qué tanto se mueve el precio de un lado a otro en poco tiempo. Un precio volátil puede cambiar mucho en un solo día; uno tranquilo se queda cerca de donde estaba.",
  },
  {
    id: "halving",
    terms: ["halving", "halvings"],
    definition:
      "El halving es un evento programado de bitcoin en el que la cantidad de monedas nuevas que se crean se parte a la mitad. Ocurre aproximadamente cada cuatro años y está escrito en las reglas de la red desde el principio.",
  },
  {
    id: "blockchain",
    terms: ["blockchain", "cadena de bloques"],
    definition:
      "Una blockchain es un registro de operaciones que muchas computadoras guardan al mismo tiempo. Como todas tienen la misma copia, nadie puede cambiar lo ya escrito sin que las demás lo noten.",
  },
  {
    id: "criptomoneda",
    terms: ["criptomoneda", "criptomonedas", "cripto", "que es una moneda digital"],
    definition:
      "Una criptomoneda es dinero digital que vive en una red abierta, sin un banco que la emita ni la administre. Su precio lo fija quien compra y quien vende, no una autoridad central.",
  },
  {
    id: "capitalizacion",
    terms: ["capitalizacion", "capitalización", "market cap", "marketcap", "cap de mercado"],
    definition:
      "La capitalización de mercado es el precio de una moneda multiplicado por cuántas existen. Sirve para comparar el tamaño de una moneda contra otra, no para saber si está cara o barata.",
  },
  {
    id: "stablecoin",
    terms: ["stablecoin", "stablecoins", "moneda estable"],
    definition:
      "Una stablecoin es una cripto diseñada para valer siempre lo mismo que una moneda tradicional, casi siempre el dólar. Por eso su gráfica es una línea plana y en LikelyCoin no seguimos ninguna.",
  },
  {
    id: "mineria",
    terms: ["mineria", "minería", "minar", "minero", "mineros"],
    definition:
      "Minar es dedicar computadoras a validar las operaciones de una red y, a cambio, recibir monedas nuevas. Es el mecanismo con el que redes como la de bitcoin se mantienen funcionando sin un administrador.",
  },
  {
    id: "wallet",
    terms: ["wallet", "wallets", "billetera", "monedero"],
    definition:
      "Una wallet es donde se guardan las llaves que dan acceso a tus monedas. Las monedas siguen viviendo en la red; lo que la wallet guarda es la prueba de que son tuyas.",
  },
  {
    id: "exchange",
    terms: ["exchange", "exchanges", "casa de cambio"],
    definition:
      "Un exchange es un sitio donde la gente intercambia unas monedas por otras o por dinero tradicional. De ahí salen los precios que ves publicados en cualquier lado, incluido este sitio.",
  },
  {
    id: "suministro-bitcoin",
    terms: ["cuantos bitcoin", "cuántos bitcoin", "suministro", "limite de bitcoin", "límite de bitcoin"],
    definition:
      "Bitcoin tiene un tope escrito en sus reglas: nunca existirán más de 21 millones. Es una de las cosas que lo distinguen del dinero tradicional, que puede emitirse sin un límite fijo.",
  },
  {
    id: "gas",
    terms: ["gas", "comision de red", "comisión de red", "fee", "fees"],
    definition:
      "La comisión de red es lo que se paga por que una operación se registre. Sube cuando mucha gente quiere usar la red al mismo tiempo y baja cuando está tranquila.",
  },
  {
    id: "pronostico",
    terms: ["pronostico a 48", "pronóstico a 48", "que es un pronostico", "qué es un pronóstico", "que es una prediccion", "qué es una predicción"],
    definition:
      "El pronóstico es lo que el modelo estima que hará el precio en las próximas 48 horas, a partir de cómo se ha movido antes. Es una descripción de un patrón, no una promesa de lo que va a pasar.",
  },
]);

// Numbers are read back out of the definitions themselves instead of being
// listed separately, so a reworded definition can never drift away from the
// figures the answer is allowed to state.
export function glossaryNumbers(entries = ANALYST_GLOSSARY) {
  const numbers = [];
  for (const entry of entries) {
    for (const raw of entry.definition.match(/\d[\d.,]*/g) ?? []) {
      const value = Number(raw.replace(/[.,]$/, "").replace(/,/g, ""));
      if (Number.isFinite(value)) numbers.push(value);
    }
  }
  return numbers;
}

// Which definitions this question is asking about. Returns at most two: the
// prompt has a byte envelope, and an answer that recites four definitions is a
// data dump wearing a different hat.
export function glossaryMatches(question, limit = 2) {
  const text = normalized(question);
  const matches = [];
  for (const entry of ANALYST_GLOSSARY) {
    if (entry.terms.some((term) => text.includes(normalized(term)))) {
      matches.push(entry);
    }
    if (matches.length >= limit) break;
  }
  return matches;
}

export function isGlossaryQuestion(question) {
  return glossaryMatches(question).length > 0;
}

export function serializeGlossary(entries) {
  if (!entries?.length) return "";
  return entries.map((entry) => `- ${entry.definition}`).join("\n");
}
