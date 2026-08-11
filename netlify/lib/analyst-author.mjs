// Who built this. People ask, and until now the analyst treated the question as
// a general topic — which means a language model improvising about a real,
// named person. That is the one subject where invention is least acceptable, so
// this file is the only source: Antonio writes it, it ships with the code, and
// nothing outside it may be said about him.
//
// Deliberately NOT fetched from LinkedIn or anywhere else at runtime: personal
// data is not ours to copy around, and a profile that can change under us is a
// profile we cannot stand behind.

function normalized(text) {
  return String(text)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

// Everything a reader might call him, plus the ways people ask "who made this".
const AUTHOR_TERMS = [
  "tono", "toño", "jose antonio", "josé antonio", "antonio tapia", "j antonio",
  "tapia", "godinez", "godínez", "antoniiq", "antonioiq",
  "quien hizo", "quién hizo", "quien construyo", "quién construyó",
  "quien creo esto", "quién creó esto", "quien esta detras", "quién está detrás",
  "el autor", "la autora", "el creador", "quien programo", "quién programó",
  "de quien es este sitio", "de quién es este sitio",
];

// Short, factual, first-person-free statements. Each one must be something we
// can stand behind; the analyst may rephrase them and may not go beyond them.
// Any figure written here grounds itself, the same way glossary definitions do.
// Sourced from what Antonio himself publishes: the footer of this site and his
// own GitHub profile, which the footer links to (and whose contact address
// matches, so it is him and not a namesake). Nothing here is inferred, searched
// for, or remembered — a public search for his name returns other people
// entirely, and a biography assembled from those would be someone else's.
// Short on purpose. This is what the analyst may say about a person, not a CV:
// enough to answer "¿quién es Toño?" like a human would, and no more.
export const AUTHOR_PROFILE = Object.freeze([
  "LikelyCoin lo construyó José Antonio Tapia Godínez, Toño. Es ingeniero químico por la UNAM y maestro en Ciencia de Datos por el ITAM.",
  "Empezó en la industria y la regulación —reactores, seguridad, inspección— y se fue moviendo hacia los datos: primero para entender procesos, después para diseñar cómo se organiza la información misma. Hoy hace arquitectura de datos en Grupo Salinas.",
  "Lo que conecta su trabajo es la trazabilidad: poder responder de dónde salió cada dato. Da lo mismo si el sistema es un reactor, una proteína o un precio.",
  "En el ITAM midió qué tan bien predice AlphaFold2 la estructura de las proteínas, y encontró que buena parte del error que se le atribuía no era del modelo sino del método con que se medía.",
  "Este sitio es su proyecto de portafolio y aplica esa misma idea: mide su propia precisión contra los precios que de verdad ocurrieron y la publica tal cual, aunque el resultado no favorezca al modelo.",
  "Le gusta el tenis.",
  "Publica su código en GitHub como AntonioIQ y su perfil profesional está en LinkedIn; los dos enlaces están al pie de esta página.",
]);

// Proper nouns the analyst is allowed to state when talking about him. Anything
// else that looks like a name — a university, a company, a city — means the
// model went past the profile, and the answer is replaced. Fails safe: a false
// positive costs a canned bio, a false negative invents someone's life.
export const AUTHOR_KNOWN_NAMES = Object.freeze([
  "likelycoin", "jose", "josé", "antonio", "tapia", "godinez", "godínez", "tono",
  "toño", "github", "linkedin", "antonioiq", "machine", "learning", "coingecko",
  "bitcoin", "ethereum", "netlify",
]);

export function isAuthorQuestion(question) {
  const text = normalized(question);
  return AUTHOR_TERMS.some((term) => text.includes(normalized(term)));
}

export function authorNumbers(profile = AUTHOR_PROFILE) {
  const numbers = [];
  for (const line of profile) {
    for (const raw of line.match(/\d[\d.,]*/g) ?? []) {
      const value = Number(raw.replace(/[.,]$/, "").replace(/,/g, ""));
      if (Number.isFinite(value)) numbers.push(value);
    }
  }
  return numbers;
}

export function serializeAuthorProfile(profile = AUTHOR_PROFILE) {
  return profile.map((line) => `- ${line}`).join("\n");
}

// A capitalised word that is not the first of its sentence, is not one of the
// names we published, and is not a month or a plain Spanish word that happens to
// start a clause. Cheap, and wrong only in the safe direction.
export function introducesUnknownName(answer, profile = AUTHOR_PROFILE) {
  const known = new Set([
    ...AUTHOR_KNOWN_NAMES.map(normalized),
    ...profile.flatMap((line) => line.split(/\s+/).map((word) => normalized(word.replace(/[^\p{L}\p{N}]/gu, "")))),
  ]);
  const sentences = String(answer).split(/(?<=[.!?¿?])\s+|\n+/);
  for (const sentence of sentences) {
    const words = sentence.trim().split(/\s+/).filter(Boolean);
    for (const [index, raw] of words.entries()) {
      const word = raw.replace(/[^\p{L}\p{N}]/gu, "");
      if (word.length < 3) continue;
      if (index === 0) continue;
      const first = word[0];
      if (first !== first.toLocaleUpperCase("es") || first === first.toLocaleLowerCase("es")) continue;
      if (!known.has(normalized(word))) return true;
    }
  }
  return false;
}
