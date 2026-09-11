export type TranslationMode = 
  | 'daily'        // 일상생활 (구어체/현지 표현)
  | 'literature'   // 문학 (은유/서정적/소설)
  | 'academic'     // 논문/학술 (격식/객관/전문용어)
  | 'journalism'   // 기자/뉴스 (보도/간결/두괄식)
  | 'business'     // 비즈니스 (공손/격식/미팅)
  | 'tutor';       // 영어 학습 튜터 (문법/뉘앙스/학습포인트)

export interface KeyVocabulary {
  word: string;
  meaning: string;
  ipa?: string;
  pos?: string; // part of speech
  example?: string;
}

export interface LearningDetail {
  keyVocabulary: KeyVocabulary[];
  naturalAlternative?: string;
  grammarTip?: string;
  shadowingTip?: string;
  difficultyLevel?: 'Beginner' | 'Intermediate' | 'Advanced';
}

export interface TranslationItem {
  id: string;
  timestamp: number;
  sourceText: string;
  cleanedSourceText: string;
  translatedText: string;
  mode: TranslationMode;
  sourceLang: string;
  targetLang: string;
  learningDetails?: LearningDetail;
  isBookmarked?: boolean;
  isStreaming?: boolean;
  /** Total time until the translation finished streaming. */
  latencyMs?: number;
  /** Time to first token — what the viewer actually perceives as the delay. */
  ttftMs?: number;
  /** Which engine actually produced this translation. */
  engineUsed?: AppSettings['engine'] | 'builtin';
}

export interface GlossaryItem {
  id: string;
  sourceTerm: string;
  targetTerm: string;
  category?: string;
  description?: string;
}

export interface LanguageOption {
  code: string;
  name: string;
  flag: string;
  speechCode: string;
}

export interface AppSettings {
  /**
   * Base URL of a translation proxy that holds the API keys server-side.
   * When set, no API key is sent from (or stored in) the browser.
   */
  proxyUrl: string;
  geminiApiKey: string;
  openaiApiKey: string;
  engine: 'gemini-2.5-flash' | 'gemini-2.5-flash-lite' | 'gemini-2.0-flash' | 'gpt-4o-mini' | 'smart-local';
  autoTts: boolean;
  ttsSpeed: number; // 0.75, 1.0, 1.25, 1.5
  disfluencyFilter: boolean; // 말버릇 정제 on/off
  /** Translate the interim transcript before the utterance ends. */
  speculativeTranslation: boolean;
  fontSize: 'sm' | 'base' | 'lg' | 'xl';
  bilingualDisplay: boolean;
  /**
   * Dark stage for the conversation view. Replaces the old
   * `highContrastSubtitles`, which only themed one panel of the previous
   * two-column layout; the new key means existing saved values (defaulted to
   * true) do not silently turn the whole app dark.
   */
  darkStage: boolean;
  /** Auto-flip source/target direction when the detected speech language doesn't match. Requires an AI engine. */
  autoDetectLanguage: boolean;
  /** Fall back gemini-2.5-flash -> gemini-2.5-flash-lite (and back) when latency degrades. */
  autoEngineSwitch: boolean;
  /** Switch to the Whisper proxy path when Web Speech is unsupported or failing repeatedly. */
  sttFallbackEnabled: boolean;
  /** Which engine renders the auto-played translation audio. */
  ttsProvider: 'browser' | 'openai';
  /** Slack Incoming Webhook URL for posting the meeting summary. Stored locally only. */
  slackWebhookUrl: string;
}

export interface MeetingSummary {
  summary: string;
  actionItems: string[];
}

export interface ModeConfig {
  id: TranslationMode;
  name: string;
  icon: string;
  description: string;
  badgeColor: string;
  promptGuidance: string;
  exampleSentence: string;
}
