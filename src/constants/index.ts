import type { AppSettings, GlossaryItem, LanguageOption, ModeConfig } from '../types';

export const SUPPORTED_LANGUAGES: LanguageOption[] = [
  { code: 'ko', name: '한국어 (Korean)', flag: '🇰🇷', speechCode: 'ko-KR' },
  { code: 'en', name: 'English (US)', flag: '🇺🇸', speechCode: 'en-US' },
  { code: 'ja', name: '日本語 (Japanese)', flag: '🇯🇵', speechCode: 'ja-JP' },
  { code: 'zh', name: '中文 (Chinese)', flag: '🇨🇳', speechCode: 'zh-CN' },
  { code: 'es', name: 'Español (Spanish)', flag: '🇪🇸', speechCode: 'es-ES' },
  { code: 'fr', name: 'Français (French)', flag: '🇫🇷', speechCode: 'fr-FR' },
  { code: 'de', name: 'Deutsch (German)', flag: '🇩🇪', speechCode: 'de-DE' },
  { code: 'vi', name: 'Việt (Vietnamese)', flag: '🇻🇳', speechCode: 'vi-VN' },
  { code: 'th', name: 'ภาษาไทย (Thai)', flag: '🇹🇭', speechCode: 'th-TH' },
  { code: 'hi', name: 'हिन्दी (Hindi)', flag: '🇮🇳', speechCode: 'hi-IN' },
];

export const TRANSLATION_MODES: ModeConfig[] = [
  {
    id: 'daily',
    name: '일상생활',
    icon: '☕',
    description: '생생한 구어체, 현지 원어민 일상 슬랭 및 자연스러운 대화 뉘앙스',
    badgeColor: 'bg-emerald-50 text-emerald-700 border-emerald-300',
    promptGuidance: `일상생활 대화 모드(Casual & Conversational):
- 원어민들이 실제로 친구나 가족과 대화할 때 쓰는 매우 자연스러운 구어체와 표현을 사용하세요.
- 지나치게 딱딱한 직역을 피하고, 상황에 맞는 자연스러운 관용구(Idioms)와 슬랭을 살려 번역하세요.
- 불필요한 군더더기 말버릇(음, 어, 그 등)은 깔끔하게 정제하세요.`,
    exampleSentence: 'I gotta run now, catch you later! (나 지금 가봐야 해, 나중에 또 봐!)',
  },
  {
    id: 'literature',
    name: '문학 & 소설',
    icon: '📖',
    description: '서정적 표현, 은유와 감정선이 살아있는 유려하고 아름다운 문체',
    badgeColor: 'bg-purple-50 text-purple-700 border-purple-300',
    promptGuidance: `문학 및 소설 모드(Literature & Creative Writing):
- 은유, 서정성, 감정의 깊이가 풍부하게 묻어나는 유려한 문학적 문체를 사용하세요.
- 시적 운율과 문장 간의 호흡, 감각적인 형용사와 묘사를 살려 번역하세요.
- 원문의 정서적 여운이 한국어/영어로 온전히 전해지도록 다듬으세요.`,
    exampleSentence: 'The twilight gently enveloped the tranquil lake. (황혼이 잔잔한 호수를 부드럽게 감싸 안았다.)',
  },
  {
    id: 'academic',
    name: '논문 & 학술',
    icon: '🎓',
    description: '학술 전문 용어, 객관적 서술, 명확한 논리 구조 및 논문 규격 문체',
    badgeColor: 'bg-blue-50 text-blue-700 border-blue-300',
    promptGuidance: `학술 및 논문 모드(Academic & Research Paper):
- 학술 논문 및 연구 보고서에 적합한 엄격하고 객관적인 문체를 사용하세요.
- 정확한 학술 전문 용어(Terminology), 피동/능동의 엄밀한 구분, 논리적 접속사를 사용하세요.
- 감정적이거나 모호한 표현을 배제하고 학술적 명확성을 극대화하세요.`,
    exampleSentence: 'The empirical data indicates a statistically significant correlation. (실증 데이터는 통계적으로 유의미한 상관관계를 나타낸다.)',
  },
  {
    id: 'journalism',
    name: '기자 & 뉴스',
    icon: '📰',
    description: '군더더기 없는 두괄식 보도체, 사실 중심의 명료하고 신뢰감 있는 톤',
    badgeColor: 'bg-amber-50 text-amber-700 border-amber-300',
    promptGuidance: `기자 및 뉴스 보도 모드(Journalism & Broadcasting):
- 방송 뉴스나 신문 기사처럼 간결하고 명확한 두괄식 보도 문체를 사용하세요.
- 6하원칙에 입각한 사실 전달과 객관적인 브로드캐스팅 톤을 유지하세요.
- 군더더기 수식어를 절제하고 신뢰성 높은 어조를 구사하세요.`,
    exampleSentence: 'The central bank announced a surprise interest rate adjustment today. (중앙은행이 오늘 기습적인 금리 조정을 발표했습니다.)',
  },
  {
    id: 'business',
    name: '비즈니스',
    icon: '💼',
    description: '격식 있는 비즈니스 미팅, 이메일 및 공식 프레젠테이션용 정중한 어조',
    badgeColor: 'bg-sky-50 text-sky-700 border-sky-300',
    promptGuidance: `비즈니스 및 격식 모드(Business & Corporate):
- 공식 회의, 이메일, 파트너십 제안서에 어울리는 정중하고 프로페셔널한 비즈니스 영어를 사용하세요.
- 정중한 요청(Would you kindly, We appreciate your prompt feedback 등)과 신뢰감 있는 어휘를 배치하세요.`,
    exampleSentence: 'We appreciate your prompt feedback on the revised proposal. (수정된 제안서에 대한 신속한 피드백에 감사드립니다.)',
  },
  {
    id: 'tutor',
    name: '영어 튜터 (학습)',
    icon: '💡',
    description: '번역 + 원어민 대체 표현 + 핵심 단어/숙어 주석 + 문법 포인트 분석',
    badgeColor: 'bg-pink-50 text-pink-700 border-pink-300',
    promptGuidance: `영어 학습 튜터 모드(English Learning & AI Tutor):
- 가장 자연스러운 번역과 함께, 영어 학습자에게 유용한 [원어민 대체 표현], [핵심 단어/숙어 목록], [문법/뉘앙스 팁]을 분석하여 제공하세요.
- 한국인이 자주 실수하는 콩글리시 교정 포인트를 명쾌하게 짚어주세요.`,
    exampleSentence: 'How about we touch base tomorrow morning? (내일 아침에 간단히 진행 상황 공유할까요?)',
  },
];

