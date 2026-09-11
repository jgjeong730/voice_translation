import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppSettings } from '../types';
import { normalizeProxyUrl } from '../services/translator';

/**
 * Whisper-based STT fallback for when the Web Speech API is unsupported
 * (Safari/Firefox) or failing repeatedly (e.g. a corporate network blocking
 * Google's recognition backend). Mirrors `useSpeechRecognition`'s public shape
 * so callers can swap between the two without touching anything else.
 *
 * There is no continuous "interim" result the way Web Speech gives one — the
 * OpenAI transcription endpoint only returns a finished transcript per audio
 * clip — so this segments the mic stream on silence (a ~700ms pause) and POSTs
 * each completed segment to the Cloudflare Worker proxy, which forwards it to
 * Whisper. `interimTranscript` therefore always stays empty in this mode.
 */

interface UseWhisperRecognitionProps {
  lang: string;
  settings: AppSettings;
  onFinalTranscript?: (transcript: string) => void;
  onInterimTranscript?: (transcript: string) => void;
}

const SILENCE_MS = 700;
const MIN_UTTERANCE_MS = 500;
/** On the same 0-100 scale `useSpeechRecognition` computes for its level meter. */
const SPEECH_LEVEL_THRESHOLD = 12;

function hasWhisperSupport(): boolean {
  return typeof window !== 'undefined'
    && typeof window.MediaRecorder !== 'undefined'
    && Boolean(navigator.mediaDevices?.getUserMedia);
}

