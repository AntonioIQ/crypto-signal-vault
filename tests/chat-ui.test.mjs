import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  askAnalyst,
  getSessionId,
  initChat,
  normalizeQuestion,
  readChatConfig,
} from "../public/js/chat.js";

const SESSION_ID = "123e4567-e89b-42d3-a456-426614174000";

test("client validates question bounds", () => {
  assert.equal(normalizeQuestion("  Hola  "), "Hola");
  assert.equal(normalizeQuestion("a".repeat(400)).length, 400);
  assert.throws(() => normalizeQuestion(""));
  assert.throws(() => normalizeQuestion("a".repeat(401)));
});

test("session id is ephemeral and reused from session storage", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  let generated = 0;
  const cryptoApi = {
    randomUUID() {
      generated += 1;
      return SESSION_ID;
    },
  };
  assert.equal(getSessionId(storage, cryptoApi), SESSION_ID);
  assert.equal(getSessionId(storage, cryptoApi), SESSION_ID);
  assert.equal(generated, 1);
  assert.equal([...values.values()].some((value) => value.includes("pregunta")), false);
});

test("client config only enables an exact true boolean", async () => {
  assert.equal(await readChatConfig(async () => new Response('{"enabled":true}', { status: 200 })), true);
  assert.equal(await readChatConfig(async () => new Response('{"enabled":"true"}', { status: 200 })), false);
});

test("client sends one question and session id with no history or context", async () => {
  let request;
  const result = await askAnalyst("¿Qué ves?", SESSION_ID, async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ answer: "Datos actuales.", degraded: false }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  assert.deepEqual(result, { answer: "Datos actuales.", degraded: false });
  assert.equal(request.url, "/api/chat");
  assert.deepEqual(JSON.parse(request.options.body), {
    question: "¿Qué ves?",
    sessionId: SESSION_ID,
  });
  assert.equal(request.options.body.includes("history"), false);
  assert.equal(request.options.body.includes("context"), false);
  assert.equal(request.options.body.includes("system"), false);
});

function fakeElement({ hidden = false, dataset = {} } = {}) {
  const listeners = {};
  const attributes = new Map();
  const classes = new Set();
  return {
    hidden,
    dataset,
    value: "",
    textContent: "",
    disabled: false,
    focusCount: 0,
    listeners,
    setAttribute(name, value) { attributes.set(name, String(value)); },
    removeAttribute(name) { attributes.delete(name); },
    getAttribute(name) { return attributes.get(name) ?? null; },
    addEventListener(name, listener) { listeners[name] = listener; },
    focus() { this.focusCount += 1; },
    classList: {
      toggle(name, force) {
        if (force) classes.add(name);
        else classes.delete(name);
      },
      contains(name) { return classes.has(name); },
    },
  };
}

test("initChat reveals the flag, announces an answer, and clears stale content on error", async () => {
  const section = fakeElement({ hidden: true });
  const form = fakeElement();
  const question = fakeElement();
  const submit = fakeElement();
  const counter = fakeElement();
  const status = fakeElement();
  const answer = fakeElement({ hidden: true });
  const answerText = fakeElement();
  const quickButtons = [fakeElement({ dataset: { question: "¿Qué ves?" } })];
  section.querySelectorAll = () => quickButtons;
  const elements = new Map([
    ["analyst-section", section],
    ["analyst-form", form],
    ["analyst-question", question],
    ["analyst-submit", submit],
    ["analyst-count", counter],
    ["analyst-status", status],
    ["analyst-answer", answer],
    ["analyst-answer-text", answerText],
  ]);
  const documentRef = { getElementById: (id) => elements.get(id) ?? null };
  const storage = { getItem: () => null, setItem() {} };
  const cryptoApi = { randomUUID: () => SESSION_ID };
  const fetchFn = async (url, options = {}) => {
    if (options.method === "POST") {
      return new Response(JSON.stringify({ answer: "Respuesta accesible.", degraded: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response('{"enabled":true}', { status: 200 });
  };

  await initChat({ documentRef, fetchFn, storage, cryptoApi });
  assert.equal(section.hidden, false);
  question.value = "¿Qué ves?";
  await form.listeners.submit({ preventDefault() {} });
  assert.equal(answer.hidden, false);
  assert.equal(answerText.textContent, "Respuesta accesible.");
  assert.equal(answer.focusCount, 1);
  assert.equal(form.getAttribute("aria-busy"), "false");
  assert.equal(status.textContent, "");

  question.value = "";
  await form.listeners.submit({ preventDefault() {} });
  assert.equal(answer.hidden, true);
  assert.equal(answerText.textContent, "");
  assert.equal(question.getAttribute("aria-invalid"), "true");
  assert.match(status.textContent, /hasta 400 caracteres/);
  assert.equal(status.classList.contains("error"), true);

  question.value = "Nueva pregunta";
  question.listeners.input();
  assert.equal(question.getAttribute("aria-invalid"), null);
  assert.equal(status.textContent, "");
});

test("chat markup is hidden by default, accessible, and carries permanent disclaimer", async () => {
  const html = await readFile("public/index.html", "utf8");
  assert.match(html, /id="analyst-section"[^>]*hidden/);
  assert.match(html, /id="analyst-question"[\s\S]*maxlength="400"/);
  assert.match(html, /Este analista describe los datos del modelo/);
  assert.match(html, /data-question=/);
  assert.match(html, /<button type="button" data-question=/);
  assert.match(html, /class="quick-questions" role="group"/);
  assert.match(html, /id="analyst-answer"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /<script type="module" src="js\/chat\.js"><\/script>/);
});

test("public client has no provider secret, endpoint, authorization, debug logs, or HTML sink", async () => {
  const client = await readFile("public/js/chat.js", "utf8");
  const html = await readFile("public/index.html", "utf8");
  const publicSurface = `${client}\n${html}`;
  assert.doesNotMatch(publicSurface, /GROQ_API_KEY|gsk_|groq\.com|authorization/i);
  assert.doesNotMatch(client, /console\.|innerHTML|outerHTML|insertAdjacentHTML/);
  assert.match(client, /answerText\.textContent = result\.answer/);
});
