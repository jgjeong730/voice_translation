import { useEffect, useRef } from 'react';
import type { AppSettings } from '../types';
import { useSpeechRecognition } from './useSpeechRecognition';
import { useWhisperRecognition } from './useWhisperRecognition';

interface UseTranscriptionProps {
  lang: string;
  settings: AppSettings;
  onFinalTranscript?: (transcript: string) => void;
  onInterimTranscript?: (transcript: string) => void;
}

/**
 * Picks between the native Web Speech recognizer and the Whisper proxy
 * fallback, exposing a single unified API so `App.tsx` doesn't need to branch.
 * Both underlying hooks are always called (Rules of Hooks), but only the
 * active one's mic is ever actually running — the other is kept stopped.
 */
export function useTranscription({ lang, settings, onFinalTranscript, onInterimTranscript }: UseTranscriptionProps) {
  const native = useSpeechRecognition({ lang, onFinalTranscript, onInterimTranscript });
  const whisper = useWhisperRecognition({ lang, settings, onFinalTranscript, onInterimTranscript });

  const useWhisperEngine = !native.isSupported
    || (settings.sttFallbackEnabled && native.persistentNetworkError);

  // Refs so the engine-switch effect below doesn't need the whole (identity-
  // unstable, re-created every render) hook result objects in its deps.
  const nativeRef = useRef(native);
  const whisperRef = useRef(whisper);
  useEffect(() => { nativeRef.current = native; });
  useEffect(() => { whisperRef.current = whisper; });

  const wasWhisperRef = useRef(useWhisperEngine);
  useEffect(() => {
    if (wasWhisperRef.current === useWhisperEngine) return;
    const wasListening = wasWhisperRef.current ? whisperRef.current.isListening : nativeRef.current.isListening;

    if (wasWhisperRef.current) {
      whisperRef.current.stopListening();
    } else {
      nativeRef.current.stopListening();
    }
    wasWhisperRef.current = useWhisperEngine;

    if (wasListening) {
      if (useWhisperEngine) void whisperRef.current.startListening();
      else void nativeRef.current.startListening();
    }
  }, [useWhisperEngine]);

  const active = useWhisperEngine ? whisper : native;

  return {
    ...active,
    sttEngine: (useWhisperEngine ? 'whisper' : 'native') as 'native' | 'whisper',
  };
}
