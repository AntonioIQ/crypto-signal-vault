const CHAT_ENDPOINT = '/api/chat';
const SESSION_STORAGE_KEY = 'likelycoin.analyst.session';
const MAX_QUESTION_CHARACTERS = 400;
const CONFIG_TIMEOUT_MS = 6_000;
const ANSWER_TIMEOUT_MS = 15_000;

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class ChatRequestError extends Error {
  constructor(status, code = 'request_failed') {
    super('The analyst request failed.');
    this.name = 'ChatRequestError';
    this.status = status;
    this.code = code;
  }
}

export function normalizeQuestion(value) {
  if (typeof value !== 'string') throw new TypeError('A question is required.');
  const question = value.trim();
  if ([...question].length < 1 || [...question].length > MAX_QUESTION_CHARACTERS) {
    throw new RangeError('The question length is invalid.');
  }
  return question;
}

function fallbackUuid(cryptoApi) {
  const bytes = new Uint8Array(16);
  cryptoApi.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function getSessionId(storage, cryptoApi = globalThis.crypto) {
  let existing = null;
  try {
    existing = storage?.getItem?.(SESSION_STORAGE_KEY);
  } catch {
    // Storage may be unavailable in a private session.
  }
  if (typeof existing === 'string' && UUID_V4_PATTERN.test(existing)) return existing;

  const sessionId = typeof cryptoApi?.randomUUID === 'function'
    ? cryptoApi.randomUUID()
    : fallbackUuid(cryptoApi);
  try {
    storage?.setItem?.(SESSION_STORAGE_KEY, sessionId);
  } catch {
    // A private browser session may reject storage; the in-memory UUID still works.
  }
  return sessionId;
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function fetchWithTimeout(fetchFn, url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchFn(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

export async function readChatConfig(fetchFn = globalThis.fetch) {
  const response = await fetchWithTimeout(fetchFn, CHAT_ENDPOINT, {
    headers: { accept: 'application/json' },
  }, CONFIG_TIMEOUT_MS);
  if (!response.ok) throw new ChatRequestError(response.status);
  const payload = await safeJson(response);
  return payload?.enabled === true;
}

export async function askAnalyst(question, sessionId, fetchFn = globalThis.fetch) {
  const normalized = normalizeQuestion(question);
  const response = await fetchWithTimeout(fetchFn, CHAT_ENDPOINT, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ question: normalized, sessionId }),
  }, ANSWER_TIMEOUT_MS);
  const payload = await safeJson(response);
  if (!response.ok) {
    throw new ChatRequestError(response.status, payload?.error?.code);
  }
  if (typeof payload?.answer !== 'string' || typeof payload?.degraded !== 'boolean') {
    throw new ChatRequestError(502, 'invalid_response');
  }
  return { answer: payload.answer, degraded: payload.degraded };
}

function errorCopy(error) {
  if (error?.code === 'chat_disabled') return 'disabled';
  if (error?.status === 400) return 'Escribe una pregunta de hasta 400 caracteres.';
  if (error?.status === 429) return 'Alcanzamos el límite temporal. Intenta de nuevo más tarde.';
  return 'El analista no está disponible en este momento. Intenta de nuevo más tarde.';
}

export async function initChat({
  documentRef = globalThis.document,
  fetchFn = globalThis.fetch,
  storage = globalThis.sessionStorage,
  cryptoApi = globalThis.crypto,
} = {}) {
  const section = documentRef?.getElementById('analyst-section');
  if (!section) return;

  let enabled;
  try {
    enabled = await readChatConfig(fetchFn);
  } catch {
    return;
  }
  if (!enabled) return;
  section.hidden = false;

  const form = documentRef.getElementById('analyst-form');
  const questionInput = documentRef.getElementById('analyst-question');
  const submit = documentRef.getElementById('analyst-submit');
  const counter = documentRef.getElementById('analyst-count');
  const status = documentRef.getElementById('analyst-status');
  const answerPanel = documentRef.getElementById('analyst-answer');
  const answerText = documentRef.getElementById('analyst-answer-text');
  const quickButtons = [...section.querySelectorAll('[data-question]')];
  const sessionId = getSessionId(storage, cryptoApi);

  const setBusy = (busy) => {
    form.setAttribute('aria-busy', String(busy));
    questionInput.disabled = busy;
    submit.disabled = busy;
    quickButtons.forEach((button) => { button.disabled = busy; });
  };

  const updateCounter = () => {
    counter.textContent = `${[...questionInput.value].length}/400`;
  };

  const setStatus = (kind, copy) => {
    status.classList.toggle('error', kind === 'error');
    status.textContent = copy;
  };

  const clearAnswer = () => {
    answerPanel.hidden = true;
    answerText.textContent = '';
  };

  const sendQuestion = async (value) => {
    clearAnswer();
    let question;
    try {
      question = normalizeQuestion(value);
    } catch {
      questionInput.setAttribute('aria-invalid', 'true');
      setStatus('error', 'Escribe una pregunta de hasta 400 caracteres.');
      questionInput.focus();
      return;
    }

    questionInput.removeAttribute('aria-invalid');
    setBusy(true);
    setStatus('loading', 'Preparando una respuesta…');
    try {
      const result = await askAnalyst(question, sessionId, fetchFn);
      answerText.textContent = result.answer;
      answerPanel.hidden = false;
      setStatus('success', '');
      answerPanel.focus({ preventScroll: true });
    } catch (error) {
      const copy = errorCopy(error);
      if (copy === 'disabled') {
        section.hidden = true;
        return;
      }
      questionInput.setAttribute('aria-invalid', 'true');
      setStatus('error', copy);
      questionInput.focus();
    } finally {
      setBusy(false);
    }
  };

  questionInput.addEventListener('input', () => {
    updateCounter();
    questionInput.removeAttribute('aria-invalid');
    if (status.classList.contains('error')) setStatus('idle', '');
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    return sendQuestion(questionInput.value);
  });
  quickButtons.forEach((button) => {
    button.addEventListener('click', async () => {
      questionInput.value = button.dataset.question;
      updateCounter();
      return sendQuestion(questionInput.value);
    });
  });
}

if (typeof document !== 'undefined') {
  initChat();
}
