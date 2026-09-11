import { useCallback, useEffect, useRef, useState } from 'react';

// Web Speech API interface definitions
interface SpeechRecognitionEvent extends Event {
  resultIndex: number;
  results: SpeechRecognitionResultList;
}

interface SpeechRecognitionResultList {
  length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionResult {
  isFinal: boolean;
  length: number;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionAlternative {
  transcript: string;
  confidence: number;
}

interface SpeechRecognitionInstance extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: Event & { error?: string }) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}

declare global {
  interface Window {
    SpeechRecognition?: new () => SpeechRecognitionInstance;
    webkitSpeechRecognition?: new () => SpeechRecognitionInstance;
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  }
}

interface UseSpeechRecognitionProps {
  lang: string;
  onFinalTranscript?: (transcript: string) => void;
  onInterimTranscript?: (transcript: string) => void;
}

const UNSUPPORTED_MESSAGE =
  '이 브라우저는 음성 인식(Web Speech API)을 지원하지 않습니다. 데스크톱 Chrome 또는 Edge를 사용해 주세요.';

function hasSpeechRecognition(): boolean {
  return typeof window !== 'undefined' && Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
}

/** Backoff schedule (ms) for consecutive restart failures. */
const RESTART_BACKOFF = [150, 400, 1000, 2500, 5000];
const MAX_RESTART_ATTEMPTS = RESTART_BACKOFF.length;

