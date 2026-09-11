import { useState, useEffect, useCallback, useRef } from 'react';
import { AlertTriangle } from 'lucide-react';
import { AudienceView } from './components/AudienceView';
import { Header } from './components/Header';
import { ConversationStream } from './components/ConversationStream';
import { GlossaryModal } from './components/GlossaryModal';
import { FlashcardsModal } from './components/FlashcardsModal';
import type { SavedFlashcard } from './components/FlashcardsModal';
import { ShadowingModal } from './components/ShadowingModal';
import { AudienceRoomModal } from './components/AudienceRoomModal';
import { SettingsModal } from './components/SettingsModal';
import { ExportModal } from './components/ExportModal';

import type { 
  AppSettings, 
  GlossaryItem, 
  KeyVocabulary, 
  TranslationItem, 
  TranslationMode 
} from './types';
import { 
  DEFAULT_GLOSSARY_ITEMS, 
  DEFAULT_SETTINGS,
  ENGINE_OPTIONS,
} from './constants';
import { useTranscription } from './hooks/useTranscription';
import { isAbortError, normalizeProxyUrl, translationService } from './services/translator';
import { shouldSpeculate, speculationDelayMs } from './utils/interimGate';
import { RoomChannel, createRoomId, isValidRoomId, readAudienceRoute } from './services/broadcast';
import type { BroadcastMessage } from './services/broadcast';
import { ttsService } from './services/tts';

/** Floor on how often a speculative call may fire, in ms. */
const MIN_SPECULATION_GAP_MS = 700;

const ROOM_STORAGE_KEY = 'fluentlive_room_id';

/** Minimum gap between mid-stream subtitle pushes to audience windows. */
const SUBTITLE_STREAM_INTERVAL_MS = 150;

/** Engine auto-switch tuning (flash <-> flash-lite only, see `handleTranslateText`). */
const ENGINE_LATENCY_THRESHOLD_MS = 3000;
const ENGINE_SWITCH_COOLDOWN_MS = 20_000;

/**
 * `?view=audience&room=…` opens the read-only subtitle screen instead of the
 * presenter app. Resolved once at module scope: a viewer never switches between
 * the two roles within a single page load.
 */
const audienceRoute = readAudienceRoute();

export function App() {
  if (audienceRoute.isAudience && audienceRoute.roomId) {
    return <AudienceView roomId={audienceRoute.roomId} initialLang={audienceRoute.lang} />;
  }
  return <PresenterApp />;
}

