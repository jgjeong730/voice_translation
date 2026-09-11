/**
 * FluentLive translation proxy.
 *
 * The browser app previously called Gemini with the API key in the URL query
 * string and OpenAI with the key in an Authorization header, both from
 * client-side JavaScript. On a static GitHub Pages deployment that means every
 * visitor either has to paste their own key or gets no AI engine at all, and any
 * key that is used leaks into browser history, extensions and proxy logs.
 *
 * This Worker holds the keys as secrets and forwards requests. It is a thin
 * pass-through — all prompt construction stays in the client — but a deliberately
 * *constrained* one, because a public endpoint in front of a paid API key is an
 * open invitation otherwise:
 *
 *   - Origin must be on the allowlist (checked server-side, not just via CORS).
 *   - Only the specific streaming endpoints and model ids below are reachable.
 *   - Request size, input text length and max output tokens are capped.
 *   - Per-IP rate limit (best effort — see the note on the limiter).
 *
 * Deploy: see worker/README.md
 */

export interface Env {
  GEMINI_API_KEY?: string;
  OPENAI_API_KEY?: string;
  /** Comma-separated origin allowlist, e.g. "https://user.github.io,http://localhost:5173" */
  ALLOWED_ORIGINS?: string;
}

/** Models this proxy is willing to call. Keep it tight. */
const ALLOWED_GEMINI_MODELS = new Set([
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash',
]);

const ALLOWED_OPENAI_MODELS = new Set([
  'gpt-4o-mini',
]);

const ALLOWED_TTS_MODELS = new Set([
  'tts-1',
]);

const ALLOWED_TTS_VOICES = new Set([
  'alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer',
]);

const MAX_BODY_BYTES = 32_000;
const MAX_INPUT_CHARS = 4_000;
const MAX_OUTPUT_TOKENS = 1_024;
/** Whisper accepts real audio blobs, which dwarf the text-only body cap above. */
const MAX_AUDIO_BYTES = 10_000_000;
const MAX_TTS_INPUT_CHARS = 2_000;
/** Slack's own hard cap on a single message's text. */
const MAX_SLACK_TEXT_CHARS = 6_000;

/** Requests allowed per IP per window. */
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;

/**
 * Best-effort limiter. Worker isolates are per-colo and short-lived, so this
 * bounds a single burst rather than a determined attacker. For a real limit add
 * a Cloudflare WAF rate-limiting rule in the dashboard (no code needed) — the
 * README explains how.
 */
const hits = new Map<string, { count: number; resetAt: number }>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = hits.get(ip);

  if (!entry || now > entry.resetAt) {
    hits.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    if (hits.size > 10_000) hits.clear(); // crude guard against unbounded growth
    return false;
  }

  entry.count += 1;
  return entry.count > RATE_LIMIT;
}

function allowedOrigins(env: Env): string[] {
  return (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);
}