export function useWhisperRecognition({
  lang,
  settings,
  onFinalTranscript,
  onInterimTranscript,
}: UseWhisperRecognitionProps) {
  const [isListening, setIsListening] = useState(false);
  const [isSupported] = useState(hasWhisperSupport);
  const [audioLevel, setAudioLevel] = useState(0);
  const [audioFrequencies, setAudioFrequencies] = useState<number[]>(new Array(24).fill(0));
  const [errorMessage, setErrorMessage] = useState<string | null>(() =>
    hasWhisperSupport() ? null : '이 브라우저는 마이크 녹음(MediaRecorder)을 지원하지 않습니다.',
  );

  const langRef = useRef(lang);
  const settingsRef = useRef(settings);
  useEffect(() => { langRef.current = lang; }, [lang]);
  useEffect(() => { settingsRef.current = settings; }, [settings]);

  const onFinalTranscriptRef = useRef(onFinalTranscript);
  const onInterimTranscriptRef = useRef(onInterimTranscript);
  useEffect(() => {
    onFinalTranscriptRef.current = onFinalTranscript;
    onInterimTranscriptRef.current = onInterimTranscript;
  }, [onFinalTranscript, onInterimTranscript]);

  const isListeningRef = useRef(false);
  const isSuspendedRef = useRef(false);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const segmentStartedAtRef = useRef(0);
  const lastAboveThresholdAtRef = useRef(0);
  const hasSpokenRef = useRef(false);

  const flushSegment = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === 'inactive') return;
    recorder.stop(); // onstop below sends the accumulated chunks and starts the next segment.
  }, []);

  const sendSegment = useCallback(async (blob: Blob) => {
    if (blob.size < 2_000) return; // Too short to be real speech.
    const proxy = normalizeProxyUrl(settingsRef.current.proxyUrl);
    if (!proxy) {
      setErrorMessage('Whisper 폴백은 번역 프록시(Worker) 설정이 필요합니다.');
      return;
    }

    try {
      const form = new FormData();
      form.append('file', blob, 'audio.webm');
      form.append('language', langRef.current.split('-')[0]);

      const response = await fetch(`${proxy}/openai/audio/transcriptions`, {
        method: 'POST',
        body: form,
      });

      if (!response.ok) {
        const detail = await response.json().catch(() => null) as { error?: string } | null;
        setErrorMessage(detail?.error || `Whisper 인식 실패 (${response.status})`);
        return;
      }

      const data = await response.json() as { text?: string };
      const text = (data.text ?? '').trim();
      if (text) {
        onFinalTranscriptRef.current?.(text);
        setErrorMessage(null);
      }
    } catch (err) {
      console.warn('Whisper transcription request failed:', err);
      setErrorMessage('Whisper 인식 서버에 연결할 수 없습니다.');
    }
  }, []);

  const startSegment = useCallback(() => {
    const stream = mediaStreamRef.current;
    if (!stream) return;

    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : undefined;
    const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    chunksRef.current = [];
    segmentStartedAtRef.current = performance.now();
    hasSpokenRef.current = false;

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: mimeType ?? 'audio/webm' });
      chunksRef.current = [];
      if (hasSpokenRef.current && performance.now() - segmentStartedAtRef.current > MIN_UTTERANCE_MS) {
        void sendSegment(blob);
      }
      // Keep listening continuously: immediately open the next segment.
      if (isListeningRef.current && !isSuspendedRef.current) {
        startSegment();
      }
    };

    recorder.start();
    recorderRef.current = recorder;
  }, [sendSegment]);

  const startVisualizerAndRecorder = useCallback(async () => {
    if (mediaStreamRef.current) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      mediaStreamRef.current = stream;

      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) {
        const audioCtx = new AudioCtx();
        audioContextRef.current = audioCtx;
        const source = audioCtx.createMediaStreamSource(stream);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 64;
        analyser.smoothingTimeConstant = 0.8;
        source.connect(analyser);
        analyserRef.current = analyser;

        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        const binCount = 24;
        const step = Math.floor(dataArray.length / binCount) || 1;

        const tick = () => {
          if (!analyserRef.current) return;
          analyserRef.current.getByteFrequencyData(dataArray);

          const bins: number[] = [];
          let sum = 0;
          for (let i = 0; i < binCount; i++) {
            const val = dataArray[i * step] || 0;
            bins.push(Math.round((val / 255) * 100));
            sum += val;
          }
          const level = Math.min(100, Math.round((sum / binCount / 128) * 100));
          setAudioLevel(level);
          setAudioFrequencies(bins);

          if (isListeningRef.current && !isSuspendedRef.current) {
            const now = performance.now();
            if (level >= SPEECH_LEVEL_THRESHOLD) {
              hasSpokenRef.current = true;
              lastAboveThresholdAtRef.current = now;
            } else if (
              hasSpokenRef.current
              && now - lastAboveThresholdAtRef.current > SILENCE_MS
              && now - segmentStartedAtRef.current > MIN_UTTERANCE_MS
            ) {
              flushSegment();
            }
          }

          animationFrameRef.current = requestAnimationFrame(tick);
        };
        tick();
      }

      startSegment();
    } catch (err) {
      console.warn('Whisper mic init failed:', err);
      setErrorMessage('마이크 접근 권한이 거부되었습니다.');
    }
  }, [flushSegment, startSegment]);

  const stopVisualizerAndRecorder = useCallback(() => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.onstop = null; // Discard the in-flight segment — session is ending.
      recorderRef.current.stop();
    }
    recorderRef.current = null;
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
    if (isListeningRef.current || !isSupported) return;
    isListeningRef.current = true;
    isSuspendedRef.current = false;
    setErrorMessage(null);
    setIsListening(true);
    await startVisualizerAndRecorder();
  }, [isSupported, startVisualizerAndRecorder]);

  const stopListening = useCallback(() => {
    isListeningRef.current = false;
    isSuspendedRef.current = false;
    setIsListening(false);
    stopVisualizerAndRecorder();
  }, [stopVisualizerAndRecorder]);

  const toggleListening = useCallback(() => {
    if (isListeningRef.current) stopListening();
    else void startListening();
  }, [startListening, stopListening]);

  /** Pause capture without ending the session, so we don't transcribe our own TTS. */
  const suspendListening = useCallback(() => {
    if (!isListeningRef.current || isSuspendedRef.current) return;
    isSuspendedRef.current = true;
    if (recorderRef.current && recorderRef.current.state === 'recording') {
      recorderRef.current.pause();
    }
  }, []);

  const resumeListening = useCallback(() => {
    if (!isListeningRef.current || !isSuspendedRef.current) return;
    isSuspendedRef.current = false;
    hasSpokenRef.current = false;
    segmentStartedAtRef.current = performance.now();
    if (recorderRef.current && recorderRef.current.state === 'paused') {
      recorderRef.current.resume();
    }
  }, []);

  useEffect(() => {
    return () => {
      isListeningRef.current = false;
      isSuspendedRef.current = false;
      stopVisualizerAndRecorder();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    isListening,
    interimTranscript: '', // Whisper has no partial results.
    isSupported,
    audioLevel,
    audioFrequencies,
    errorMessage,
    persistentNetworkError: false,
    startListening,
    stopListening,
    toggleListening,
    suspendListening,
    resumeListening,
  };
}
