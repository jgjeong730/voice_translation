import React, { useState } from 'react';
import {
  X,
  Download,
  FileText,
  FileCode,
  FileSpreadsheet,
  Check,
  Copy,
  Sparkles,
  Send,
  Loader2,
  AlertTriangle,
} from 'lucide-react';
import type { AppSettings, MeetingSummary, TranslationItem } from '../types';
import { translationService } from '../services/translator';

interface ExportModalProps {
  isOpen: boolean;
  items: TranslationItem[];
  settings: AppSettings;
  onClose: () => void;
}

/** Wrap a field in quotes (doubling any inner quote) only when it needs it. */
function escapeCsvField(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export const ExportModal: React.FC<ExportModalProps> = ({
  isOpen,
  items,
  settings,
  onClose,
}) => {
  const [copied, setCopied] = useState(false);
  const [summary, setSummary] = useState<MeetingSummary | null>(null);
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [isSendingSlack, setIsSendingSlack] = useState(false);
  const [slackStatus, setSlackStatus] = useState<'idle' | 'sent' | 'error'>('idle');
  const [slackError, setSlackError] = useState<string | null>(null);

  if (!isOpen) return null;

  const generateMarkdown = (): string => {
    let md = `# FluentLive 실시간 통번역 & 영어 학습 기록\n\n`;
    md += `* 일시: ${new Date().toLocaleString()}\n`;
    md += `* 총 번역 문장 수: ${items.length}개\n\n---\n\n`;

    items.forEach((item, idx) => {
      md += `### ${idx + 1}. [${item.mode.toUpperCase()}] ${new Date(item.timestamp).toLocaleTimeString()}\n`;
      md += `* **원문:** ${item.sourceText}\n`;
      md += `* **번역:** ${item.translatedText}\n`;

      if (item.learningDetails) {
        if (item.learningDetails.naturalAlternative) {
          md += `* **원어민 추천 표현:** ${item.learningDetails.naturalAlternative}\n`;
        }
        if (item.learningDetails.grammarTip) {
          md += `* **문법/뉘앙스 팁:** ${item.learningDetails.grammarTip}\n`;
        }
        if (item.learningDetails.keyVocabulary?.length) {
          md += `* **핵심 어휘:**\n`;
          item.learningDetails.keyVocabulary.forEach(v => {
            md += `  - ${v.word} (${v.ipa || ''}): ${v.meaning}\n`;
          });
        }
      }
      md += `\n---\n\n`;
    });

    return md;
  };

  /** Plain prose, unlike `generateMarkdown()` — no `#`/`*` syntax, just readable text. */
  const generatePlainText = (): string => {
    let out = `FluentLive 실시간 통번역 기록\n`;
    out += `일시: ${new Date().toLocaleString()}\n`;
    out += `총 번역 문장 수: ${items.length}개\n\n`;

    items.forEach((item, idx) => {
      out += `${idx + 1}. [${item.mode.toUpperCase()}] ${new Date(item.timestamp).toLocaleTimeString()}\n`;
      out += `원문: ${item.sourceText}\n`;
      out += `번역: ${item.translatedText}\n\n`;
    });

    return out;
  };

  const generateCsv = (): string => {
    const header = ['#', '시간', '모드', '원문언어', '번역언어', '원문', '번역', '지연(ms)'];
    const rows = items.map((item, idx) => [
      String(idx + 1),
      new Date(item.timestamp).toLocaleString(),
      item.mode,
      item.sourceLang,
      item.targetLang,
      item.sourceText,
      item.translatedText,
      item.latencyMs != null ? String(item.latencyMs) : '',
    ]);

    return [header, ...rows]
      .map(row => row.map(escapeCsvField).join(','))
      .join('\n');
  };

  const handleDownload = (content: string, extension: string, mimeType: string) => {
    const blob = new Blob([content], { type: `${mimeType};charset=utf-8;` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `FluentLive_Transcript_${new Date().toISOString().slice(0, 10)}.${extension}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleCopyClipboard = () => {
    navigator.clipboard.writeText(generateMarkdown());
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleGenerateSummary = async () => {
    setIsSummarizing(true);
    setSummaryError(null);
    setSlackStatus('idle');
    try {
      const result = await translationService.generateMeetingSummary(items, settings);
      setSummary(result);
    } catch (err) {
      setSummaryError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSummarizing(false);
    }
  };

  const handleSendSlack = async () => {
    if (!summary) return;
    setIsSendingSlack(true);
    setSlackStatus('idle');
    setSlackError(null);
    try {
      const lines = [
        `*FluentLive 회의 요약* (${new Date().toLocaleString()})`,
        summary.summary,
      ];
      if (summary.actionItems.length > 0) {
        lines.push('', '*액션 아이템*', ...summary.actionItems.map(a => `• ${a}`));
      }
      await translationService.sendSlackNotification(settings.slackWebhookUrl, lines.join('\n'), settings.proxyUrl);
      setSlackStatus('sent');
    } catch (err) {
      setSlackStatus('error');
      setSlackError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSendingSlack(false);
    }
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
            <Download className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
              통번역 스크립트 & 학습 노트 내보내기
            </h2>
            <p className="text-xs text-gray-500">대화 기록과 AI 문법/어휘 분석 노트를 원하는 포맷으로 저장하세요.</p>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto pr-1 space-y-5">
          {/* AI meeting summary */}
          <div className="rounded-2xl bg-gray-50 border border-gray-200 p-4">
            <div className="flex items-center justify-between gap-2">
              <div className="text-xs font-bold text-gray-800 flex items-center gap-1.5">
                <Sparkles className="w-4 h-4 text-purple-600" />
                <span>AI 회의 요약</span>
              </div>
              <button
                onClick={() => void handleGenerateSummary()}
                disabled={isSummarizing || items.length === 0}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold text-[11px] transition"
              >
                {isSummarizing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                <span>{summary ? '다시 생성' : '요약 생성'}</span>
              </button>
            </div>

            {summaryError && (
              <p className="mt-2 flex items-start gap-1.5 text-[11px] text-rose-700">
                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span>{summaryError}</span>
              </p>
            )}

            {summary && (
              <div className="mt-3 space-y-2">
                <p className="text-xs text-gray-700 leading-relaxed whitespace-pre-wrap">{summary.summary}</p>
                {summary.actionItems.length > 0 && (
                  <ul className="text-xs text-gray-700 list-disc pl-4 space-y-0.5">
                    {summary.actionItems.map((a, i) => <li key={i}>{a}</li>)}
                  </ul>
                )}

                {settings.slackWebhookUrl.trim() && (
                  <div className="pt-1">
                    <button
                      onClick={() => void handleSendSlack()}
                      disabled={isSendingSlack}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-semibold text-[11px] transition"
                    >
                      {isSendingSlack ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                      <span>Slack으로 전송</span>
                    </button>
                    {slackStatus === 'sent' && (
                      <p className="mt-1.5 text-[11px] font-semibold text-emerald-700">Slack에 전송했습니다.</p>
                    )}
                    {slackStatus === 'error' && (
                      <p className="mt-1.5 text-[11px] text-rose-700">{slackError}</p>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Preview Box */}
          <div className="rounded-2xl bg-gray-50 border border-gray-200 p-4 max-h-48 overflow-y-auto font-mono text-xs text-gray-700 whitespace-pre-wrap">
            {generateMarkdown()}
          </div>

          {/* Action Buttons */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
            <button
              onClick={() => handleDownload(generateMarkdown(), 'md', 'text/markdown')}
              className="flex items-center justify-center gap-2 p-3 rounded-2xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs transition shadow-lg shadow-indigo-600/30"
            >
              <FileCode className="w-4 h-4" />
              <span>Markdown</span>
            </button>

            <button
              onClick={() => handleDownload(generatePlainText(), 'txt', 'text/plain')}
              className="flex items-center justify-center gap-2 p-3 rounded-2xl bg-gray-100 hover:bg-gray-200 text-gray-700 font-bold text-xs transition border border-gray-200"
            >
              <FileText className="w-4 h-4" />
              <span>텍스트</span>
            </button>

            <button
              onClick={() => handleDownload(generateCsv(), 'csv', 'text/csv')}
              className="flex items-center justify-center gap-2 p-3 rounded-2xl bg-gray-100 hover:bg-gray-200 text-gray-700 font-bold text-xs transition border border-gray-200"
            >
              <FileSpreadsheet className="w-4 h-4" />
              <span>CSV</span>
            </button>

            <button
              onClick={handleCopyClipboard}
              className="flex items-center justify-center gap-2 p-3 rounded-2xl bg-gray-100 hover:bg-gray-200 text-gray-700 font-bold text-xs transition border border-gray-200"
            >
              {copied ? <Check className="w-4 h-4 text-emerald-600" /> : <Copy className="w-4 h-4" />}
              <span>{copied ? '복사됨!' : '복사'}</span>
            </button>
          </div>
        </div>

      </div>
    </div>
  );
};