function corsHeaders(origin: string | null, env: Env): Record<string, string> {
  const list = allowedOrigins(env);
  const allow = origin && list.includes(origin) ? origin : '';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(status: number, body: unknown, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}

/** Total length of every text field the caller is asking the model to read. */
function countGeminiInputChars(payload: Record<string, unknown>): number {
  let total = 0;
  const contents = payload.contents;
  if (Array.isArray(contents)) {
    for (const item of contents) {
      const parts = (item as { parts?: Array<{ text?: string }> })?.parts;
      if (Array.isArray(parts)) for (const p of parts) total += p?.text?.length ?? 0;
    }
  }
  const sys = payload.systemInstruction as { parts?: Array<{ text?: string }> } | undefined;
  if (Array.isArray(sys?.parts)) for (const p of sys.parts) total += p?.text?.length ?? 0;
  return total;
}

function countOpenAiInputChars(payload: Record<string, unknown>): number {
  const messages = payload.messages;
  if (!Array.isArray(messages)) return 0;
  return messages.reduce<number>(
    (sum, m) => sum + (typeof (m as { content?: unknown }).content === 'string'
      ? ((m as { content: string }).content).length
      : 0),
    0,
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get('Origin');
    const cors = corsHeaders(origin, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    if (request.method !== 'POST') {
      return json(405, { error: 'Method not allowed' }, cors);
    }

    // Enforce the allowlist server-side. CORS alone only constrains browsers.
    if (!cors['Access-Control-Allow-Origin']) {
      return json(403, { error: 'Origin not allowed' }, cors);
    }

    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
    if (rateLimited(ip)) {
      return json(429, { error: '요청이 너무 잦습니다. 잠시 후 다시 시도해 주세요.' }, cors);
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '');

    // Audio upload: multipart/binary, so it must never hit the JSON body
    // parsing below (`request.text()` would mangle it).
    if (path === '/openai/audio/transcriptions') {
      return proxyWhisper(request, env, cors);
    }

    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) {
      return json(413, { error: 'Request too large' }, cors);
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return json(400, { error: 'Invalid JSON' }, cors);
    }

    const geminiMatch = path.match(/^\/gemini\/([a-zA-Z0-9.-]+)$/);
    if (geminiMatch) {
      return proxyGemini(geminiMatch[1], payload, env, cors);
    }

    if (path === '/openai/chat/completions') {
      return proxyOpenAi(payload, env, cors);
    }

    if (path === '/openai/audio/speech') {
      return proxyOpenAiTts(payload, env, cors);
    }

    if (path === '/notify/slack') {
      return proxySlack(payload, env, cors);
    }

    return json(404, { error: 'Not found' }, cors);
  },
};

async function proxyGemini(
  model: string,
  payload: Record<string, unknown>,
  env: Env,
  cors: Record<string, string>,
): Promise<Response> {
  if (!env.GEMINI_API_KEY) {
    return json(503, { error: 'Gemini 키가 이 프록시에 설정되어 있지 않습니다.' }, cors);
  }
  if (!ALLOWED_GEMINI_MODELS.has(model)) {
    return json(400, { error: `허용되지 않은 모델입니다: ${model}` }, cors);
  }
  if (countGeminiInputChars(payload) > MAX_INPUT_CHARS) {
    return json(413, { error: '입력이 너무 깁니다.' }, cors);
  }

  // Never let a caller run up the bill with a huge generation.
  const generationConfig = (payload.generationConfig ?? {}) as Record<string, unknown>;
  payload.generationConfig = {
    ...generationConfig,
    maxOutputTokens: Math.min(
      Number(generationConfig.maxOutputTokens) || MAX_OUTPUT_TOKENS,
      MAX_OUTPUT_TOKENS,
    ),
  };

  const upstream = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Header rather than a query string: keys do not belong in URLs.
        'x-goog-api-key': env.GEMINI_API_KEY,
      },
      body: JSON.stringify(payload),
    },
  );

  return streamBack(upstream, cors);
}

async function proxyOpenAi(
  payload: Record<string, unknown>,
  env: Env,
  cors: Record<string, string>,
): Promise<Response> {
  if (!env.OPENAI_API_KEY) {
    return json(503, { error: 'OpenAI 키가 이 프록시에 설정되어 있지 않습니다.' }, cors);
  }

  const model = String(payload.model ?? '');
  if (!ALLOWED_OPENAI_MODELS.has(model)) {
    return json(400, { error: `허용되지 않은 모델입니다: ${model}` }, cors);
  }
  if (countOpenAiInputChars(payload) > MAX_INPUT_CHARS) {
    return json(413, { error: '입력이 너무 깁니다.' }, cors);
  }

  payload.max_tokens = Math.min(Number(payload.max_tokens) || MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS);

  const upstream = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });

  return streamBack(upstream, cors);
}

/**
 * Whisper transcription. Unlike every other route this body is multipart audio,
 * not JSON, so it bypasses the shared `request.text()`/`JSON.parse` step above
 * entirely and reads the request its own way.
 */
