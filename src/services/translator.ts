import type { AppSettings, GlossaryItem, LearningDetail, MeetingSummary, TranslationItem, TranslationMode } from '../types';
import { TRANSLATION_MODES } from '../constants';
import { applyGlossaryToText, formatGlossaryForPrompt, removeDisfluencies, KOREAN_IDIOM_MAP } from '../utils/textCleaner';
import { readSseStream } from './sseStream';

/** Strip a trailing slash so `${proxy}/gemini/...` never doubles up. */
export function normalizeProxyUrl(value: string | undefined): string {
  return (value ?? '').trim().replace(/\/+$/, '');
}

/** Turn an HTTP failure into something a user can act on. */
function describeApiError(provider: string, status: number, detail: string): string {
  const trimmed = detail.slice(0, 300);

  // The proxy answers with its own JSON `error` string; prefer it.
  try {
    const parsed = JSON.parse(trimmed) as { error?: unknown };
    if (typeof parsed.error === 'string') return parsed.error;
  } catch {
    // Not the proxy's shape — fall through to the generic mapping.
  }

  if (status === 400 && /API_?key|api key/i.test(trimmed)) return `${provider} API 키가 올바르지 않습니다.`;
  if (status === 401 || status === 403) return `${provider} API 키가 거부되었습니다 (권한 또는 키 확인).`;
  if (status === 413) return '입력이 너무 깁니다.';
  if (status === 404) return `${provider} 모델을 찾을 수 없습니다 (모델 이름이 더 이상 제공되지 않을 수 있습니다).`;
  if (status === 429) return `${provider} 요청 한도를 초과했습니다.`;
  if (status >= 500) return `${provider} 서버 오류 (${status}).`;
  return `${provider} 오류 (${status}).`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** True for both `AbortController` aborts and manual AbortError throws. */
export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException ? err.name === 'AbortError'
    : typeof err === 'object' && err !== null && (err as { name?: string }).name === 'AbortError';
}

export interface ConversationContext {
  sourceText: string;
  translatedText: string;
}

export interface TranslateRequest {
  text: string;
  sourceLang: string;
  targetLang: string;
  mode: TranslationMode;
  glossary: GlossaryItem[];
  settings: AppSettings;
  history?: ConversationContext[];
  onChunk?: (chunk: string, fullTranslatedText: string) => void;
  /** Aborts an in-flight request when a newer utterance supersedes it. */
  signal?: AbortSignal;
}

export interface TranslateResult {
  translatedText: string;
  cleanedSourceText: string;
  learningDetails?: LearningDetail;
  /** Time until the full translation finished streaming. */
  latencyMs: number;
  /**
   * Time to first token. This is the number that matches what a viewer feels,
   * whereas `latencyMs` also includes however long the rest of the sentence took
   * to stream in.
   */
  ttftMs?: number;
  /** Which engine actually produced this text. */
  engineUsed: EngineId;
  /**
   * Set when a configured AI engine failed and the built-in engine took over.
   * Previously this was swallowed, so a wrong API key or model name silently
   * degraded every translation with nothing shown to the user.
   */
  fallbackReason?: string;
}

export type EngineId = AppSettings['engine'] | 'builtin';

/**
 * Advanced Translation Service supporting Gemini Flash, OpenAI, and Smart Local Fallback
 * Features Rolling Context Buffer, Deep Pragmatics & Nuance Engine, Subject Restoration, and Idiomatic Localization
 */
