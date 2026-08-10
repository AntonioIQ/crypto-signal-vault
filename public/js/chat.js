const CHAT_ENDPOINT = '/api/chat';
const SESSION_STORAGE_KEY = 'likelycoin.analyst.session';
// The conversation lives here and nowhere else: the server reads it and throws
// it away, so closing the tab is what deletes it (docs/08_CONVERSACION.md §2).
const THREAD_STORAGE_KEY = 'likelycoin.analyst.thread';
const MAX_QUESTION_CHARACTERS = 400;
// What stays on screen, and what actually travels. Sending the whole thread
// would grow the prompt without bound; six turns is enough for a follow-up to
// make sense and matches the server's envelope.
const MAX_THREAD_TURNS = 20;
const MAX_SENT_TURNS = 6;
const MAX_TURN_CHARACTERS = 600;
const CONFIG_TIMEOUT_MS = 6_000;
const ANSWER_TIMEOUT_MS = 15_000;
// Written by the server, never by the model: an answer carrying it is about
// something we did not measure, and the transcript marks it as such.
const GENERAL_ANSWER_PREFIX = 'Esto no sale de lo que medimos en LikelyCoin:';

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

function validTurn(turn) {
  return turn !== null
    && typeof turn === 'object'
    && (turn.role === 'user' || turn.role === 'analyst')
    && typeof turn.text === 'string'
    && turn.text.trim().length > 0;
}

// Storage is the reader's to edit, so what comes back out is treated exactly
// like anything else that crosses a boundary: shape-checked and trimmed.
export function readThread(storage) {
  let raw = null;
  try {
    raw = storage?.getItem?.(THREAD_STORAGE_KEY);
  } catch {
    return [];
  }
  if (typeof raw !== 'string' || raw.length === 0) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter(validTurn)
    .map((turn) => ({
      role: turn.role,
      text: turn.text.trim().slice(0, MAX_TURN_CHARACTERS),
    }))
    .slice(-MAX_THREAD_TURNS);
}

export function writeThread(storage, turns) {
  try {
    storage?.setItem?.(THREAD_STORAGE_KEY, JSON.stringify(turns.slice(-MAX_THREAD_TURNS)));
  } catch {
    // Nothing to do: the conversation still works in memory for this page view.
  }
}

export function clearThread(storage) {
  try {
    storage?.removeItem?.(THREAD_STORAGE_KEY);
  } catch {
    // Same as above — the in-memory transcript is cleared by the caller.
  }
}

export function historyForRequest(thread) {
  return thread.slice(-MAX_SENT_TURNS).map((turn) => ({
    role: turn.role,
    text: turn.text.slice(0, MAX_TURN_CHARACTERS),
  }));
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

// Which coin the page is showing. Read from the DOM rather than wired through
// app.js so the chat stays independent of it; the server validates the value
// against its own asset list anyway.
export function selectedAsset(root = globalThis.document) {
  return root?.querySelector?.('.tab.active')?.dataset?.asset ?? null;
}

export async function askAnalyst(
  question,
  sessionId,
  fetchFn = globalThis.fetch,
  asset = selectedAsset(),
  history = [],
) {
  const normalized = normalizeQuestion(question);
  const body = { question: normalized, sessionId };
  if (asset) body.asset = asset;
  if (history.length > 0) body.history = history;
  const response = await fetchWithTimeout(fetchFn, CHAT_ENDPOINT, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
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

export function initTranscript(documentRef, container) {
  const paint = (turn) => {
    const item = documentRef.createElement('article');
    const outsideOurData = turn.role === 'analyst'
      && turn.text.startsWith(GENERAL_ANSWER_PREFIX);
    item.className = [
      'analyst-turn',
      turn.role === 'user' ? 'analyst-turn-user' : 'analyst-turn-analyst',
      outsideOurData ? 'analyst-turn-general' : '',
    ].filter(Boolean).join(' ');

    const who = documentRef.createElement('p');
    who.className = 'analyst-turn-who';
    who.textContent = turn.role === 'user' ? 'Tú' : 'El analista';

    const body = documentRef.createElement('p');
    body.className = 'analyst-turn-text';
    // textContent, always. The answer is text, never markup.
    body.textContent = turn.text;

    item.appendChild(who);
    item.appendChild(body);
    container.appendChild(item);
    return item;
  };

  return {
    paint,
    render(turns) {
      container.replaceChildren();
      turns.forEach(paint);
      container.hidden = turns.length === 0;
    },
  };
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
  const threadPanel = documentRef.getElementById('analyst-thread');
  const clearButton = documentRef.getElementById('analyst-clear');
  const quickButtons = [...section.querySelectorAll('[data-question]')];
  const sessionId = getSessionId(storage, cryptoApi);
  const transcript = initTranscript(documentRef, threadPanel);

  let thread = readThread(storage);
  transcript.render(thread);
  if (clearButton) clearButton.hidden = thread.length === 0;

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

  const commit = (turn) => {
    thread = [...thread, turn].slice(-MAX_THREAD_TURNS);
    writeThread(storage, thread);
    threadPanel.hidden = false;
    transcript.paint(turn);
    if (clearButton) clearButton.hidden = false;
  };

  const sendQuestion = async (value) => {
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
    // The question is painted before the answer arrives: the transcript should
    // read like a conversation, not appear all at once when the reply lands.
    const history = historyForRequest(thread);
    commit({ role: 'user', text: question });
    questionInput.value = '';
    updateCounter();

    try {
      const result = await askAnalyst(question, sessionId, fetchFn, selectedAsset(documentRef), history);
      commit({ role: 'analyst', text: result.answer });
      setStatus('success', '');
      threadPanel.focus?.({ preventScroll: true });
    } catch (error) {
      const copy = errorCopy(error);
      if (copy === 'disabled') {
        section.hidden = true;
        return;
      }
      questionInput.value = question;
      updateCounter();
      // The unanswered question does not stay in the thread: it would be sent
      // as context for the next one and the analyst would answer it twice.
      thread = thread.slice(0, -1);
      writeThread(storage, thread);
      transcript.render(thread);
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
  clearButton?.addEventListener('click', () => {
    thread = [];
    clearThread(storage);
    transcript.render(thread);
    clearButton.hidden = true;
    setStatus('idle', '');
    questionInput.focus();
  });
}

if (typeof document !== 'undefined') {
  initChat();
}
