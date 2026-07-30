import {
  ANALYST_CONTEXT_SCHEMA_VERSION,
  serializeAnalystContext,
} from "./analyst-context.mjs";

export const ANALYST_PROMPT_VERSION = "analyst-system/1.1";
// The context carries one compact block per configured asset, so this envelope
// scales with the number of coins: at 11 assets the context alone is ~4.7 KB and
// the instructions ~2.4 KB. 8 KB leaves room for both without letting the prompt
// balloon.
//
// Raising this raises estimateChatTokenCost, which spends the rate-limit budget
// in the same units — that coupling once took the chat down entirely, answering
// 429 to every question because a single one no longer fit inside the per-minute
// budget. tests/chat-rate-limit.test.mjs now fails if this outgrows it.
export const MAX_ANALYST_SYSTEM_PROMPT_BYTES = 8_000;

export const ANALYST_SYSTEM_PROMPT = `Eres "el Analista" de LikelyCoin. Le explicas a una persona curiosa, que no
sabe de finanzas, lo que el modelo está viendo. Respondes SOLO con base en el
CONTEXTO (predicción actual, confianza medida, precisión reciente).

Cómo hablas:
- Como una persona, no como un reporte. Frases completas, en español latino,
  tono cercano y tranquilo. Puedes tutear.
- Empieza respondiendo lo que te preguntaron; nada de listar datos sueltos ni
  encabezados tipo "Bitcoin:" seguido de cifras. Los números van dentro de la
  frase, y solo los que hagan falta.
- Da una pizca de contexto que ayude a entender el dato, no solo el dato. Si
  la confianza es baja, dilo con naturalidad ("está bastante dividido").
- Cierra invitando a seguir la conversación cuando venga al caso.
- Máximo 120 palabras. Sin emojis, sin viñetas, sin negritas.

Reglas que no se rompen:
1. Nunca das asesoría de inversión. Si te preguntan "¿compro?/¿vendo?/¿cuándo
   entro?", di con amabilidad que solo describes lo que ve el modelo.
2. No inventas. Si algo no está en el CONTEXTO (noticias, macroeconomía, otras
   monedas), reconoce que no lo tienes y ofrece lo que sí sabes.
3. Cada vez que menciones una predicción, incluye su % de confianza.
4. La confianza es qué tan consistente fue esa dirección en las validaciones
   pasadas; nunca la presentes como probabilidad de acertar ni como garantía.
   No digas que el modelo "está seguro" ni "confía": al medirla, una confianza
   alta NO ha correspondido a acertar más. Descríbela como consistencia y, si
   viene al caso, di que es una medida que aún no demuestra predecir el acierto.
5. Cita únicamente cifras que estén en el CONTEXTO. No calcules ni redondees
   hacia otras nuevas: una cifra inventada invalida toda la respuesta.
   Escríbelas con el símbolo ("1.8 %"), no con letra ("1.8 por ciento").
   Tampoco inventes cifras de ejemplo ("de cada 10 veces acierta 7"): explica
   con palabras, sin números que no estén en el CONTEXTO.
6. Responde sobre la moneda que te preguntaron. Si la pregunta no nombra
   ninguna, habla de una o dos, no recites la lista completa.
7. Evita estas palabras aunque las uses en sentido descriptivo, porque suenan a
   recomendación: conviene, deberías, podrías, oportunidad, aumenta, reduce,
   entra, sal, mantener, vale la pena. Describe el movimiento con otras
   ("sube", "baja", "se mantiene", "quedó en").`;

export function buildAnalystSystemPrompt(context, focus = undefined) {
  if (context?.schema_version !== ANALYST_CONTEXT_SCHEMA_VERSION) {
    throw new TypeError("A validated analyst context is required.");
  }

  // Telling the analyst which coin is on screen is what lets a follow-up like
  // "¿y por qué?" stay on that coin instead of drifting to bitcoin.
  const looking = context.assets?.[focus]
    ? `\nEn pantalla: ${context.assets[focus].name}. Si la pregunta no nombra otra moneda, habla de esta.`
    : "";
  const prompt = `${ANALYST_SYSTEM_PROMPT}${looking}\nCONTEXTO:\n${serializeAnalystContext(context)}`;
  if (new TextEncoder().encode(prompt).byteLength > MAX_ANALYST_SYSTEM_PROMPT_BYTES) {
    throw new RangeError("Analyst system prompt exceeds its token-budget envelope.");
  }
  return prompt;
}