export class TranslationService {
  /**
   * Translate with streaming support & contextual history
   */
  public async translate(req: TranslateRequest): Promise<TranslateResult> {
    const startTime = performance.now();
    
    // 1. Disfluency & Stutter Cleaning
    const { cleanedText } = req.settings.disfluencyFilter 
      ? removeDisfluencies(req.text)
      : { cleanedText: req.text };

    if (!cleanedText.trim()) {
      return {
        translatedText: '',
        cleanedSourceText: '',
        latencyMs: 0,
        engineUsed: 'builtin',
      };
    }

    const modeConfig = TRANSLATION_MODES.find(m => m.id === req.mode) || TRANSLATION_MODES[0];
    const glossaryPrompt = formatGlossaryForPrompt(req.glossary);
    const historyPrompt = this.formatHistoryPrompt(req.history);

    let result: TranslateResult;

    // Route by engine. A configured proxy stands in for a key: it holds the
    // credential server-side, so the browser needs neither.
    const proxy = normalizeProxyUrl(req.settings.proxyUrl);

    if (req.settings.engine.startsWith('gemini') && (proxy || req.settings.geminiApiKey)) {
      result = await this.translateWithGemini(cleanedText, req, modeConfig.promptGuidance, glossaryPrompt, historyPrompt, startTime);
    } else if (req.settings.engine === 'gpt-4o-mini' && (proxy || req.settings.openaiApiKey)) {
      result = await this.translateWithOpenAI(cleanedText, req, modeConfig.promptGuidance, glossaryPrompt, historyPrompt, startTime);
    } else {
      // Smart Fallback (Enhanced Google Translate + Local Pragmatics & Heuristics)
      result = await this.translateWithSmartFallback(cleanedText, req, startTime);
    }

    return result;
  }

  /**
   * Classifies which of two candidate languages a short utterance is in, using
   * whichever AI engine the user already has configured (downgraded to the
   * cheapest variant). Used to auto-flip source/target direction in a
   * back-and-forth conversation without a manual swap.
   *
   * Best-effort: any failure (no engine configured, network error, unparseable
   * reply) resolves to `null` rather than throwing, since "don't flip" is
   * always a safe fallback and this must never interrupt the main translation.
   */
  public async detectLanguage(
    text: string,
    candidateA: string,
    candidateB: string,
    settings: AppSettings,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const proxy = normalizeProxyUrl(settings.proxyUrl);
    const prompt = `다음 텍스트가 "${candidateA}" 또는 "${candidateB}" 중 어느 언어로 작성되었는지 판단하세요. 반드시 "${candidateA}" 또는 "${candidateB}" 둘 중 하나만, 다른 설명 없이 출력하세요.\n\n텍스트: ${text}`;

    try {
      if (settings.engine.startsWith('gemini') && (proxy || settings.geminiApiKey)) {
        const endpoint = proxy
          ? `${proxy}/gemini/gemini-2.5-flash-lite`
          : 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:streamGenerateContent?alt=sse';
        const raw = await this.runOneShot(
          endpoint,
          proxy ? {} : { 'x-goog-api-key': settings.geminiApiKey },
          { contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0, maxOutputTokens: 5 } },
          'gemini',
          signal,
        );
        return this.pickCandidate(raw, candidateA, candidateB);
      }

      if (settings.engine === 'gpt-4o-mini' && (proxy || settings.openaiApiKey)) {
        const endpoint = proxy ? `${proxy}/openai/chat/completions` : 'https://api.openai.com/v1/chat/completions';
        const raw = await this.runOneShot(
          endpoint,
          proxy ? {} : { Authorization: `Bearer ${settings.openaiApiKey}` },
          { model: 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], stream: true, max_tokens: 5, temperature: 0 },
          'openai',
          signal,
        );
        return this.pickCandidate(raw, candidateA, candidateB);
      }

