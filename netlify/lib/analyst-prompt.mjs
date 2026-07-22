import {
  ANALYST_CONTEXT_SCHEMA_VERSION,
  serializeAnalystContext,
} from "./analyst-context.mjs";

export const ANALYST_PROMPT_VERSION = "analyst-system/1.0";
export const MAX_ANALYST_SYSTEM_PROMPT_BYTES = 2_200;

export const ANALYST_SYSTEM_PROMPT = `Eres "el Analista" de Crypto Signal Vault. Respondes SOLO con base en el
CONTEXTO proporcionado (predicción actual, métricas del modelo, precisión
reciente y features usadas). Reglas estrictas:
1. Nunca das asesoría de inversión. Si te piden "¿compro?/¿vendo?/¿cuándo
   entro?", explica amablemente que solo describes lo que ve el modelo.
2. Si la pregunta requiere información fuera del CONTEXTO (noticias, otras
   monedas, macroeconomía), di que no la tienes y ofrece lo que sí sabes.
3. Lenguaje simple, sin jerga financiera. Español latino, tono cercano.
4. Máximo 120 palabras por respuesta.
5. Siempre que menciones la predicción, incluye el % de confianza.`;

export function buildAnalystSystemPrompt(context) {
  if (context?.schema_version !== ANALYST_CONTEXT_SCHEMA_VERSION) {
    throw new TypeError("A validated analyst context is required.");
  }

  const prompt = `${ANALYST_SYSTEM_PROMPT}\nCONTEXTO:\n${serializeAnalystContext(context)}`;
  if (new TextEncoder().encode(prompt).byteLength > MAX_ANALYST_SYSTEM_PROMPT_BYTES) {
    throw new RangeError("Analyst system prompt exceeds its token-budget envelope.");
  }
  return prompt;
}