function PresenterApp() {
  // 1. Settings & Persistence State
  const [settings, setSettings] = useState<AppSettings>(() => {
    const saved = localStorage.getItem('fluentlive_settings') || localStorage.getItem('polyvoice_settings');
    if (!saved) return DEFAULT_SETTINGS;
    try {
      // Merge over the defaults: a stored object written by an older build is
      // missing every setting added since, and those would otherwise read as
      // `undefined` (silently disabling the feature) for existing users.
      const merged = { ...DEFAULT_SETTINGS, ...(JSON.parse(saved) as Partial<AppSettings>) };
      // Retired model ids would now 404 on every request.
      if (!ENGINE_OPTIONS.some(o => o.id === merged.engine)) {
        merged.engine = DEFAULT_SETTINGS.engine;
      }
      return merged;
    } catch {
      return DEFAULT_SETTINGS;
    }
  });

  const [glossary, setGlossary] = useState<GlossaryItem[]>(() => {
    const saved = localStorage.getItem('fluentlive_glossary') || localStorage.getItem('polyvoice_glossary');
    return saved ? JSON.parse(saved) : DEFAULT_GLOSSARY_ITEMS;
  });

  const [savedCards, setSavedCards] = useState<SavedFlashcard[]>(() => {
    const saved = localStorage.getItem('fluentlive_flashcards') || localStorage.getItem('polyvoice_flashcards');
    return saved ? JSON.parse(saved) : [];
  });

  const [items, setItems] = useState<TranslationItem[]>(() => {
    const saved = localStorage.getItem('fluentlive_history') || localStorage.getItem('polyvoice_history');
    return saved ? JSON.parse(saved) : [];
  });

  // Languages & Translation Mode
  const [sourceLang, setSourceLang] = useState('ko-KR');
  const [targetLang, setTargetLang] = useState('en-US');
  const [currentMode, setCurrentMode] = useState<TranslationMode>('daily');

  // Real-time Streaming State
  const [currentInterimSource, setCurrentInterimSource] = useState('');
  const [currentStreamingTranslation, setCurrentStreamingTranslation] = useState('');
  const [isTranslating, setIsTranslating] = useState(false);
  const [translationError, setTranslationError] = useState<string | null>(null);
  /** Set when a configured AI engine failed and the built-in one took over. */
  const [engineNotice, setEngineNotice] = useState<string | null>(null);

  // ★ P1: speculative ("provisional") translation of the interim transcript.
  const [provisionalTranslation, setProvisionalTranslation] = useState('');

  // ★ P0-5: cancel + sequence guard. Two utterances spoken back to back used to
  // race on the same streaming state, so a slow earlier response could overwrite
  // a newer translation.
  const abortRef = useRef<AbortController | null>(null);
  const requestSeqRef = useRef(0);

  // Speculative pipeline — deliberately separate from the confirmed one so the
  // two never abort each other by accident. A confirmed request always wins.
  const specAbortRef = useRef<AbortController | null>(null);
  const specSeqRef = useRef(0);
  const specTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSpeculatedRef = useRef('');
  const lastSpeculationAtRef = useRef(0);
  const finalInFlightRef = useRef(false);

  /** Drop any pending or in-flight speculation. */
  const cancelSpeculation = useCallback(() => {
    if (specTimerRef.current) {
      clearTimeout(specTimerRef.current);
      specTimerRef.current = null;
    }
    specSeqRef.current++;
    specAbortRef.current?.abort();
    specAbortRef.current = null;
  }, []);

  // Latest history without making the translate callback depend on `items`.
  const itemsRef = useRef<TranslationItem[]>(items);

  // Latency-based engine auto-switch (flash <-> flash-lite only). Hysteresis +
  // cooldown avoid flapping back and forth on borderline latency.
  const engineSwitchRef = useRef({ slowStreak: 0, fastStreak: 0, lastSwitchAt: 0 });

  // Audience broadcast room. Persisted so a reload does not orphan open
  // audience windows that are already listening on the old id.
  const [roomId, setRoomId] = useState<string>(() => {
    const saved = localStorage.getItem(ROOM_STORAGE_KEY);
    if (isValidRoomId(saved)) return saved;
    const fresh = createRoomId();
    localStorage.setItem(ROOM_STORAGE_KEY, fresh);
    return fresh;
  });
  const roomChannelRef = useRef<RoomChannel | null>(null);
  const lastPublishAtRef = useRef(0);

  // Modals
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isGlossaryOpen, setIsGlossaryOpen] = useState(false);
  const [isFlashcardsOpen, setIsFlashcardsOpen] = useState(false);
  const [isAudienceRoomOpen, setIsAudienceRoomOpen] = useState(false);
  const [isExportOpen, setIsExportOpen] = useState(false);
  const [activeShadowingItem, setActiveShadowingItem] = useState<TranslationItem | null>(null);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  // Save to LocalStorage
  useEffect(() => {
    localStorage.setItem('fluentlive_settings', JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    localStorage.setItem('fluentlive_glossary', JSON.stringify(glossary));
  }, [glossary]);

  useEffect(() => {
    localStorage.setItem('fluentlive_flashcards', JSON.stringify(savedCards));
  }, [savedCards]);

  useEffect(() => {
    localStorage.setItem('fluentlive_history', JSON.stringify(items));
  }, [items]);

  /**
   * Push a subtitle line to any audience window listening on this room.
   *
   * `throttle` is used for mid-stream updates so the audience screen types along
   * with the presenter instead of sitting blank until the sentence completes.
   */
  const publishSubtitle = useCallback((
    payload: { sourceText: string; translatedText: string; isProvisional: boolean; throttle?: boolean },
  ) => {
    if (payload.throttle) {
      const now = Date.now();
      if (now - lastPublishAtRef.current < SUBTITLE_STREAM_INTERVAL_MS) return;
      lastPublishAtRef.current = now;
    } else {
      lastPublishAtRef.current = Date.now();
    }

    const message: BroadcastMessage = {
      kind: 'subtitle',
      sourceText: payload.sourceText,
      translatedText: payload.translatedText,
      sourceLang,
      targetLang,
      mode: currentMode,
      isProvisional: payload.isProvisional,
      sentAt: Date.now(),
    };
    roomChannelRef.current?.post(message);
  }, [sourceLang, targetLang, currentMode]);

  /**
   * Two-way conversation support: after a confirmed translation, ask the LLM
   * which of the two configured languages the utterance was actually in. If it
   * doesn't match the current source, flip direction for the *next* turn —
   * this result is unaffected either way. Best-effort: `detectLanguage` never
   * throws (see translator.ts), so this can't break the main pipeline.
   */
  const maybeFlipDirection = useCallback(async (text: string) => {
    const srcCode = sourceLang.split('-')[0];
    const tgtCode = targetLang.split('-')[0];
    const detected = await translationService.detectLanguage(text, srcCode, tgtCode, settings);
    if (detected && detected === tgtCode) {
      setSourceLang(targetLang);
      setTargetLang(sourceLang);
    }
  }, [sourceLang, targetLang, settings]);

  // Execute Translation Pipeline
  const handleTranslateText = useCallback(async (text: string) => {
    if (!text || text.trim() === '') return;

    // Supersede any in-flight translation: abort its network stream and claim
    // a new sequence number so late callbacks from the old one are ignored.
    abortRef.current?.abort();
    // A confirmed transcript supersedes any speculation about it.
    finalInFlightRef.current = true;
    cancelSpeculation();

    const controller = new AbortController();
    abortRef.current = controller;
    const seq = ++requestSeqRef.current;
    const isCurrent = () => seq === requestSeqRef.current && !controller.signal.aborted;

    setIsTranslating(true);
    setTranslationError(null);
    setEngineNotice(null);
    // Note: `currentStreamingTranslation` is NOT cleared here. The provisional
    // text stays on screen until the confirmed translation produces its first
    // token, so the panel never flashes empty.

    try {
      const historyContext = itemsRef.current.slice(0, 3).map(i => ({
        sourceText: i.sourceText,
        translatedText: i.translatedText,
      }));

      const result = await translationService.translate({
        text,
        sourceLang,
        targetLang,
        mode: currentMode,
        glossary,
        settings,
        history: historyContext,
        signal: controller.signal,
        onChunk: (_chunk, accumulated) => {
          if (!isCurrent()) return;
          // First confirmed token — swap out of the provisional rendering.
          setProvisionalTranslation('');
          setCurrentStreamingTranslation(accumulated);
          publishSubtitle({
            sourceText: text,
            translatedText: accumulated,
            isProvisional: true,
            throttle: true,
          });
        },
      });

      if (!isCurrent()) return;

      // A silently-degraded translation is worse than a visible error: the user
      // keeps a wrong key or model configured and never learns why quality dropped.
      if (result.fallbackReason) {
        setEngineNotice(`${result.fallbackReason} 내장 엔진으로 번역했습니다.`);
      }

      if (!result.translatedText) {
        setCurrentInterimSource('');
        setProvisionalTranslation('');
        return;
      }

      const newItem: TranslationItem = {
        id: `trans_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        timestamp: Date.now(),
        sourceText: text,
        cleanedSourceText: result.cleanedSourceText,
        translatedText: result.translatedText,
        mode: currentMode,
        sourceLang,
        targetLang,
        learningDetails: result.learningDetails,
        latencyMs: result.latencyMs,
        ttftMs: result.ttftMs,
        engineUsed: result.engineUsed,
        isBookmarked: false,
      };

      setItems(prev => [newItem, ...prev]);
      setCurrentInterimSource('');
      setProvisionalTranslation('');
      setCurrentStreamingTranslation(result.translatedText);

      publishSubtitle({
        sourceText: result.cleanedSourceText || text,
        translatedText: result.translatedText,
        isProvisional: false,
      });

      // Auto-TTS — mute the mic while it plays so the app never transcribes
      // its own output back into an endless translate-speak-translate loop.
      if (settings.autoTts) {
        const proxy = normalizeProxyUrl(settings.proxyUrl);
        if (settings.ttsProvider === 'openai' && (proxy || settings.openaiApiKey)) {
          void ttsService.speakOpenAi(result.translatedText, {
            rate: settings.ttsSpeed || 1.0,
            proxyUrl: proxy,
          });
        } else {
          ttsService.speak(result.translatedText, {
            lang: targetLang,
            rate: settings.ttsSpeed || 1.0,
          });
        }
      }

      // Auto-flip direction for the *next* turn if the speaker switched
      // languages — fire-and-forget, never blocks or affects this result.
      if (settings.autoDetectLanguage) {
        void maybeFlipDirection(result.cleanedSourceText || text);
      }

      // Latency-based engine auto-switch (gemini flash <-> flash-lite only).
      if (settings.autoEngineSwitch && result.ttftMs != null) {
        const streak = engineSwitchRef.current;
        const isSlow = result.ttftMs >= ENGINE_LATENCY_THRESHOLD_MS;
        const cooledDown = Date.now() - streak.lastSwitchAt > ENGINE_SWITCH_COOLDOWN_MS;

        if (settings.engine === 'gemini-2.5-flash') {
          streak.slowStreak = isSlow ? streak.slowStreak + 1 : 0;
          streak.fastStreak = 0;
          if (streak.slowStreak >= 2 && cooledDown) {
            streak.slowStreak = 0;
            streak.lastSwitchAt = Date.now();
            setSettings(s => ({ ...s, engine: 'gemini-2.5-flash-lite' }));
            setEngineNotice('네트워크 지연 감지 — 더 빠른 Flash-Lite 엔진으로 전환했습니다.');
          }
        } else if (settings.engine === 'gemini-2.5-flash-lite') {
          streak.fastStreak = isSlow ? 0 : streak.fastStreak + 1;
          streak.slowStreak = 0;
          if (streak.fastStreak >= 5 && cooledDown) {
            streak.fastStreak = 0;
            streak.lastSwitchAt = Date.now();
            setSettings(s => ({ ...s, engine: 'gemini-2.5-flash' }));
            setEngineNotice('응답 속도가 회복되어 Flash 엔진으로 복귀했습니다.');
          }
        }
      }
    } catch (err) {
      if (isAbortError(err)) return; // superseded by a newer utterance
      console.error('Translation error:', err);
      if (isCurrent()) {
        setTranslationError('번역에 실패했습니다. 네트워크 상태 또는 설정의 API 키를 확인해 주세요.');
      }
    } finally {
      if (seq === requestSeqRef.current) {
        setIsTranslating(false);
        finalInFlightRef.current = false;
        lastSpeculatedRef.current = '';
      }
    }
  }, [sourceLang, targetLang, currentMode, glossary, settings, cancelSpeculation, publishSubtitle, maybeFlipDirection]);

  /**
   * ★ P1: translate the interim transcript ahead of the final result.
   *
   * The output is provisional — never written to history, never spoken, and
   * replaced the moment the confirmed translation starts arriving.
   */
  const runSpeculativeTranslation = useCallback(async (text: string) => {
    if (finalInFlightRef.current) return;

    lastSpeculatedRef.current = text;
    lastSpeculationAtRef.current = Date.now();

    specAbortRef.current?.abort();
    const controller = new AbortController();
    specAbortRef.current = controller;
    const seq = ++specSeqRef.current;
    const isCurrent = () =>
      seq === specSeqRef.current && !controller.signal.aborted && !finalInFlightRef.current;

    try {
      const result = await translationService.translate({
        text,
        sourceLang,
        targetLang,
        // Tutor mode returns a JSON blob that cannot stream and costs far more
        // tokens; a speculative pass only needs the sentence itself.
        mode: currentMode === 'tutor' ? 'daily' : currentMode,
        glossary,
        settings,
        history: itemsRef.current.slice(0, 2).map(i => ({
          sourceText: i.sourceText,
          translatedText: i.translatedText,
        })),
        signal: controller.signal,
        onChunk: (_chunk, accumulated) => {
          if (!isCurrent()) return;
          setProvisionalTranslation(accumulated);
          publishSubtitle({
            sourceText: text,
            translatedText: accumulated,
            isProvisional: true,
            throttle: true,
          });
        },
      });

      if (isCurrent() && result.translatedText) {
        setProvisionalTranslation(result.translatedText);
        publishSubtitle({
          sourceText: text,
          translatedText: result.translatedText,
          isProvisional: true,
        });
      }
    } catch (err) {
      // A speculation that fails or gets superseded is not worth surfacing —
      // the confirmed translation is still on its way.
      if (!isAbortError(err)) console.warn('Speculative translation failed:', err);
    }
  }, [sourceLang, targetLang, currentMode, glossary, settings, publishSubtitle]);

  /** Debounced gate: decides whether this interim transcript is worth a call. */
  const handleInterimTranscript = useCallback((interim: string) => {
    setCurrentInterimSource(interim);

    if (!settings.speculativeTranslation || finalInFlightRef.current) return;

    if (specTimerRef.current) clearTimeout(specTimerRef.current);

    if (!shouldSpeculate({ interim, lastSpeculated: lastSpeculatedRef.current })) return;

    // Rate limit: never more than one speculative call per MIN_SPECULATION_GAP_MS.
    const sinceLast = Date.now() - lastSpeculationAtRef.current;
    const delay = Math.max(
      speculationDelayMs(interim),
      MIN_SPECULATION_GAP_MS - sinceLast,
    );

    const snapshot = interim;
    specTimerRef.current = setTimeout(() => {
      specTimerRef.current = null;
      void runSpeculativeTranslation(snapshot);
    }, delay);
  }, [settings.speculativeTranslation, runSpeculativeTranslation]);

  // STT: native Web Speech, or the Whisper proxy fallback when it's unsupported
  // or failing repeatedly (see useTranscription).
  const {
    isListening,
    audioLevel,
    audioFrequencies,
    toggleListening,
    isSupported,
    errorMessage,
    suspendListening,
    resumeListening,
    sttEngine,
  } = useTranscription({
    lang: sourceLang,
    settings,
    onInterimTranscript: handleInterimTranscript,
    onFinalTranscript: (finalText) => {
      void handleTranslateText(finalText);
    },
  });

  // One channel per room, reopened when the room id changes.
  useEffect(() => {
    const channel = new RoomChannel(roomId);
    roomChannelRef.current = channel;
    return () => {
      channel.post({ kind: 'presence', state: 'idle', sentAt: Date.now() });
      channel.close();
      roomChannelRef.current = null;
    };
  }, [roomId]);

  // Tell audience windows whether the mic is actually running.
  useEffect(() => {
    roomChannelRef.current?.post({
      kind: 'presence',
      state: isListening ? 'live' : 'idle',
      sentAt: Date.now(),
    });
  }, [isListening]);

  /**
   * The shadowing modal runs its own recogniser. Two live `SpeechRecognition`
   * instances fight over the microphone in Chrome, so the presenter's session is
   * suspended for the duration and resumed on close.
   */
  useEffect(() => {
    if (activeShadowingItem) {
      suspendListening();
    } else {
      resumeListening();
    }
  }, [activeShadowingItem, suspendListening, resumeListening]);

  // Every TTS playback in the app — auto-TTS, the speed buttons, shadowing —
  // mutes the mic through this single gate.
  useEffect(() => {
    ttsService.setPlaybackGate({ onStart: suspendListening, onEnd: resumeListening });
    return () => ttsService.setPlaybackGate(null);
  }, [suspendListening, resumeListening]);

  // Abort any in-flight translation and silence TTS on unmount.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      cancelSpeculation();
      ttsService.stop();
    };
  }, [cancelSpeculation]);

  // Stopping the mic drops anything still pending. The provisional *text* is not
  // cleared here — it is simply not rendered while the mic is off (see the
  // `provisionalTranslation` prop below), which keeps this effect free of state
  // updates and avoids a cascading render.
  useEffect(() => {
    if (!isListening) {
      cancelSpeculation();
      lastSpeculatedRef.current = '';
    }
  }, [isListening, cancelSpeculation]);

  // Language Swap
  const handleSwapLanguages = () => {
    const temp = sourceLang;
    setSourceLang(targetLang);
    setTargetLang(temp);
  };

  // Sample testing
  const handleTestSample = (sampleText: string) => {
    setCurrentInterimSource(sampleText);
    setProvisionalTranslation('');
    void handleTranslateText(sampleText);
  };

  // Bookmark / Flashcard Handlers
  const handleBookmarkItem = (id: string) => {
    setItems(prev => prev.map(item => {
      if (item.id === id) {
        const nextState = !item.isBookmarked;
        if (nextState) {
          // Add to flashcards
          const newCard: SavedFlashcard = {
            id: `card_${Date.now()}`,
            word: item.translatedText,
            meaning: item.sourceText,
            savedAt: Date.now(),
            exampleSentence: item.translatedText,
          };
          setSavedCards(c => [newCard, ...c]);
        }
        return { ...item, isBookmarked: nextState };
      }
      return item;
    }));
  };

  const handleSaveVocabulary = (vocab: KeyVocabulary, contextSentence: string) => {
    const exists = savedCards.some(c => c.word.toLowerCase() === vocab.word.toLowerCase());
    if (exists) return;

    const newCard: SavedFlashcard = {
      id: `card_${Date.now()}`,
      word: vocab.word,
      meaning: vocab.meaning,
      ipa: vocab.ipa,
      pos: vocab.pos,
      exampleSentence: contextSentence,
      savedAt: Date.now(),
    };
    setSavedCards(prev => [newCard, ...prev]);
  };

  const handleDeleteItem = (id: string) => {
    setItems(prev => prev.filter(item => item.id !== id));
  };

  const handleClearAllItems = () => {
    if (window.confirm('모든 번역 기록을 삭제하시겠습니까?')) {
      setItems([]);
      setCurrentInterimSource('');
      setCurrentStreamingTranslation('');
      setProvisionalTranslation('');
    }
  };

  // Name the engine that produced the most recent translation, falling back to
  // the configured one before anything has been translated.
  const activeEngineLabel = (() => {
    const lastEngine = items[0]?.engineUsed;
    const id = lastEngine === 'builtin' ? 'smart-local' : (lastEngine ?? settings.engine);
    const option = ENGINE_OPTIONS.find(o => o.id === id);
    return option ? `번역 엔진: ${option.name}` : '번역 엔진: 내장 엔진';
  })();

  const handleRegenerateRoom = () => {
    const fresh = createRoomId();
    localStorage.setItem(ROOM_STORAGE_KEY, fresh);
    setRoomId(fresh);
  };

  // Glossary Handlers
  const handleAddGlossary = (item: Omit<GlossaryItem, 'id'>) => {
    const newItem: GlossaryItem = {
      id: `gloss_${Date.now()}`,
      ...item,
    };
    setGlossary(prev => [newItem, ...prev]);
  };

  const handleDeleteGlossary = (id: string) => {
    setGlossary(prev => prev.filter(g => g.id !== id));
  };

  const handleResetDefaultGlossary = () => {
    setGlossary(DEFAULT_GLOSSARY_ITEMS);
  };

  // Flashcards Handlers
  const handleDeleteCard = (id: string) => {
    setSavedCards(prev => prev.filter(c => c.id !== id));
  };

  const handleClearAllCards = () => {
    if (window.confirm('단어장의 모든 단어를 비우시겠습니까?')) {
      setSavedCards([]);
    }
  };

  return (
    <div className="h-screen h-[100dvh] overflow-hidden bg-slate-50 text-slate-800 flex flex-col font-sans selection:bg-indigo-500 selection:text-white">
      {/* Header */}
      <Header
        onOpenSettings={() => setIsSettingsOpen(true)}
        onOpenGlossary={() => setIsGlossaryOpen(true)}
        onOpenFlashcards={() => setIsFlashcardsOpen(true)}
        onOpenAudienceRoom={() => setIsAudienceRoomOpen(true)}
        onOpenExport={() => setIsExportOpen(true)}
        savedCardsCount={savedCards.length}
      />

      {/* Whisper fallback is quietly active — this is informational, not an
          error, so it gets its own small banner rather than the alert below. */}
      {sttEngine === 'whisper' && isSupported && !errorMessage && (
        <div className="w-full max-w-7xl mx-auto px-4 pt-3">
          <div className="rounded-2xl border border-indigo-200 bg-indigo-50 px-4 py-2 text-xs text-indigo-700">
            Whisper 음성인식 폴백 사용 중 (브라우저 기본 인식이 지원되지 않거나 반복 실패했습니다) — OpenAI 사용량이 별도로 발생합니다.
          </div>
        </div>
      )}

      {/* ★ P0-6: surface STT / translation failures. These states existed in the
          hook but were never rendered, so unsupported browsers and denied mic
          permissions produced a button that silently did nothing. */}
      {(!isSupported || errorMessage || translationError || engineNotice) && (
        <div className="w-full max-w-7xl mx-auto px-4 pt-3">
          <div
            role="alert"
            className={`flex items-start gap-2.5 rounded-2xl border px-4 py-3 text-sm ${
              !isSupported || errorMessage
                ? 'bg-rose-50 border-rose-200 text-rose-800'
                : 'bg-amber-50 border-amber-200 text-amber-800'
            }`}
          >
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="font-semibold">
                {!isSupported
                  ? '이 브라우저에서는 음성 인식을 사용할 수 없습니다'
                  : errorMessage
                    ? '음성 인식 오류'
                    : translationError
                      ? '번역 오류'
                      : '번역 엔진 전환됨'}
              </p>
              <p className="mt-0.5 text-[13px] leading-relaxed opacity-90">
                {!isSupported ? (
                  <>
                    데스크톱 <span className="font-semibold">Chrome</span> 또는{' '}
                    <span className="font-semibold">Edge</span>에서 열어 주세요. 아래 샘플 문장 버튼으로 번역 기능은 그대로 테스트할 수 있습니다.
                  </>
                ) : (
                  errorMessage || translationError || engineNotice
                )}
              </p>
            </div>
            {(translationError || engineNotice) && !errorMessage && isSupported && (
              <button
                onClick={() => { setTranslationError(null); setEngineNotice(null); }}
                className="shrink-0 rounded-lg px-2 py-1 text-xs font-semibold hover:bg-amber-100 transition"
              >
                닫기
              </button>
            )}
          </div>
        </div>
      )}

      {/* Main Content Area — one continuous conversation stream */}
      <main className="flex-1 min-h-0 w-full flex flex-col">
        <ConversationStream
          items={items}
          isListening={isListening}
          onToggleListening={toggleListening}
          audioLevel={audioLevel}
          audioFrequencies={audioFrequencies}
          currentInterimSource={currentInterimSource}
          currentStreamingTranslation={currentStreamingTranslation}
          provisionalTranslation={isListening ? provisionalTranslation : ''}
          isTranslating={isTranslating}
          sourceLang={sourceLang}
          targetLang={targetLang}
          onSourceLangChange={setSourceLang}
          onTargetLangChange={setTargetLang}
          onSwapLanguages={handleSwapLanguages}
          autoDetectLanguage={settings.autoDetectLanguage}
          currentMode={currentMode}
          onSelectMode={setCurrentMode}
          fontSize={settings.fontSize}
          bilingualDisplay={settings.bilingualDisplay}
          darkStage={settings.darkStage}
          onTestSample={handleTestSample}
          onBookmarkItem={handleBookmarkItem}
          onDeleteItem={handleDeleteItem}
          onClearAll={handleClearAllItems}
          onOpenShadowing={(item) => setActiveShadowingItem(item)}
          onSaveVocabulary={handleSaveVocabulary}
        />
      </main>

      {/* Footer */}
      <footer className="hidden sm:block shrink-0 w-full border-t border-gray-200 bg-white/80 py-2 text-center text-[11px] text-gray-400">
        <span className="font-semibold text-gray-500">FluentLive AI</span>
        <span className="mx-1.5">·</span>
        <span>{activeEngineLabel}</span>
      </footer>

      {/* Modals */}
      <SettingsModal
        isOpen={isSettingsOpen}
        settings={settings}
        onClose={() => setIsSettingsOpen(false)}
        onSaveSettings={setSettings}
      />

      <GlossaryModal
        isOpen={isGlossaryOpen}
        glossary={glossary}
        onClose={() => setIsGlossaryOpen(false)}
        onAddGlossary={handleAddGlossary}
        onDeleteGlossary={handleDeleteGlossary}
        onResetDefault={handleResetDefaultGlossary}
      />

      <FlashcardsModal
        isOpen={isFlashcardsOpen}
        cards={savedCards}
        onClose={() => setIsFlashcardsOpen(false)}
        onDeleteCard={handleDeleteCard}
        onClearAll={handleClearAllCards}
      />

      <ShadowingModal
        isOpen={!!activeShadowingItem}
        item={activeShadowingItem}
        onClose={() => setActiveShadowingItem(null)}
      />

      <AudienceRoomModal
        isOpen={isAudienceRoomOpen}
        onClose={() => setIsAudienceRoomOpen(false)}
        roomId={roomId}
        isBroadcasting={isListening}
        onRegenerateRoom={handleRegenerateRoom}
      />

      <ExportModal
        isOpen={isExportOpen}
        items={items}
        settings={settings}
        onClose={() => setIsExportOpen(false)}
      />
    </div>
  );
}

export default App;