async function proxyWhisper(
  request: Request,
  env: Env,
  cors: Record<string, string>,
): Promise<Response> {
  if (!env.OPENAI_API_KEY) {
    return json(503, { error: 'OpenAI 키가 이 프록시에 설정되어 있지 않습니다.' }, cors);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json(400, { error: 'Invalid multipart body' }, cors);
  }

  const file = form.get('file');
  if (!(file instanceof Blob)) {
    return json(400, { error: 'file 필드가 필요합니다.' }, cors);
  }
  if (file.size > MAX_AUDIO_BYTES) {
    return json(413, { error: '오디오 파일이 너무 큽니다.' }, cors);
  }

  const language = form.get('language');

  const upstreamForm = new FormData();
  upstreamForm.append('file', file, 'audio.webm');
  upstreamForm.append('model', 'whisper-1');
  if (typeof language === 'string' && /^[a-z]{2}$/.test(language)) {
    upstreamForm.append('language', language);
  }

  const upstream = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: upstreamForm,
  });

  return streamBack(upstream, cors);
}

async function proxyOpenAiTts(
  payload: Record<string, unknown>,
  env: Env,
  cors: Record<string, string>,
): Promise<Response> {
  if (!env.OPENAI_API_KEY) {
    return json(503, { error: 'OpenAI 키가 이 프록시에 설정되어 있지 않습니다.' }, cors);
  }

  const model = String(payload.model ?? '');
  if (!ALLOWED_TTS_MODELS.has(model)) {
    return json(400, { error: `허용되지 않은 모델입니다: ${model}` }, cors);
  }

  const input = payload.input;
  if (typeof input !== 'string' || !input.trim()) {
    return json(400, { error: 'input이 필요합니다.' }, cors);
  }
  if (input.length > MAX_TTS_INPUT_CHARS) {
    return json(413, { error: '입력이 너무 깁니다.' }, cors);
  }

  const voice = typeof payload.voice === 'string' && ALLOWED_TTS_VOICES.has(payload.voice)
    ? payload.voice
    : 'alloy';

  const upstream = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      voice,
      input,
      response_format: 'mp3',
      speed: typeof payload.speed === 'number' ? payload.speed : 1.0,
    }),
  });

  return streamBack(upstream, cors);
}

/**
 * Relays a summary to a Slack Incoming Webhook. This is the one route that
 * isn't proxying a paid AI key — it exists purely because Slack's webhook
 * endpoint doesn't send CORS headers, so a browser can't POST to it directly.
 * Since the caller supplies the destination URL, it is locked to Slack's own
 * webhook host so this can't be turned into an open relay to arbitrary URLs.
 */
async function proxySlack(
  payload: Record<string, unknown>,
  _env: Env,
  cors: Record<string, string>,
): Promise<Response> {
  const webhookUrl = payload.webhookUrl;
  if (typeof webhookUrl !== 'string' || !/^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+$/.test(webhookUrl)) {
    return json(400, { error: 'webhookUrl이 올바른 Slack Incoming Webhook 주소가 아닙니다.' }, cors);
  }

  const text = payload.text;
  if (typeof text !== 'string' || !text.trim()) {
    return json(400, { error: 'text가 필요합니다.' }, cors);
  }
  if (text.length > MAX_SLACK_TEXT_CHARS) {
    return json(413, { error: '메시지가 너무 깁니다.' }, cors);
  }

  const upstream = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });

  return json(upstream.ok ? 200 : 502, { ok: upstream.ok }, cors);
}

/**
 * Pipe the upstream response straight through unbuffered, preserving whatever
 * `Content-Type` it came with (SSE text for translate, JSON for Whisper, or
 * binary audio for TTS) — this is what makes it reusable across all of them.
 */
function streamBack(upstream: Response, cors: Record<string, string>): Response {
  const headers = new Headers(cors);
  headers.set('Content-Type', upstream.headers.get('Content-Type') ?? 'text/event-stream');
  headers.set('Cache-Control', 'no-store');
  return new Response(upstream.body, { status: upstream.status, headers });
}