      return null;
    } catch (err) {
      if (isAbortError(err)) throw err;
      return null;
    }
  }

  /** Match the model's free-text reply back to one of the two candidate codes. */
  private pickCandidate(raw: string, a: string, b: string): string | null {
    const cleaned = raw.trim().toLowerCase().replace(/[^a-z]/g, '');
    if (cleaned === a.toLowerCase() || cleaned.startsWith(a.toLowerCase())) return a;
    if (cleaned === b.toLowerCase() || cleaned.startsWith(b.toLowerCase())) return b;
    return null;
  }

  /**
   * One-shot (non-interactive-streaming) request: reads the full SSE stream
   * internally and returns the accumulated text. Shared by detectLanguage and
   * generateMeetingSummary, neither of which renders token-by-token.
   */
  private async runOneShot(
    endpoint: string,
    extraHeaders: Record<string, string>,
    body: Record<string, unknown>,
    provider: 'gemini' | 'openai',
    signal?: AbortSignal,
  ): Promise<string> {
    const response = await fetch(endpoint, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json', ...extraHeaders },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(describeApiError(provider === 'gemini' ? 'Gemini' : 'OpenAI', response.status, detail));
    }

    let out = '';
    if (response.body) {
      await readSseStream(response.body, (payload) => {
        try {
          const data = JSON.parse(payload);
          out += provider === 'gemini'
            ? (data.candidates?.[0]?.content?.parts?.[0]?.text || '')
            : (data.choices?.[0]?.delta?.content || '');
        } catch {
          // Malformed chunk — skip it, don't abort the whole read.
        }
      }, signal);
    }
    return out;
  }

  /**
   * Summarizes the call into a short recap + action items. Requires a real AI
   * engine — the built-in fallback has no way to synthesize a summary.
   */
  public async generateMeetingSummary(
    items: TranslationItem[],
    settings: AppSettings,
    signal?: AbortSignal,
  ): Promise<MeetingSummary> {
    if (items.length === 0) {
      return { summary: '요약할 대화 내용이 없습니다.', actionItems: [] };
    }

    const proxy = normalizeProxyUrl(settings.proxyUrl);
    const useGemini = settings.engine.startsWith('gemini') && (proxy || settings.geminiApiKey);
    const useOpenAi = !useGemini && settings.engine === 'gpt-4o-mini' && (proxy || settings.openaiApiKey);

    if (!useGemini && !useOpenAi) {
      throw new Error('회의 요약은 Gemini 또는 OpenAI 엔진 설정이 필요합니다 (내장 엔진은 지원하지 않습니다).');
    }

    // `items` is stored newest-first; the model should read it chronologically.
    const transcript = [...items].reverse()
      .map((item, i) => `${i + 1}. [${item.sourceLang} ➔ ${item.targetLang}] ${item.translatedText}`)
      .join('\n');

    const prompt = `다음은 실시간 통역된 회의/통화 대화록입니다. 이를 바탕으로 (1) 3~6문장의 한국어 요약과 (2) 실행 가능한 액션 아이템 목록을 뽑아주세요.
반드시 아래 JSON 형식으로만 응답하세요:
{"summary": "...", "actionItems": ["...", "..."]}
액션 아이템이 없으면 빈 배열로 응답하세요.

[대화록]
${transcript}`;

    const raw = useGemini
      ? await this.runOneShot(
          proxy ? `${proxy}/gemini/gemini-2.5-flash` : 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse',
          proxy ? {} : { 'x-goog-api-key': settings.geminiApiKey },
          { contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.3, maxOutputTokens: 1024 } },
          'gemini',
          signal,
        )
      : await this.runOneShot(
          proxy ? `${proxy}/openai/chat/completions` : 'https://api.openai.com/v1/chat/completions',
          proxy ? {} : { Authorization: `Bearer ${settings.openaiApiKey}` },
          { model: 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], stream: true, max_tokens: 1024, temperature: 0.3 },
          'openai',
          signal,
        );

    try {
      const cleaned = raw.replace(/```json/g, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(cleaned) as { summary?: string; actionItems?: unknown };
      return {
        summary: parsed.summary || raw,
        actionItems: Array.isArray(parsed.actionItems)
          ? parsed.actionItems.filter((s): s is string => typeof s === 'string')
          : [],
      };
    } catch {
      return { summary: raw, actionItems: [] };
    }
  }

  /**
   * Relays the summary to a Slack Incoming Webhook via the proxy Worker.
   * A direct browser -> hooks.slack.com call is blocked by CORS (Slack's
   * webhook endpoint sends no CORS headers), so this always requires a proxy.
   */
  public async sendSlackNotification(
    webhookUrl: string,
    text: string,
    proxyUrl: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const proxy = normalizeProxyUrl(proxyUrl);
    if (!proxy) {
      throw new Error('Slack 전송은 번역 프록시(Worker) 설정이 필요합니다 (브라우저에서 Slack 웹훅을 직접 호출하면 CORS로 차단됩니다).');
    }

    const response = await fetch(`${proxy}/notify/slack`, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ webhookUrl, text }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(describeApiError('Slack', response.status, detail));
    }
  }

  /**
   * Format recent 2-3 conversation turns for context injection
   */
  private formatHistoryPrompt(history?: ConversationContext[]): string {
    if (!history || history.length === 0) return '';
    const recent = history.slice(0, 3).reverse();
    const lines = recent.map((h, i) => `대화 ${i + 1}) 원문: "${h.sourceText}" ➔ 번역: "${h.translatedText}"`).join('\n');
    return `\n[직전 대화 맥락 (이전 턴 히스토리)]:\n${lines}\n※ 위 직전 대화 맥락을 바탕으로, 현재 문장에서 생략된 주어(I, You, We, It 등)와 시제, 대화 상대와의 관계를 정확히 추론하여 자연스럽게 번역에 반영하세요.\n`;
  }

  /**
   * Comprehensive Korean-English Pragmatics, Honorifics & Nuance Engine Guidelines
   */
  private getPragmaticsGuidance(sourceLang: string, targetLang: string): string {
    const isKoreanSource = sourceLang.toLowerCase().startsWith('ko');
    const isKoreanTarget = targetLang.toLowerCase().startsWith('ko');

    if (isKoreanSource) {
      return `
[한국어 ➔ 영어 화용론(Pragmatics) 및 뉘앙스 정밀 복원 지침]:
1. [생략된 주어/목적어 적극 복원]:
   - 한국어는 주어와 목적어가 자주 생략됩니다. 문맥상 화자(I), 청자(You), 우리(We), 상황(It/There) 중 가장 자연스러운 주어를 반드시 채워 넣어 온전한 영어 문장으로 완성하세요.
   - 예: "밥 먹었어?" ➔ "Have you eaten yet?" (Not "Did I eat?")
   - 예: "도착했어" ➔ "I've arrived." / "I'm here."

2. [한국어 종결 어미 및 감정 뉘앙스 매핑]:
   - "~잖아(요)": 상대방도 이미 아는 사실 상기 ➔ "You know (that)...", "As you know...", "Remember..."
   - "~더라고(요) / ~던데요": 직접 경험하거나 관찰한 사실 전달 ➔ "I noticed that...", "It turned out that...", "I found that..."
   - "~거든(요)": 이유 및 배경 설명 ➔ "Because...", "The thing is...", "You see..."
   - "~을/ㄹ 텐데": 걱정, 조심스러운 우려, 추측 ➔ "I'm worried that...", "It should be...", "I wonder if..."
   - "~인 것 같아(요) / ~나 봐(요)": 완곡하고 부드러운 의견 표명 ➔ "I feel like...", "It seems that...", "I guess..."
   - "~해 버렸어 / ~했지 뭐야": 예상치 못한 완료나 가벼운 후회/놀람 ➔ "ended up -ing", "accidentally..."
   - "~지 그래(요) / ~지 그랬어": 부드러운 권유 또는 가벼운 아쉬움 ➔ "Why don't you...", "You should have..."
   - "~을래(요) / ~ㄹ래(요)": 제안이나 가벼운 의사 ➔ "Do you want to...", "How about we...", "I think I'll..."
   - "~을까(요) / ~ㄹ까(요)": 의견 묻기 및 부드러운 의문 ➔ "Shall we...", "What if we...", "Do you think..."
   - "~을게(요) / ~ㄹ게(요)": 다짐 및 능동적 약속 ➔ "I'll make sure to...", "Let me...", "I'll..."
   - "~는 편이야": 습관 및 경향 ➔ "I tend to...", "I usually..."
   - "~는 바람에": 뜻밖의 원인으로 인한 지연/문제 ➔ "Because of...", "held me up", "due to..."

3. [문화적 관용구 현지화]:
   - "수고하셨습니다 / 고생 많으셨어요" ➔ "Great job today!" / "Thank you for your hard work."
   - "눈치 보다" ➔ "walk on eggshells / read the room"
   - "손이 크다" ➔ "generous with portions / generous"
   - "부담 갖지 마세요" ➔ "No pressure at all / Don't feel obligated"
   - "마음이 쓰여요" ➔ "It weighs on my mind / It's on my mind"
   - "어쩔 수 없지" ➔ "It is what it is / There's nothing we can do"
   - "내가 쏠게 / 한턱 낼게" ➔ "It's on me / My treat"
   - "잘 부탁드립니다" ➔ "Looking forward to working with you."

4. [자연스러운 구어체 연어(Collocation)]: 직역을 피하고, 원어민이 실제 해당 상황에서 쓰는 생생하고 세련된 표현을 구사하세요.
`;
    } else if (isKoreanTarget) {
      return `
[외국어 ➔ 한국어 번역 정밀 뉘앙스 지침]:
1. [불필요한 인칭대명사 남발 금지]: 'he, she, it, they' 등을 기계적으로 '그, 그녀, 그것'으로 직역하지 말고, 주어를 자연스럽게 생략하거나 문맥에 맞는 호칭으로 처리하세요.
2. [피동문 ➔ 능동문 전환]: 수동태 표현을 자연스러운 한국어 능동태나 일상 구어체로 다듬으세요.
3. [관용구 및 구동사 자연스러운 번역]: 원문 관용구를 직역하지 말고, 의미가 대응하는 한국어 표현으로 옮기세요.
   - (영어 예시) "touch base" ➔ "간단히 상황 공유하다 / 연락하다"
   - (영어 예시) "bite the bullet" ➔ "이를 악물고 결단을 내리다"
`;
    } else {
      // Neither side is Korean (e.g. English↔Vietnamese, Thai↔Hindi) — the two
      // branches above are Korean-specific and would inject the wrong-language
      // guidance here, so this stays deliberately generic.
      return `
[번역 정밀 뉘앙스 지침]:
1. 원문을 기계적으로 직역하지 말고, 도착어 원어민이 실제로 쓰는 자연스러운 표현과 어순으로 옮기세요.
2. 관용구·숙어는 형태가 아니라 의미가 대응하는 도착어 표현으로 현지화하세요.
3. 생략된 주어/목적어는 문맥상 가장 자연스러운 것으로 복원하고, 수동태는 도착어의 자연스러운 태(능동/수동)로 조정하세요.
`;
    }
  }

  /**
   * Gemini 2.0 / 1.5 Flash Streaming Translation with Contextual Nuance Engine
   */
  private async translateWithGemini(
    text: string,
    req: TranslateRequest,
    modeGuidance: string,
    glossaryPrompt: string,
    historyPrompt: string,
    startTime: number
  ): Promise<TranslateResult> {
    const modelName = req.settings.engine;
    const proxy = normalizeProxyUrl(req.settings.proxyUrl);

    /*
     * Direct calls put the API key in the URL query string, where it lands in
     * browser history, extensions and any intermediate log. Through the proxy the
     * key never leaves the server.
     */
    const endpoint = proxy
      ? `${proxy}/gemini/${modelName}`
      : `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:streamGenerateContent?alt=sse`;

    const isTutorMode = req.mode === 'tutor';
    const pragmaticsGuidance = this.getPragmaticsGuidance(req.sourceLang, req.targetLang);

    const systemInstruction = `당신은 세계 최고 수준의 실시간 동시통역 엔진 및 AI 영어 학습 튜터입니다.
출발어: ${req.sourceLang} ➔ 도착어: ${req.targetLang}

${pragmaticsGuidance}

[번역 스타일 지침 - ${req.mode.toUpperCase()} 모드]
${modeGuidance}
${glossaryPrompt}
${historyPrompt}

${isTutorMode ? `
[출력 형식 - JSON]:
반드시 아래 JSON 형식으로만 응답하세요:
{
  "translation": "가장 자연스럽고 세련된 번역 문장",
  "learning": {
    "naturalAlternative": "원어민이 구어체/실제 상황에서 더 자주 쓰는 대체 표현",
    "grammarTip": "해당 문장의 핵심 문법 및 뉘앙스 차이점 설명 (1~2줄)",
    "shadowingTip": "원어민처럼 억양/연음을 살려 말하는 팁",
    "difficultyLevel": "Intermediate",
    "keyVocabulary": [
      { "word": "단어 또는 숙어", "meaning": "한국어 뜻", "ipa": "/발음기호/", "pos": "v./n./adj." }
    ]
  }
}
` : `
[출력 규칙]:
- 어떠한 부연 설명이나 따옴표, 마크다운 없이 오직 [완성된 번역 문장]만 실시간으로 즉시 출력하세요.
- 말버릇이나 비문은 정제하여 유려하게 완성하세요.
`}`;

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        signal: req.signal,
        headers: proxy
          ? { 'Content-Type': 'application/json' }
          : { 'Content-Type': 'application/json', 'x-goog-api-key': req.settings.geminiApiKey },
        body: JSON.stringify({
          contents: [{ parts: [{ text: text }] }],
          systemInstruction: { parts: [{ text: systemInstruction }] },
          generationConfig: {
            temperature: req.mode === 'literature' ? 0.65 : 0.2,
            maxOutputTokens: 1024,
          },
        }),
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(describeApiError('Gemini', response.status, detail));
      }

      let fullAccumulated = '';
      let translationResult = '';
      let ttftMs: number | undefined;

      if (response.body) {
        // ★ FIX (P0-2): buffered SSE reader — a `data:` line split across two
        // network chunks used to be dropped, losing tokens mid-translation.
        await readSseStream(response.body, (payload) => {
          let textChunk = '';
          try {
            const data = JSON.parse(payload);
            textChunk = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
          } catch (parseErr) {
            console.warn('Gemini SSE payload parse failed:', parseErr);
            return;
          }
          if (!textChunk) return;

          ttftMs ??= Math.round(performance.now() - startTime);
          fullAccumulated += textChunk;
          if (!isTutorMode) {
            translationResult = fullAccumulated;
            req.onChunk?.(textChunk, translationResult);
          }
        }, req.signal);
      }

      const latencyMs = Math.round(performance.now() - startTime);

      if (isTutorMode) {
        try {
          const cleanedJson = fullAccumulated.replace(/```json/g, '').replace(/```/g, '').trim();
          const parsed = JSON.parse(cleanedJson);
          translationResult = parsed.translation || fullAccumulated;
          if (req.onChunk) req.onChunk(translationResult, translationResult);
          return {
            translatedText: translationResult,
            cleanedSourceText: text,
            learningDetails: parsed.learning,
            latencyMs,
            ttftMs,
            engineUsed: req.settings.engine,
          };
        } catch {
          return {
            translatedText: fullAccumulated,
            cleanedSourceText: text,
            latencyMs,
            ttftMs,
            engineUsed: req.settings.engine,
          };
        }
      }

      return {
        translatedText: translationResult.trim(),
        cleanedSourceText: text,
        latencyMs,
        ttftMs,
        engineUsed: req.settings.engine,
      };
    } catch (err) {
      if (isAbortError(err)) throw err;
      console.warn('Gemini request failed, using the built-in engine:', err);
      return this.translateWithSmartFallback(text, req, startTime, errorMessage(err));
    }
  }

  /**
   * OpenAI GPT-4o-mini Streaming Translation with Pragmatics
   */
  private async translateWithOpenAI(
    text: string,
    req: TranslateRequest,
    modeGuidance: string,
    glossaryPrompt: string,
    historyPrompt: string,
    startTime: number
  ): Promise<TranslateResult> {
    const proxy = normalizeProxyUrl(req.settings.proxyUrl);
    const endpoint = proxy
      ? `${proxy}/openai/chat/completions`
      : 'https://api.openai.com/v1/chat/completions';
    const isTutorMode = req.mode === 'tutor';
    const pragmaticsGuidance = this.getPragmaticsGuidance(req.sourceLang, req.targetLang);

    const systemPrompt = `You are a world-class simultaneous interpreter and English tutor.
Translate from ${req.sourceLang} to ${req.targetLang}.
${pragmaticsGuidance}
Mode: ${modeGuidance}
${glossaryPrompt}
${historyPrompt}
${isTutorMode ? 'Respond in JSON with translation, learning details (naturalAlternative, grammarTip, shadowingTip, keyVocabulary).' : 'Output ONLY the translation.'}`;

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        signal: req.signal,
        headers: proxy
          ? { 'Content-Type': 'application/json' }
          : {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${req.settings.openaiApiKey}`,
            },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: text },
          ],
          stream: true,
          temperature: 0.25,
        }),
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(describeApiError('OpenAI', response.status, detail));
      }

      let fullAccumulated = '';
      let ttftMs: number | undefined;

      if (response.body) {
        // ★ FIX (P0-2): buffered SSE reader (see Gemini path above).
        await readSseStream(response.body, (payload) => {
          let content = '';
          try {
            const data = JSON.parse(payload);
            content = data.choices?.[0]?.delta?.content || '';
          } catch (parseErr) {
            console.warn('OpenAI SSE payload parse failed:', parseErr);
            return;
          }
          if (!content) return;

          ttftMs ??= Math.round(performance.now() - startTime);
          fullAccumulated += content;
          if (!isTutorMode) {
            req.onChunk?.(content, fullAccumulated);
          }
        }, req.signal);
      }

      const latencyMs = Math.round(performance.now() - startTime);

      if (isTutorMode) {
        try {
          const parsed = JSON.parse(fullAccumulated.replace(/```json/g, '').replace(/```/g, '').trim());
          if (req.onChunk) req.onChunk(parsed.translation, parsed.translation);
          return {
            translatedText: parsed.translation,
            cleanedSourceText: text,
            learningDetails: parsed.learning,
            latencyMs,
            ttftMs,
            engineUsed: req.settings.engine,
          };
        } catch {
          return {
            translatedText: fullAccumulated, cleanedSourceText: text, latencyMs, ttftMs,
            engineUsed: req.settings.engine,
          };
        }
      }

      return {
        translatedText: fullAccumulated.trim(),
        cleanedSourceText: text,
        latencyMs,
        ttftMs,
        engineUsed: req.settings.engine,
      };
    } catch (err) {
      if (isAbortError(err)) throw err;
      console.warn('OpenAI request failed, using the built-in engine:', err);
      return this.translateWithSmartFallback(text, req, startTime, errorMessage(err));
    }
  }

  /**
   * Smart Built-in Fallback with Nuance, Idiom Mapping & Subject Heuristics
   */
  private async translateWithSmartFallback(
    text: string,
    req: TranslateRequest,
    startTime: number,
    fallbackReason?: string
  ): Promise<TranslateResult> {
    const sl = req.sourceLang.split('-')[0] || 'auto';
    const tl = req.targetLang.split('-')[0] || 'en';

    // 1. Culturally-specific phrases that machine translation reliably mangles.
    const matchedIdiom = this.findMatchingIdiom(text);
    let rawTranslation = '';

    if (matchedIdiom) {
      rawTranslation = matchedIdiom;
    } else {
      rawTranslation = await this.fetchPublicTranslate(text, sl, tl, req.signal);
    }

    if (!rawTranslation) {
      rawTranslation = text;
    }

    /*
     * NOTE: there is deliberately no style/nuance post-processing here.
     *
     * This path used to run regex "polish" over the machine translation, which
     * corrupted output more often than it helped:
     *   - academic mode rewrote every `good` to `favorable`, turning
     *     "Good morning" into "favorable morning";
     *   - the `~잖아` rule matched an optional group, so it prefixed
     *     "You know," to literally every sentence.
     * Style belongs to the AI engines, whose prompts already carry the mode
     * guidance. The built-in engine translates; it does not pretend to style.
     */
    const styledTranslation = applyGlossaryToText(rawTranslation, req.glossary);

    // 2. Fast typing simulation
    const ttftMs = Math.round(performance.now() - startTime);
    if (req.onChunk) {
      await this.simulateTypingStream(styledTranslation, req.onChunk, req.signal);
    }

    const latencyMs = Math.round(performance.now() - startTime);

    return {
      translatedText: styledTranslation,
      cleanedSourceText: text,
      // No `learningDetails`: the built-in engine cannot analyse vocabulary.
      // It used to emit every 4+ letter word with a fabricated IPA (the word
      // itself in slashes) and the placeholder gloss "주요 핵심 어휘 및 표현",
      // which presented invented data to a learner as analysis.
      learningDetails: this.buildIdiomNote(text),
      latencyMs,
      ttftMs,
      engineUsed: 'builtin',
      fallbackReason,
    };
  }

  /**
   * The public (unofficial, undocumented) Google Translate endpoint the
   * built-in fallback relies on throttles and occasionally drops requests
   * outright — the previous single-attempt call meant the very next sentence
   * after a successful one would often come back empty and silently echo the
   * original text. A couple of short, backed-off retries fix most of that
   * without adding noticeable delay to the common case (the first attempt has
   * no delay at all).
   */
  private async fetchPublicTranslate(text: string, sl: string, tl: string, signal?: AbortSignal): Promise<string> {
    const RETRY_DELAYS_MS = [0, 350, 900];

    for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
      if (RETRY_DELAYS_MS[attempt] > 0) {
        await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[attempt]));
      }
      try {
        const res = await fetch(
          `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=${tl}&dt=t&q=${encodeURIComponent(text)}`,
          { signal }
        );
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data) && Array.isArray(data[0]) && data[0].length > 0) {
            const joined = data[0].map((item: unknown[]) => (Array.isArray(item) ? item[0] : '')).join('');
            if (joined.trim()) return joined;
          }
        }
      } catch (e) {
        if (isAbortError(e)) throw e;
        console.warn(`Public translate fetch failed (attempt ${attempt + 1}/${RETRY_DELAYS_MS.length}):`, e);
      }
    }

    return '';
  }

  /**
   * The one genuinely-derived learning note the built-in engine can offer: the
   * cultural idiom entry that matched, if any. Everything else requires an LLM.
   */
  private buildIdiomNote(sourceText: string): LearningDetail | undefined {
    const trimmed = sourceText.trim();
    const entry = KOREAN_IDIOM_MAP.find(e => e.pattern.test(trimmed));
    if (!entry) return undefined;

    return {
      keyVocabulary: [],
      naturalAlternative: entry.replacement,
      grammarTip: `${entry.hint} — 이 표현은 직역이 어려워 영어권에서 쓰는 대응 표현으로 옮겼습니다.`,
    };
  }

  /**
   * Check Korean idiom dictionary
   */
  private findMatchingIdiom(koreanText: string): string | null {
    const trimmed = koreanText.trim();
    for (const entry of KOREAN_IDIOM_MAP) {
      if (entry.pattern.test(trimmed)) {
        return entry.replacement.split(' / ')[0];
      }
    }
    return null;
  }

  /**
   * Fast typing stream simulation for smooth visual rendering
   */
  private async simulateTypingStream(
    fullText: string,
    onChunk: (chunk: string, accumulated: string) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const words = fullText.split(' ');
    let current = '';

    for (let i = 0; i < words.length; i++) {
      // Stop painting a superseded translation the moment a newer one starts.
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

      const word = words[i] + (i === words.length - 1 ? '' : ' ');
      current += word;
      onChunk(word, current);
      await new Promise(r => setTimeout(r, 16)); // ultra snappy 16ms word stream
    }
  }
}

export const translationService = new TranslationService();