/** Selectable translation engines, in the order the settings screen shows them. */
export const ENGINE_OPTIONS: Array<{
  id: AppSettings['engine'];
  name: string;
  badge: string;
  badgeTone: 'emerald' | 'indigo' | 'amber';
  description: string;
}> = [
  {
    id: 'gemini-2.5-flash',
    name: 'Gemini 2.5 Flash',
    badge: '추천',
    badgeTone: 'emerald',
    description: '문맥·뉘앙스 품질이 가장 좋습니다. 무료 API 키 필요.',
  },
  {
    id: 'gemini-2.5-flash-lite',
    name: 'Gemini 2.5 Flash-Lite',
    badge: '가장 빠름',
    badgeTone: 'indigo',
    description: '지연이 더 짧고 저렴합니다. 긴 발표·회의에 유리합니다.',
  },
  {
    id: 'gpt-4o-mini',
    name: 'GPT-4o mini',
    badge: 'OpenAI',
    badgeTone: 'indigo',
    description: 'OpenAI API 키를 이미 쓰고 계신 경우.',
  },
  {
    id: 'smart-local',
    name: '내장 엔진',
    badge: '키 불필요',
    badgeTone: 'amber',
    description: '키 없이 바로 쓸 수 있지만 품질·속도가 보장되지 않습니다.',
  },
];

export const DEFAULT_GLOSSARY_ITEMS: GlossaryItem[] = [
  { id: '2', sourceTerm: 'LLM', targetTerm: '거대언어모델 (LLM)', category: 'IT/AI', description: 'Large Language Model' },
  { id: '3', sourceTerm: 'STT', targetTerm: '음성인식 (Speech-to-Text)', category: '기술', description: '음성을 텍스트로 변환' },
  { id: '4', sourceTerm: 'Disfluency', targetTerm: '말버릇/비문 정제', category: '언어학', description: '군더더기 필러 워드' },
  { id: '5', sourceTerm: 'Touch base', targetTerm: '간단히 연락/상황 공유하다', category: '비즈니스 관용구', description: 'Business Idiom' },
  { id: '6', sourceTerm: 'Bite the bullet', targetTerm: '이를 악물고 견디다/결단을 내리다', category: '영어 이디엄', description: 'Idiom' },
  { id: '7', sourceTerm: 'Read the room', targetTerm: '분위기/눈치를 파악하다', category: '일상 관용구', description: '눈치 빠르게 행동하다' },
];

/**
 * Baked in at build time from VITE_PROXY_URL. With it set, a visitor gets a real
 * AI engine without entering anything.
 */
export const BUILTIN_PROXY_URL = (import.meta.env.VITE_PROXY_URL ?? '').replace(/\/+$/, '');

export const DEFAULT_SETTINGS: AppSettings = {
  proxyUrl: BUILTIN_PROXY_URL,
  geminiApiKey: '',
  openaiApiKey: '',
  engine: 'gemini-2.5-flash',
  autoTts: true,
  ttsSpeed: 1.0,
  disfluencyFilter: true,
  speculativeTranslation: true,
  fontSize: 'base',
  bilingualDisplay: true,
  darkStage: false,
  autoDetectLanguage: true,
  autoEngineSwitch: true,
  sttFallbackEnabled: true,
  ttsProvider: 'browser',
  slackWebhookUrl: '',
};
