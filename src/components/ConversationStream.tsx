import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Mic, MicOff, Copy, Check, Volume2, BookMarked, GraduationCap,
  Trash2, Sparkles, ChevronDown, ChevronUp, BookOpen, ArrowRightLeft,
  Maximize2, Minimize2, Eraser, Flame,
} from 'lucide-react';
import type { AppSettings, KeyVocabulary, LanguageOption, TranslationItem, TranslationMode } from '../types';
import { SUPPORTED_LANGUAGES, TRANSLATION_MODES } from '../constants';
import { ttsService } from '../services/tts';
import { LiveWaveVisualizer } from './LiveWaveVisualizer';

interface ConversationStreamProps {
  /** Newest first, as stored. Rendered oldest-first so the newest sits at the bottom. */
  items: TranslationItem[];
  isListening: boolean;
  onToggleListening: () => void;
  audioLevel: number;
  audioFrequencies: number[];
  currentInterimSource: string;
  currentStreamingTranslation: string;
  provisionalTranslation: string;
  isTranslating: boolean;
  sourceLang: string;
  targetLang: string;
  onSourceLangChange: (code: string) => void;
  onTargetLangChange: (code: string) => void;
  onSwapLanguages: () => void;
  autoDetectLanguage: boolean;
  currentMode: TranslationMode;
  onSelectMode: (mode: TranslationMode) => void;
  fontSize: AppSettings['fontSize'];
  bilingualDisplay: boolean;
  darkStage: boolean;
  onTestSample: (text: string) => void;
  onBookmarkItem: (id: string) => void;
  onDeleteItem: (id: string) => void;
  onClearAll: () => void;
  onOpenShadowing: (item: TranslationItem) => void;
  onSaveVocabulary: (vocab: KeyVocabulary, contextSentence: string) => void;
}

/** Translation is the primary line; the source sits under it, quieter. */
const TRANSLATION_SIZE: Record<AppSettings['fontSize'], string> = {
  sm: 'text-lg sm:text-xl',
  base: 'text-xl sm:text-2xl',
  lg: 'text-2xl sm:text-3xl',
  xl: 'text-3xl sm:text-4xl',
};

const SOURCE_SIZE: Record<AppSettings['fontSize'], string> = {
  sm: 'text-xs sm:text-sm',
  base: 'text-sm sm:text-base',
  lg: 'text-base sm:text-lg',
  xl: 'text-lg sm:text-xl',
};

const SAMPLE_PHRASES = [
  { label: '일상 회화', text: '음... 오늘 날씨 진짜 좋다. 우리 이따가 커피 한잔 하러 갈래?' },
  { label: '비즈니스 미팅', text: '그... 다음 분기 신제품 출시 일정에 대해 간단히 논의하고 싶습니다.' },
  { label: '학술/논문', text: '본 연구에서는 딥러닝 기반의 음성인식 모델이 다국어 번역 정확도에 미치는 영향을 분석하였다.' },
  { label: '뉴스 보도', text: '기상청은 오늘 밤부터 전국에 강한 비바람이 몰아칠 것으로 예보했습니다.' },
  { label: '문학 구절', text: '새벽 안개 너머로 피어오르는 햇살이 고요한 숲속을 은은하게 비추었다.' },
];

