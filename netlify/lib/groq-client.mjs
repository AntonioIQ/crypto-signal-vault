export const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
export const GROQ_MODEL = "llama-3.3-70b-versatile";
export const GROQ_MAX_OUTPUT_TOKENS = 180;
export const GROQ_TIMEOUT_MS = 8_000;

export class GroqClientError extends Error {
  constructor(code) {
    super("The inference provider is unavailable.");
    this.name = "GroqClientError";
    this.code = code;
  }
}

export function createGroqClient({
  apiKey,
  fetchFn = globalThis.fetch,
  baseUrl = GROQ_BASE_URL,
  model = GROQ_MODEL,
  timeoutMs = GROQ_TIMEOUT_MS,
} = {}) {
  return {
    async complete({ systemPrompt, question }) {
      if (typeof apiKey !== "string" || apiKey.length === 0) {
        throw new GroqClientError("missing_key");
      }
      if (typeof fetchFn !== "function") {
        throw new GroqClientError("missing_fetch");
      }

      const controller = new AbortController();
      let timeout;
      const timeoutPromise = new Promise((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new GroqClientError("timeout"));
        }, timeoutMs);
      });

      const requestPromise = async () => {
        const response = await fetchFn(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model,
            temperature: 0.2,
            max_tokens: GROQ_MAX_OUTPUT_TOKENS,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: question },
            ],
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new GroqClientError(response.status === 429 ? "rate_limited" : "http_error");
        }

        let payload;
        try {
          payload = JSON.parse(await response.text());
        } catch {
          throw new GroqClientError("invalid_json");
        }

        const answer = payload?.choices?.[0]?.message?.content;
        if (typeof answer !== "string" || answer.trim().length === 0) {
          throw new GroqClientError("empty_response");
        }
        return answer.trim();
      };

      try {
        return await Promise.race([requestPromise(), timeoutPromise]);
      } catch (error) {
        if (error instanceof GroqClientError) throw error;
        throw new GroqClientError("network_error");
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