export function useSpeechRecognition({
  lang,
  onFinalTranscript,
  onInterimTranscript,
}: UseSpeechRecognitionProps) {
  const [isListening, setIsListening] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState('');
  const [isSupported, setIsSupported] = useState(hasSpeechRecognition);
  const [audioLevel, setAudioLevel] = useState(0);
  const [audioFrequencies, setAudioFrequencies] = useState<number[]>(new Array(24).fill(0));
  const [errorMessage, setErrorMessage] = useState<string | null>(() =>
    hasSpeechRecognition() ? null : UNSUPPORTED_MESSAGE,
  );
  /**
   * True once `'network'` errors (Google's recognition backend unreachable —
   * common on locked-down corporate networks or in some countries) have fired
   * repeatedly in a row. A caller can use this to switch to the Whisper
   * fallback even though the Web Speech API itself is technically supported.
   */
  const [persistentNetworkError, setPersistentNetworkError] = useState(false);
  const networkErrorStreakRef = useRef(0);

  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const isListeningRef = useRef(false);
  // Suspended = mic intentionally paused (e.g. while TTS is playing) but session still "on".
  const isSuspendedRef = useRef(false);
  const restartAttemptsRef = useRef(0);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const restartTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Callbacks via refs so the recognition instance never holds a stale closure.
  const onFinalTranscriptRef = useRef(onFinalTranscript);
  const onInterimTranscriptRef = useRef(onInterimTranscript);
  useEffect(() => {
    onFinalTranscriptRef.current = onFinalTranscript;
    onInterimTranscriptRef.current = onInterimTranscript;
  }, [onFinalTranscript, onInterimTranscript]);

  const langRef = useRef(lang);

  // Indirection ref: onend needs to call spawn(), which is defined below it.
  const spawnRef = useRef<() => void>(() => {});

  const clearRestartTimer = useCallback(() => {
    if (restartTimeoutRef.current) {
      clearTimeout(restartTimeoutRef.current);
      restartTimeoutRef.current = null;
    }
  }, []);

  /** Detach every handler and abort, so a dead instance can never trigger a restart. */
  const detachRecognition = useCallback(() => {
    const rec = recognitionRef.current;
    recognitionRef.current = null;
    if (!rec) return;
    rec.onstart = null;
    rec.onresult = null;
    rec.onerror = null;
    rec.onend = null;
    try {
      rec.abort();
    } catch {
      // Already stopped
    }
  }, []);

  const scheduleRestart = useCallback(() => {
    clearRestartTimer();
    if (!isListeningRef.current || isSuspendedRef.current) return;

    if (restartAttemptsRef.current >= MAX_RESTART_ATTEMPTS) {
      isListeningRef.current = false;
      setIsListening(false);
      setErrorMessage('음성 인식이 반복적으로 중단되었습니다. 마이크 버튼을 다시 눌러 주세요.');
      return;
    }

    const delay = RESTART_BACKOFF[restartAttemptsRef.current];
    restartAttemptsRef.current += 1;
    restartTimeoutRef.current = setTimeout(() => {
      restartTimeoutRef.current = null;
      spawnRef.current();
    }, delay);
  }, [clearRestartTimer]);

  /**
   * ★ FIX (P0-1): always build a FRESH recognition instance.
   * The previous implementation nulled `onend` on stop and then reused the same
   * object on the next start, permanently disabling auto-restart after the first
   * stop/start cycle (and after every language switch).
   */
  const spawnRecognition = useCallback(() => {
    const SpeechRecognitionClass = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognitionClass) {
      setIsSupported(false);
      return;
    }

    detachRecognition();

    const recognition = new SpeechRecognitionClass();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.lang = langRef.current;

    recognition.onstart = () => {
      setIsListening(true);
      setErrorMessage(null);
    };

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      // A result proves the pipeline is healthy — reset the backoff.
      restartAttemptsRef.current = 0;
      if (networkErrorStreakRef.current > 0) {
        networkErrorStreakRef.current = 0;
        setPersistentNetworkError(false);
      }

      let currentInterim = '';
      let currentFinal = '';

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const transcript = result[0].transcript;
        if (result.isFinal) {
          currentFinal += transcript;
        } else {
          currentInterim += transcript;
        }
      }

      if (currentInterim) {
        setInterimTranscript(currentInterim);
        onInterimTranscriptRef.current?.(currentInterim);
      }

      if (currentFinal.trim()) {
        setInterimTranscript('');
        onFinalTranscriptRef.current?.(currentFinal.trim());
      }
    };

    recognition.onerror = (event) => {
      const errorType = event.error;

      if (errorType === 'not-allowed' || errorType === 'service-not-allowed') {
        isListeningRef.current = false;
        clearRestartTimer();
        detachRecognition();
        setIsListening(false);
        setErrorMessage('마이크 접근 권한이 거부되었습니다. 주소창의 자물쇠 아이콘에서 마이크를 허용해 주세요.');
        return;
      }

      if (errorType === 'no-speech') {
        // Perfectly normal during a pause — don't count it as a failure.
        restartAttemptsRef.current = 0;
        return;
      }

      if (errorType === 'network') {
        setErrorMessage('음성 인식 서버 연결이 불안정합니다. 재연결 중...');
        networkErrorStreakRef.current += 1;
        if (networkErrorStreakRef.current >= 3) {
          setPersistentNetworkError(true);
        }
        return;
      }

      if (errorType === 'audio-capture') {
        setErrorMessage('마이크 장치를 찾을 수 없습니다. 입력 장치를 확인해 주세요.');
        return;
      }

      console.warn('Speech recognition error:', errorType);
    };

    recognition.onend = () => {
      recognitionRef.current = null;
      if (isListeningRef.current && !isSuspendedRef.current) {
        scheduleRestart();
      } else if (!isListeningRef.current) {
        setIsListening(false);
      }
    };

    recognitionRef.current = recognition;

    try {
      recognition.start();
    } catch (err) {
      // InvalidStateError etc. — retry with backoff instead of dying silently.
      console.warn('Recognition start failed, scheduling retry:', err);
      scheduleRestart();
    }
  }, [clearRestartTimer, detachRecognition, scheduleRestart]);

  useEffect(() => {
    spawnRef.current = spawnRecognition;
  }, [spawnRecognition]);

  // Unmount cleanup.
  useEffect(() => {
    return () => {
      isListeningRef.current = false;
      isSuspendedRef.current = false;
      clearRestartTimer();
      detachRecognition();
    };
  }, [clearRestartTimer, detachRecognition]);

  // Audio Context Visualizer
  const startAudioVisualizer = useCallback(async () => {
    if (mediaStreamRef.current) return;
    try {
      // ★ FIX (P0-4): echo cancellation keeps the app's own TTS out of the mic.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      mediaStreamRef.current = stream;

      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;

      const audioCtx = new AudioCtx();
      audioContextRef.current = audioCtx;

      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 64;
      analyser.smoothingTimeConstant = 0.8;
      source.connect(analyser);
      analyserRef.current = analyser;

      const dataArray = new Uint8Array(analyser.frequencyBinCount);

      const updateMeter = () => {
        if (!analyserRef.current) return;
        analyserRef.current.getByteFrequencyData(dataArray);

        const binCount = 24;
        const step = Math.floor(dataArray.length / binCount) || 1;
        const bins: number[] = [];
        let sum = 0;

        for (let i = 0; i < binCount; i++) {
          const val = dataArray[i * step] || 0;
          bins.push(Math.round((val / 255) * 100));
          sum += val;
        }

        // Average over the bins actually sampled (was divided by dataArray.length).
        const avg = sum / binCount;
        setAudioLevel(Math.min(100, Math.round((avg / 128) * 100)));
        setAudioFrequencies(bins);

        animationFrameRef.current = requestAnimationFrame(updateMeter);
      };

      updateMeter();
    } catch (err) {
      console.warn('Microphone visualizer init warning:', err);
    }
  }, []);

  const stopAudioVisualizer = useCallback(() => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    analyserRef.current = null;
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(t => t.stop());
      mediaStreamRef.current = null;
    }
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      audioContextRef.current.close();
    }
    audioContextRef.current = null;
    setAudioLevel(0);
    setAudioFrequencies(new Array(24).fill(0));
  }, []);

  const startListening = useCallback(async () => {
    if (isListeningRef.current) return;
    if (!hasSpeechRecognition()) {
      setIsSupported(false);
      setErrorMessage(UNSUPPORTED_MESSAGE);
      return;
    }

    isListeningRef.current = true;
    isSuspendedRef.current = false;
    restartAttemptsRef.current = 0;
    networkErrorStreakRef.current = 0;
    setPersistentNetworkError(false);
    setErrorMessage(null);
    setIsListening(true);

    spawnRecognition();
    await startAudioVisualizer();
  }, [spawnRecognition, startAudioVisualizer]);

  const stopListening = useCallback(() => {
    isListeningRef.current = false;
    isSuspendedRef.current = false;
    restartAttemptsRef.current = 0;
    clearRestartTimer();
    detachRecognition();
    setIsListening(false);
    setInterimTranscript('');
    stopAudioVisualizer();
  }, [clearRestartTimer, detachRecognition, stopAudioVisualizer]);

  const toggleListening = useCallback(() => {
    // Reads the ref, not state, so the callback identity stays stable.
    if (isListeningRef.current) {
      stopListening();
    } else {
      void startListening();
    }
  }, [startListening, stopListening]);

  /**
   * ★ P0-4: pause the mic without ending the session (used while TTS speaks,
   * so the app never transcribes its own output).
   */
  const suspendListening = useCallback(() => {
    if (!isListeningRef.current || isSuspendedRef.current) return;
    isSuspendedRef.current = true;
    clearRestartTimer();
    detachRecognition();
    setInterimTranscript('');
  }, [clearRestartTimer, detachRecognition]);

  const resumeListening = useCallback(() => {
    if (!isListeningRef.current || !isSuspendedRef.current) return;
    isSuspendedRef.current = false;
    restartAttemptsRef.current = 0;
    spawnRecognition();
  }, [spawnRecognition]);

  // Language switch: restart the active session with the new locale.
  useEffect(() => {
    langRef.current = lang;
    if (isListeningRef.current && !isSuspendedRef.current) {
      clearRestartTimer();
      restartAttemptsRef.current = 0;
      spawnRecognition();
    }
  }, [lang, clearRestartTimer, spawnRecognition]);

  return {
    isListening,
    interimTranscript,
    isSupported,
    audioLevel,
    audioFrequencies,
    errorMessage,
    persistentNetworkError,
    startListening,
    stopListening,
    toggleListening,
    suspendListening,
    resumeListening,
  };
}