export const ConversationStream: React.FC<ConversationStreamProps> = ({
  items, isListening, onToggleListening, audioLevel, audioFrequencies,
  currentInterimSource, currentStreamingTranslation, provisionalTranslation, isTranslating,
  sourceLang, targetLang, onSourceLangChange, onTargetLangChange, onSwapLanguages, autoDetectLanguage,
  currentMode, onSelectMode, fontSize, bilingualDisplay, darkStage,
  onTestSample, onBookmarkItem, onDeleteItem, onClearAll, onOpenShadowing, onSaveVocabulary,
}) => {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [isFullScreen, setIsFullScreen] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  /** Whether the reader is at the bottom. Auto-scroll must not yank them back. */
  const pinnedToBottomRef = useRef(true);

  const dark = darkStage;
  const translationSize = TRANSLATION_SIZE[fontSize] ?? TRANSLATION_SIZE.base;
  const sourceSize = SOURCE_SIZE[fontSize] ?? SOURCE_SIZE.base;

  // Oldest first: the conversation reads downwards and the newest line is nearest
  // the mic button.
  const ordered = [...items].reverse();

  const liveTranslation = provisionalTranslation || currentStreamingTranslation;
  const isProvisional = Boolean(provisionalTranslation);
  const hasLiveLine = Boolean(currentInterimSource || (isTranslating && liveTranslation));

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);

  useEffect(() => {
    if (!pinnedToBottomRef.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items, liveTranslation, currentInterimSource]);

  const handleCopy = (id: string, text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1600);
    }).catch(() => {});
  };

  const activeMode = TRANSLATION_MODES.find(m => m.id === currentMode) ?? TRANSLATION_MODES[0];

  return (
    <div className={`flex flex-col ${
      isFullScreen ? 'fixed inset-0 z-50' : 'flex-1 min-h-0'
    } ${dark ? 'bg-slate-950' : 'bg-white'}`}>

      {/* Stream */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-10 py-5 sm:py-8"
      >
        <div className="max-w-3xl mx-auto space-y-5 sm:space-y-7">

          {ordered.length === 0 && !hasLiveLine && (
            <div className="py-16 text-center">
              <p className={`${dark ? 'text-white/50' : 'text-gray-400'} text-base font-medium`}>
                {isListening
                  ? '말씀하시면 여기에 번역이 이어집니다.'
                  : '아래 마이크 버튼을 누르고 말해 보세요.'}
              </p>
              {!isListening && (
                <div className="mt-6">
                  <div className={`text-[11px] font-medium mb-2 flex items-center justify-center gap-1 ${dark ? 'text-white/30' : 'text-gray-400'}`}>
                    <Flame className="w-3 h-3 text-orange-400" /> 마이크 없이 먼저 시험해 보기
                  </div>
                  <div className="flex flex-wrap gap-1.5 justify-center">
                    {SAMPLE_PHRASES.map((s) => (
                      <button
                        key={s.label}
                        onClick={() => onTestSample(s.text)}
                        className={`text-[11px] px-2.5 py-1 rounded-lg border transition ${
                          dark
                            ? 'bg-white/5 border-white/10 text-white/60 hover:bg-white/10'
                            : 'bg-white border-gray-200 text-gray-600 hover:bg-indigo-50 hover:border-indigo-300 hover:text-indigo-600'
                        }`}
                      >
                        {s.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {ordered.map((item) => {
            const isExpanded = expandedId === item.id;
            return (
              <div key={item.id} className="group relative">
                {/* Translation — the primary line */}
                <p className={`${translationSize} font-bold leading-snug tracking-tight break-words ${
                  dark ? 'text-white' : 'text-gray-900'
                }`}>
                  {item.translatedText}
                </p>

                {/* Source — secondary */}
                {bilingualDisplay && (
                  <p className={`${sourceSize} mt-1 leading-relaxed break-words ${
                    dark ? 'text-white/35' : 'text-gray-400'
                  }`}>
                    {item.cleanedSourceText || item.sourceText}
                  </p>
                )}

                {/* Row actions — revealed on hover, and always on touch devices */}
                <div className="mt-1.5 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity">
                  <IconButton dark={dark} title="번역 복사" onClick={() => handleCopy(item.id, item.translatedText)}>
                    {copiedId === item.id ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                  </IconButton>
                  <IconButton dark={dark} title="원어민 발음 듣기"
                    onClick={() => ttsService.speak(item.translatedText, { lang: item.targetLang })}>
                    <Volume2 className="w-3.5 h-3.5" />
                  </IconButton>
                  <IconButton dark={dark} title="섀도잉 연습" onClick={() => onOpenShadowing(item)}>
                    <GraduationCap className="w-3.5 h-3.5" />
                  </IconButton>
                  <IconButton dark={dark} title="단어장에 저장" onClick={() => onBookmarkItem(item.id)}>
                    <BookMarked className={`w-3.5 h-3.5 ${item.isBookmarked ? 'text-pink-500 fill-pink-500' : ''}`} />
                  </IconButton>
                  {item.learningDetails && (
                    <button
                      onClick={() => setExpandedId(isExpanded ? null : item.id)}
                      className={`ml-1 inline-flex items-center gap-1 px-2.5 py-2.5 sm:py-1 rounded-lg text-[11px] font-semibold transition ${
                        dark ? 'text-indigo-300 hover:bg-white/10' : 'text-indigo-600 hover:bg-indigo-50'
                      }`}
                    >
                      <Sparkles className="w-3 h-3" />
                      학습
                      {isExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                    </button>
                  )}
                  <span className="flex-1 min-w-4" />
                  <IconButton dark={dark} title="이 줄 삭제" onClick={() => onDeleteItem(item.id)}>
                    <Trash2 className="w-3.5 h-3.5" />
                  </IconButton>
                </div>

                {/* Learning drawer */}
                {isExpanded && item.learningDetails && (
                  <div className={`mt-2 p-3.5 rounded-xl border space-y-3 ${
                    dark ? 'bg-white/5 border-white/10' : 'bg-gray-50 border-gray-200'
                  }`}>
                    {item.learningDetails.keyVocabulary?.length > 0 && (
                      <div>
                        <div className={`text-[11px] font-bold uppercase mb-1.5 flex items-center gap-1 ${dark ? 'text-white/50' : 'text-gray-600'}`}>
                          <BookOpen className="w-3 h-3 text-pink-500" />
                          핵심 어휘 (클릭하여 단어장에 추가)
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {item.learningDetails.keyVocabulary.map((v, idx) => (
                            <button
                              key={idx}
                              onClick={() => onSaveVocabulary(v, item.translatedText)}
                              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs transition ${
                                dark
                                  ? 'bg-white/5 border-white/10 text-white/80 hover:border-pink-400/50'
                                  : 'bg-white border-gray-200 text-gray-700 hover:bg-pink-50 hover:border-pink-300'
                              }`}
                            >
                              <span className={`font-bold ${dark ? 'text-indigo-300' : 'text-indigo-600'}`}>{v.word}</span>
                              <span className="text-[11px] opacity-80">{v.meaning}</span>
                              {v.ipa && <span className="text-[10px] opacity-50 font-mono">{v.ipa}</span>}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                    {item.learningDetails.naturalAlternative && (
                      <p className={`text-xs ${dark ? 'text-white/70' : 'text-gray-700'}`}>
                        <span className="font-bold text-emerald-600">💡 대체 표현: </span>
                        {item.learningDetails.naturalAlternative}
                      </p>
                    )}
                    {item.learningDetails.grammarTip && (
                      <p className={`text-xs ${dark ? 'text-white/60' : 'text-gray-600'}`}>
                        <span className={`font-bold ${dark ? 'text-indigo-300' : 'text-indigo-600'}`}>📌 문법/뉘앙스: </span>
                        {item.learningDetails.grammarTip}
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {/* The line currently being spoken */}
          {hasLiveLine && (
            <div className="relative">
              {liveTranslation ? (
                <p className={`${translationSize} font-bold leading-snug tracking-tight break-words transition-colors ${
                  dark ? 'text-white/50' : 'text-gray-400'
                }`}>
                  {liveTranslation}
                  <span className="inline-block w-[3px] h-[1em] ml-1 align-middle bg-indigo-500 cursor-blink rounded-sm" />
                </p>
              ) : (
                <p className={`${translationSize} font-bold leading-snug ${dark ? 'text-white/20' : 'text-gray-300'}`}>
                  <span className="inline-block w-[3px] h-[1em] align-middle bg-indigo-500 cursor-blink rounded-sm" />
                </p>
              )}

              {bilingualDisplay && currentInterimSource && (
                <p className={`${sourceSize} mt-1 leading-relaxed break-words ${dark ? 'text-white/25' : 'text-gray-300'}`}>
                  {currentInterimSource}
                </p>
              )}

              {isProvisional && (
                <p className="mt-1 text-[10px] font-semibold text-amber-500">
                  ● 잠정 번역 — 발화가 끝나면 확정됩니다
                </p>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Controls */}
      <div className={`shrink-0 border-t ${dark ? 'border-white/10' : 'border-gray-200'}`}>
        <div className="max-w-3xl mx-auto px-4 py-3 sm:py-5 flex flex-col items-center gap-2.5 sm:gap-4">

          {/* Mic, flanked by the input spectrum while recording */}
          <div className="flex items-center gap-2 sm:gap-3 h-14 sm:h-16">
            <div className="w-16 sm:w-32 flex justify-end">
              <LiveWaveVisualizer
                isListening={isListening}
                audioLevel={audioLevel}
                audioFrequencies={audioFrequencies}
                dark={dark}
              />
            </div>

          <button
            onClick={onToggleListening}
            aria-label={isListening ? '음성 인식 중지' : '음성 인식 시작'}
            className="relative w-14 h-14 sm:w-16 sm:h-16 rounded-full flex items-center justify-center transition-transform active:scale-95 shrink-0"
          >
            {/* Level ring — reacts to input volume */}
            {isListening && (
              <span
                className="absolute inset-0 rounded-full border-2 border-indigo-400/60 transition-transform duration-75"
                style={{ transform: `scale(${1 + Math.min(audioLevel, 100) / 145})` }}
              />
            )}
            <span className={`absolute inset-0 rounded-full transition-colors ${
              isListening ? 'bg-rose-600' : dark ? 'bg-white' : 'bg-slate-900'
            }`} />
            {isListening
              ? <MicOff className="w-6 h-6 text-white relative z-10" />
              : <Mic className={`w-6 h-6 relative z-10 ${dark ? 'text-slate-900' : 'text-white'}`} />}
          </button>

            <div className="w-16 sm:w-32 flex justify-start">
              <LiveWaveVisualizer
                isListening={isListening}
                audioLevel={audioLevel}
                audioFrequencies={audioFrequencies}
                dark={dark}
              />
            </div>
          </div>

          {/* Languages */}
          <div className="flex items-center gap-2">
            <LangSelect dark={dark} value={sourceLang} onChange={onSourceLangChange} />
            <button
              onClick={onSwapLanguages}
              title={autoDetectLanguage ? '언어 서로 바꾸기 (자동 감지 켜짐)' : '언어 서로 바꾸기'}
              className={`relative p-1.5 rounded-lg transition ${dark ? 'text-white/50 hover:bg-white/10' : 'text-gray-400 hover:bg-gray-100'}`}
            >
              <ArrowRightLeft className="w-3.5 h-3.5" />
              {autoDetectLanguage && (
                <span
                  className={`absolute -top-1 -right-1 text-[7px] font-bold leading-none px-1 py-0.5 rounded-full ${
                    dark ? 'bg-indigo-400 text-slate-900' : 'bg-indigo-500 text-white'
                  }`}
                >
                  자동
                </span>
              )}
            </button>
            <LangSelect dark={dark} value={targetLang} onChange={onTargetLangChange} />
          </div>

          {/* Mode + view controls */}
          <div className="flex items-center gap-1.5 flex-wrap justify-center">
            <select
              value={currentMode}
              onChange={(e) => onSelectMode(e.target.value as TranslationMode)}
              title="번역 모드"
              className={`text-[11px] font-semibold rounded-lg px-2 py-1 outline-none border cursor-pointer transition ${
                dark
                  ? 'bg-white/5 border-white/10 text-white/70'
                  : 'bg-white border-gray-200 text-gray-600 hover:border-gray-300'
              }`}
            >
              {TRANSLATION_MODES.map(m => (
                <option key={m.id} value={m.id}>{m.icon} {m.name}</option>
              ))}
            </select>

            {items.length > 0 && (
              <button
                onClick={onClearAll}
                className={`inline-flex items-center gap-1.5 px-3 py-2 sm:py-1 rounded-lg text-[11px] font-semibold border transition ${
                  dark
                    ? 'border-white/10 text-white/60 hover:bg-rose-500/15 hover:text-rose-300 hover:border-rose-400/30'
                    : 'border-gray-200 text-gray-500 hover:bg-rose-50 hover:text-rose-600 hover:border-rose-200'
                }`}
              >
                <Eraser className="w-3 h-3" />
                대화 비우기
                <span className={dark ? 'text-white/30' : 'text-gray-400'}>({items.length})</span>
              </button>
            )}
            <IconButton dark={dark} title={isFullScreen ? '전체화면 종료' : '대화면 모드'}
              onClick={() => setIsFullScreen(!isFullScreen)}>
              {isFullScreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
            </IconButton>

            <span className={`text-[10px] ml-1 ${dark ? 'text-white/25' : 'text-gray-300'}`}>
              {activeMode.name}
              {items[0]?.ttftMs != null && ` · ${items[0].ttftMs}ms`}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};

/**
 * Touch targets are ~40px on phones and tighten to 26px from `sm` up, where a
 * mouse is precise. The compact desktop size alone put a destructive delete
 * button inside a 26px target on touch, which is well under the ~44px guidance.
 */
const IconButton: React.FC<{
  dark: boolean; title: string; onClick: () => void; children: React.ReactNode;
}> = ({ dark, title, onClick, children }) => (
  <button
    onClick={onClick}
    title={title}
    aria-label={title}
    className={`p-3 sm:p-1.5 rounded-lg transition [&>svg]:w-4 [&>svg]:h-4 sm:[&>svg]:w-3.5 sm:[&>svg]:h-3.5 ${
      dark ? 'text-white/40 hover:text-white active:bg-white/10 hover:bg-white/10' : 'text-gray-400 hover:text-gray-700 active:bg-gray-100 hover:bg-gray-100'
    }`}
  >
    {children}
  </button>
);

const LangSelect: React.FC<{
  dark: boolean; value: string; onChange: (code: string) => void;
}> = ({ dark, value, onChange }) => (
  <select
    value={value}
    onChange={(e) => onChange(e.target.value)}
    className={`text-xs font-semibold rounded-xl px-3 py-1.5 outline-none border cursor-pointer transition ${
      dark
        ? 'bg-white/5 border-white/10 text-white/80'
        : 'bg-white border-gray-200 text-gray-700 hover:border-gray-300'
    }`}
  >
    {SUPPORTED_LANGUAGES.map((l: LanguageOption) => (
      <option key={l.code} value={l.speechCode}>{l.flag} {l.name.split(' ')[0]}</option>
    ))}
  </select>
);
