import React, { useState } from 'react';
import { 
  X, 
  Settings, 
  Key, 
  Cpu, 
  Volume2, 
  Check, 
  ExternalLink, 
  ShieldCheck, 
  Sparkles,
  Zap,
  Monitor,
  AlertTriangle,
  Repeat,
  Gauge,
  Mic,
  Send,
} from 'lucide-react';
import type { AppSettings } from '../types';
import { ENGINE_OPTIONS } from '../constants';
import { normalizeProxyUrl } from '../services/translator';

const BADGE_TONE = {
  emerald: 'bg-emerald-100 text-emerald-700',
  indigo: 'bg-indigo-100 text-indigo-700',
  amber: 'bg-amber-100 text-amber-800',
} as const;

const FONT_SIZE_LABEL = { sm: '작게', base: '보통', lg: '크게', xl: '아주 크게' } as const;
const FONT_SIZE_PREVIEW = { sm: 'text-[10px]', base: 'text-xs', lg: 'text-sm', xl: 'text-base' } as const;

interface SettingsModalProps {
  isOpen: boolean;
  settings: AppSettings;
  onClose: () => void;
  onSaveSettings: (newSettings: AppSettings) => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  settings,
  onClose,
  onSaveSettings,
}) => {
  const [formData, setFormData] = useState<AppSettings>(settings);
  const [isSaved, setIsSaved] = useState(false);

  const usingProxy = normalizeProxyUrl(formData.proxyUrl).length > 0;

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSaveSettings(formData);
    setIsSaved(true);
    setTimeout(() => {
      setIsSaved(false);
      onClose();
    }, 800);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/30 backdrop-blur-md">
      <div className="relative w-full max-w-xl rounded-3xl bg-white border border-gray-200 p-6 sm:p-8 shadow-xl overflow-hidden max-h-[90vh] flex flex-col">
        
        {/* Close Button */}
        <button
          onClick={onClose}
          className="absolute top-5 right-5 p-2 rounded-xl bg-gray-100 hover:bg-gray-200 text-gray-500 hover:text-gray-800 transition"
        >
          <X className="w-4 h-4" />
        </button>

        {/* Header */}
        <div className="flex items-center gap-2.5 mb-6">
          <div className="w-10 h-10 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center border border-indigo-200">
            <Settings className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
              환경 설정 및 AI 번역 엔진
            </h2>
            <p className="text-xs text-gray-500">번역 엔진, 자막 표시, 음성 옵션을 설정하세요.</p>
          </div>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto space-y-4 pr-1">
          
          {/* AI Engine Selection */}
          <div className="p-4 rounded-2xl bg-gray-50 border border-gray-200">
            <label className="block text-xs font-bold text-gray-700 uppercase tracking-wider mb-2 flex items-center gap-1.5">
              <Cpu className="w-4 h-4 text-indigo-600" />
              AI 번역 엔진 선택
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {ENGINE_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setFormData({ ...formData, engine: option.id })}
                  className={`p-3 rounded-xl border text-left transition flex flex-col justify-between ${
                    formData.engine === option.id
                      ? 'bg-indigo-50 border-indigo-500 text-gray-900 shadow-xs'
                      : 'bg-white border-gray-200 text-gray-500 hover:border-gray-300'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-bold text-indigo-600">{option.name}</span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold shrink-0 ${BADGE_TONE[option.badgeTone]}`}>
                      {option.badge}
                    </span>
                  </div>
                  <p className="text-[11px] text-gray-500 mt-1">{option.description}</p>
                </button>
              ))}
            </div>

            {/* What the no-key path actually is. It was labelled a "local"
                engine, which it is not. */}
            {formData.engine === 'smart-local' && (
              <div className="mt-3 flex items-start gap-2 rounded-xl bg-amber-50 border border-amber-200 px-3 py-2.5 text-[11px] leading-relaxed text-amber-900">
                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-amber-600" />
                <span>
                  내장 엔진은 브라우저에서 <span className="font-semibold">공개 번역 서비스를 직접 호출</span>합니다.
                  기기 안에서만 도는 것이 아니며, 문서화되지 않은 경로라 응답이 수 초까지 느려지거나 차단될 수 있습니다.
                  또한 <span className="font-semibold">번역 모드(문학·학술 등)와 학습 분석은 적용되지 않습니다</span> — 이 기능들은 AI 엔진에서만 동작합니다.
                </span>
              </div>
            )}
          </div>

          {/* Translation proxy — the recommended way to use an AI engine */}
          <div className="p-4 rounded-2xl bg-gray-50 border border-gray-200">
            <label className="block text-xs font-bold text-gray-700 uppercase tracking-wider mb-1.5 flex items-center gap-1.5">
              <ShieldCheck className="w-4 h-4 text-emerald-600" />
              번역 프록시 (권장)
            </label>
            <p className="text-[11px] text-gray-500 mb-2">
              API 키를 서버에 보관하는 중계 주소입니다. 설정하면 <span className="font-semibold">브라우저에 키를 저장하지 않고</span> AI 엔진을 쓸 수 있습니다.
              직접 배포하는 방법은 저장소의 <code className="px-1 rounded bg-gray-200 font-mono">worker/README.md</code>에 있습니다.
            </p>
            <input
              type="url"
              inputMode="url"
              placeholder="https://fluentlive-proxy.<계정>.workers.dev"
              value={formData.proxyUrl}
              onChange={(e) => setFormData({ ...formData, proxyUrl: e.target.value })}
              className="w-full bg-white border border-gray-300 rounded-xl px-3.5 py-2 text-xs text-gray-800 placeholder-gray-400 outline-none focus:border-emerald-500 transition font-mono"
            />
            {usingProxy && (
              <p className="mt-2 flex items-center gap-1.5 text-[11px] font-semibold text-emerald-700">
                <Check className="w-3.5 h-3.5" />
                프록시를 사용합니다 — 아래 API 키는 필요하지 않으며 전송되지 않습니다.
              </p>
            )}
          </div>

          {/* Gemini API Key */}
          {formData.engine.startsWith('gemini') && !usingProxy && (
            <div className="p-4 rounded-2xl bg-gray-50 border border-gray-200">
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs font-bold text-gray-700 uppercase tracking-wider flex items-center gap-1.5">
                  <Key className="w-4 h-4 text-indigo-600" />
                  Gemini API Key
                </label>
                <a
                  href="https://aistudio.google.com/app/apikey"
                  target="_blank"
                  rel="noreferrer"
                  className="text-[11px] text-indigo-600 hover:underline flex items-center gap-1"
                >
                  <span>키 발급받기 (무료)</span>
                  <ExternalLink className="w-3 h-3" />
                </a>
              </div>
              <input
                type="password"
                placeholder="AIzaSy... (비워 두면 내장 엔진으로 작동)"
                value={formData.geminiApiKey}
                onChange={(e) => setFormData({ ...formData, geminiApiKey: e.target.value })}
                className="w-full bg-white border border-gray-300 rounded-xl px-3.5 py-2 text-xs text-gray-800 placeholder-gray-400 outline-none focus:border-indigo-500 transition font-mono"
              />
              <p className="text-[11px] text-amber-700 mt-1.5 flex items-start gap-1">
                <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0 text-amber-600" />
                <span>
                  키는 이 브라우저에 저장되고 <span className="font-semibold">브라우저에서 직접 Google로 전송</span>됩니다.
                  공용 PC에서는 사용하지 마시고, 가능하면 위의 번역 프록시를 쓰세요.
                </span>
              </p>
            </div>
          )}

          {/* OpenAI API Key — the engine was selectable with no way to enter one. */}
          {formData.engine === 'gpt-4o-mini' && !usingProxy && (
            <div className="p-4 rounded-2xl bg-gray-50 border border-gray-200">
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs font-bold text-gray-700 uppercase tracking-wider flex items-center gap-1.5">
                  <Key className="w-4 h-4 text-indigo-600" />
                  OpenAI API Key
                </label>
                <a
                  href="https://platform.openai.com/api-keys"
                  target="_blank"
                  rel="noreferrer"
                  className="text-[11px] text-indigo-600 hover:underline flex items-center gap-1"
                >
                  <span>키 발급받기</span>
                  <ExternalLink className="w-3 h-3" />
                </a>
              </div>
              <input
                type="password"
                placeholder="sk-... (비워 두면 내장 엔진으로 작동)"
                value={formData.openaiApiKey}
                onChange={(e) => setFormData({ ...formData, openaiApiKey: e.target.value })}
                className="w-full bg-white border border-gray-300 rounded-xl px-3.5 py-2 text-xs text-gray-800 placeholder-gray-400 outline-none focus:border-indigo-500 transition font-mono"
              />
              <p className="text-[11px] text-amber-700 mt-1.5 flex items-start gap-1">
                <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0 text-amber-600" />
                <span>
                  키는 이 브라우저에 저장되고 <span className="font-semibold">브라우저에서 직접 OpenAI로 전송</span>됩니다.
                  가능하면 위의 번역 프록시를 쓰세요.
                </span>
              </p>
            </div>
          )}

          {/* Disfluency Filter Toggle */}
          <div className="p-4 rounded-2xl bg-gray-50 border border-gray-200 flex items-center justify-between">
            <div>
              <div className="text-xs font-bold text-gray-800 flex items-center gap-1.5">
                <Sparkles className="w-4 h-4 text-purple-600" />
                <span>말버릇 및 비문 자동 정제 (Disfluency Removal)</span>
              </div>
              <p className="text-[11px] text-gray-500 mt-0.5">
                발화 중 &lsquo;어...&rsquo;, &lsquo;음...&rsquo;, &lsquo;그...&rsquo;, &lsquo;you know&rsquo; 같은 군더더기를 실시간으로 걸러냅니다.
              </p>
            </div>
            <input
              type="checkbox"
              checked={formData.disfluencyFilter}
              onChange={(e) => setFormData({ ...formData, disfluencyFilter: e.target.checked })}
              className="w-5 h-5 rounded accent-indigo-600 cursor-pointer"
            />
          </div>

          {/* Speculative (interim) translation */}
          <div className="p-4 rounded-2xl bg-gray-50 border border-gray-200 flex items-start justify-between gap-3">
            <div>
              <div className="text-xs font-bold text-gray-800 flex items-center gap-1.5">
                <Zap className="w-4 h-4 text-amber-500" />
                <span>선행 번역 (말하는 도중 미리 번역)</span>
              </div>
              <p className="text-[11px] text-gray-500 mt-0.5">
                문장이 끝나기를 기다리지 않고 인식 중인 문장을 미리 번역해 &lsquo;잠정 번역&rsquo;으로 보여준 뒤, 발화가 끝나면 최종 번역으로 교체합니다. 체감 지연이 크게 줄지만 번역 호출 횟수가 늘어납니다.
              </p>
            </div>
            <input
              type="checkbox"
              checked={formData.speculativeTranslation}
              onChange={(e) => setFormData({ ...formData, speculativeTranslation: e.target.checked })}
              className="w-5 h-5 mt-0.5 rounded accent-indigo-600 cursor-pointer shrink-0"
            />
          </div>

          {/* Two-way auto language detection */}
          <div className="p-4 rounded-2xl bg-gray-50 border border-gray-200 flex items-start justify-between gap-3">
            <div>
              <div className="text-xs font-bold text-gray-800 flex items-center gap-1.5">
                <Repeat className="w-4 h-4 text-teal-600" />
                <span>양방향 자동 언어 감지</span>
              </div>
              <p className="text-[11px] text-gray-500 mt-0.5">
                대화 상대가 언어를 바꾸면 다음 발화부터 통역 방향을 자동으로 전환합니다 (스왑 버튼 자동화). AI 엔진(Gemini/OpenAI) 설정이 필요합니다.
              </p>
            </div>
            <input
              type="checkbox"
              checked={formData.autoDetectLanguage}
              onChange={(e) => setFormData({ ...formData, autoDetectLanguage: e.target.checked })}
              className="w-5 h-5 mt-0.5 rounded accent-teal-600 cursor-pointer shrink-0"
            />
          </div>

          {/* Latency-based engine auto-switch */}
          <div className="p-4 rounded-2xl bg-gray-50 border border-gray-200 flex items-start justify-between gap-3">
            <div>
              <div className="text-xs font-bold text-gray-800 flex items-center gap-1.5">
                <Gauge className="w-4 h-4 text-orange-500" />
                <span>지연 시 엔진 자동 전환</span>
              </div>
              <p className="text-[11px] text-gray-500 mt-0.5">
                Gemini Flash 응답이 계속 느려지면 자동으로 Flash-Lite로 전환하고, 속도가 회복되면 다시 되돌립니다.
              </p>
            </div>
            <input
              type="checkbox"
              checked={formData.autoEngineSwitch}
              onChange={(e) => setFormData({ ...formData, autoEngineSwitch: e.target.checked })}
              className="w-5 h-5 mt-0.5 rounded accent-orange-500 cursor-pointer shrink-0"
            />
          </div>

          {/* Whisper STT fallback */}
          <div className="p-4 rounded-2xl bg-gray-50 border border-gray-200 flex items-start justify-between gap-3">
            <div>
              <div className="text-xs font-bold text-gray-800 flex items-center gap-1.5">
                <Mic className="w-4 h-4 text-rose-500" />
                <span>STT 안정성 폴백 (Whisper)</span>
              </div>
              <p className="text-[11px] text-gray-500 mt-0.5">
                브라우저 음성인식이 지원되지 않거나(Safari 등) 반복 실패하면 OpenAI Whisper로 자동 전환합니다. 번역 프록시 설정이 필요하며, 별도 API 사용량 과금이 발생합니다.
              </p>
            </div>
            <input
              type="checkbox"
              checked={formData.sttFallbackEnabled}
              onChange={(e) => setFormData({ ...formData, sttFallbackEnabled: e.target.checked })}
              className="w-5 h-5 mt-0.5 rounded accent-rose-500 cursor-pointer shrink-0"
            />
          </div>

          {/* Conference screen display */}
          <div className="p-4 rounded-2xl bg-gray-50 border border-gray-200 space-y-3">
            <div className="text-xs font-bold text-gray-800 flex items-center gap-1.5">
              <Monitor className="w-4 h-4 text-slate-600" />
              <span>자막 화면 표시</span>
            </div>

            <div>
              <p className="text-[11px] text-gray-500 mb-1.5">자막 글자 크기 (대화면·컨퍼런스용)</p>
              <div className="grid grid-cols-4 gap-2">
                {(['sm', 'base', 'lg', 'xl'] as const).map((size) => (
                  <button
                    key={size}
                    type="button"
                    onClick={() => setFormData({ ...formData, fontSize: size })}
                    className={`py-2 rounded-xl border font-bold transition ${
                      formData.fontSize === size
                        ? 'bg-indigo-600 text-white border-indigo-500'
                        : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
                    } ${FONT_SIZE_PREVIEW[size]}`}
                  >
                    {FONT_SIZE_LABEL[size]}
                  </button>
                ))}
              </div>
            </div>

            <label className="flex items-start justify-between gap-3 cursor-pointer">
              <div>
                <div className="text-xs font-bold text-gray-800">원문 함께 보기 (Bilingual)</div>
                <p className="text-[11px] text-gray-500 mt-0.5">
                  끄면 원문 인식 패널을 감추고 번역 자막이 화면 전체를 씁니다.
                </p>
              </div>
              <input
                type="checkbox"
                checked={formData.bilingualDisplay}
                onChange={(e) => setFormData({ ...formData, bilingualDisplay: e.target.checked })}
                className="w-5 h-5 mt-0.5 rounded accent-indigo-600 cursor-pointer shrink-0"
              />
            </label>

            <label className="flex items-start justify-between gap-3 cursor-pointer">
              <div>
                <div className="text-xs font-bold text-gray-800">어두운 화면 (Dark Stage)</div>
                <p className="text-[11px] text-gray-500 mt-0.5">
                  대화 화면을 검은 배경에 흰 글씨로 표시합니다. 어두운 회의실이나 프로젝터 투사에 적합합니다.
                </p>
              </div>
              <input
                type="checkbox"
                checked={formData.darkStage}
                onChange={(e) => setFormData({ ...formData, darkStage: e.target.checked })}
                className="w-5 h-5 mt-0.5 rounded accent-indigo-600 cursor-pointer shrink-0"
              />
            </label>
          </div>

          {/* Auto TTS & Speed */}
          <div className="p-4 rounded-2xl bg-gray-50 border border-gray-200 space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-xs font-bold text-gray-800 flex items-center gap-1.5">
                  <Volume2 className="w-4 h-4 text-pink-600" />
                  <span>번역 완료 시 자동 음성 재생 (Auto-TTS)</span>
                </div>
                <p className="text-[11px] text-gray-500 mt-0.5">
                  문장 번역이 완료되면 원어민 발음으로 즉시 들려줍니다.
                </p>
              </div>
              <input
                type="checkbox"
                checked={formData.autoTts}
                onChange={(e) => setFormData({ ...formData, autoTts: e.target.checked })}
                className="w-5 h-5 rounded accent-pink-600 cursor-pointer"
              />
            </div>

            {formData.autoTts && (
              <div>
                <p className="text-[11px] text-gray-500 mb-1.5">음성 합성(TTS) 엔진</p>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setFormData({ ...formData, ttsProvider: 'browser' })}
                    className={`p-2.5 rounded-xl border text-left transition ${
                      formData.ttsProvider === 'browser'
                        ? 'bg-indigo-50 border-indigo-500 text-gray-900'
                        : 'bg-white border-gray-200 text-gray-500 hover:border-gray-300'
                    }`}
                  >
                    <span className="text-xs font-bold block">브라우저 기본</span>
                    <span className="text-[10px] text-gray-500">무료, 즉시 재생</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setFormData({ ...formData, ttsProvider: 'openai' })}
                    className={`p-2.5 rounded-xl border text-left transition ${
                      formData.ttsProvider === 'openai'
                        ? 'bg-indigo-50 border-indigo-500 text-gray-900'
                        : 'bg-white border-gray-200 text-gray-500 hover:border-gray-300'
                    }`}
                  >
                    <span className="text-xs font-bold block">OpenAI 고품질</span>
                    <span className="text-[10px] text-gray-500">프록시 필요, 사용량 과금</span>
                  </button>
                </div>
                {formData.ttsProvider === 'openai' && !usingProxy && (
                  <p className="text-[11px] text-amber-700 mt-1.5 flex items-start gap-1">
                    <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0 text-amber-600" />
                    <span>번역 프록시가 설정되지 않아 브라우저 기본 음성으로 자동 대체됩니다.</span>
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Slack meeting-summary webhook */}
          <div className="p-4 rounded-2xl bg-gray-50 border border-gray-200">
            <label className="block text-xs font-bold text-gray-700 uppercase tracking-wider mb-1.5 flex items-center gap-1.5">
              <Send className="w-4 h-4 text-emerald-600" />
              Slack 회의 요약 전송
            </label>
            <p className="text-[11px] text-gray-500 mb-2">
              내보내기 화면에서 생성한 회의 요약을 Slack 채널로 전송할 때 쓰입니다. Slack 앱 → Incoming Webhooks에서 발급받아 붙여넣으세요.
              이 값은 브라우저에만 저장되며, 전송에는 번역 프록시 설정이 필요합니다(Slack이 브라우저 직접 호출을 CORS로 차단합니다).
            </p>
            <input
              type="url"
              inputMode="url"
              placeholder="https://hooks.slack.com/services/..."
              value={formData.slackWebhookUrl}
              onChange={(e) => setFormData({ ...formData, slackWebhookUrl: e.target.value })}
              className="w-full bg-white border border-gray-300 rounded-xl px-3.5 py-2 text-xs text-gray-800 placeholder-gray-400 outline-none focus:border-emerald-500 transition font-mono"
            />
          </div>

          {/* Submit Button */}
          <div className="pt-2">
            <button
              type="submit"
              className="w-full flex items-center justify-center gap-2 py-3 rounded-2xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-sm transition shadow-lg shadow-indigo-600/30"
            >
              {isSaved ? <Check className="w-4 h-4" /> : <Settings className="w-4 h-4" />}
              <span>{isSaved ? '저장되었습니다!' : '설정 저장하기'}</span>
            </button>
          </div>

        </form>

      </div>
    </div>
  );
};
