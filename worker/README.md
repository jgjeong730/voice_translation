# FluentLive 번역 프록시 (Cloudflare Worker)

API 키를 서버에 두고 브라우저에는 노출하지 않기 위한 중계 서버입니다.

## 왜 필요한가

이 앱은 GitHub Pages 정적 배포라 서버가 없습니다. 그래서 원래는 브라우저가 직접 Gemini/OpenAI를 호출했고, 그 결과:

- **Gemini 키가 URL 쿼리스트링으로 전송**되어 브라우저 히스토리·확장프로그램·중간 프록시 로그에 남았습니다.
- 방문자마다 자기 키를 직접 넣어야 했고, 넣지 않으면 품질이 보장되지 않는 내장 엔진으로 떨어졌습니다.

이 Worker를 두면 키는 Cloudflare 쪽에만 존재하고, 방문자는 아무것도 입력하지 않아도 제대로 된 AI 번역을 씁니다.

## 배포 (약 5분)

Cloudflare 계정이 필요합니다. 무료 플랜으로 충분합니다 (하루 10만 요청).

```bash
cd worker
npm install

# 1) 로그인 (브라우저가 열립니다)
npx wrangler login

# 2) 허용할 출처를 본인 것으로 수정
#    wrangler.toml 의 ALLOWED_ORIGINS 를 편집하세요.
#    예: "https://<사용자명>.github.io,http://localhost:5173"

# 3) API 키를 secret 으로 등록 (입력값은 화면에 남지 않습니다)
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put OPENAI_API_KEY   # OpenAI 를 쓸 때만

# 4) 배포
npx wrangler deploy
```

배포가 끝나면 `https://fluentlive-proxy.<계정>.workers.dev` 형태의 주소가 출력됩니다.

## 앱에 연결하는 두 가지 방법

**(권장) 빌드에 포함 — 모든 방문자가 자동 적용**

GitHub 저장소 → Settings → Secrets and variables → Actions → **Variables** 탭 →
`PROXY_URL` 이름으로 위 주소를 추가하면 됩니다. 배포 워크플로가 자동으로 읽어 갑니다.
공개 URL이므로 Secret이 아니라 Variable로 넣으세요.

**(개인용) 설정 화면에 직접 입력**

앱의 ⚙️ 설정 → "번역 프록시" 칸에 주소를 붙여넣으면 그 브라우저에서만 적용됩니다.

## 이 Worker가 막아 주는 것

공개 엔드포인트 뒤에 유료 API 키를 두는 것이므로 다음 제한이 들어 있습니다.

| 항목 | 값 | 위치 |
|---|---|---|
| 출처 검사 | `ALLOWED_ORIGINS` (CORS + 서버측 검증) | `wrangler.toml` |
| 호출 가능 모델 | Gemini 2.5 Flash / Flash-Lite / 2.0 Flash, GPT-4o mini, Whisper-1, TTS-1 | `ALLOWED_*_MODELS` |
| 요청 본문 | 32 KB (오디오 업로드는 별도) | `MAX_BODY_BYTES` |
| 입력 길이 | 4,000자 (TTS는 2,000자) | `MAX_INPUT_CHARS` / `MAX_TTS_INPUT_CHARS` |
| 출력 토큰 | 1,024 | `MAX_OUTPUT_TOKENS` |
| 오디오 업로드 | 10 MB | `MAX_AUDIO_BYTES` |
| IP당 요청 | 60회 / 분 | `RATE_LIMIT` |

## 번역 외 엔드포인트

같은 `OPENAI_API_KEY`를 재사용하는 두 엔드포인트가 더 있습니다. 둘 다 별도 OpenAI 사용량 과금이 발생합니다.

- **`POST /openai/audio/transcriptions`** — Whisper STT. 브라우저의 `webkitSpeechRecognition`이 없거나(Safari/Firefox) 반복적으로 실패할 때(예: 사내망에서 Google 음성인식 서버가 막힌 경우) 앱이 자동으로 전환하는 대체 인식 경로입니다. `multipart/form-data`로 `file`(오디오 Blob) 필드를 받아 그대로 Whisper API에 전달합니다.
- **`POST /openai/audio/speech`** — TTS-1 음성 합성. 설정에서 "OpenAI 고품질" TTS를 선택했을 때만 호출됩니다.

그리고 AI 키와 무관한 릴레이가 하나 있습니다:

- **`POST /notify/slack`** — 회의 요약을 Slack Incoming Webhook으로 전달합니다. Slack의 웹훅 엔드포인트는 CORS 헤더를 보내지 않아 브라우저가 직접 호출할 수 없기 때문에 이 Worker를 경유합니다. `webhookUrl`이 `https://hooks.slack.com/services/...` 형식이 아니면 400으로 거부하므로, 이 라우트가 임의의 주소로 요청을 대신 보내주는 범용 프록시로 악용될 수는 없습니다.

**중요 — 레이트 리밋의 한계:** 코드의 IP 제한은 Worker isolate 메모리에 있습니다.
isolate는 지역별로 여러 개이고 수명이 짧아, 순간적인 폭주는 막아도 작정한 공격은 막지 못합니다.
실제 방어가 필요하면 Cloudflare 대시보드에서 WAF 규칙을 추가하세요 (코드 수정 불필요):

> Security → WAF → Rate limiting rules → `http.host eq "fluentlive-proxy.<계정>.workers.dev"` → 분당 N회 초과 시 Block

비용이 걱정되면 Google AI Studio / OpenAI 대시보드에서 **키 자체에 사용량 상한**을 걸어 두는 것이 가장 확실합니다.

## 확인

```bash
# 허용되지 않은 출처는 403 이어야 합니다
curl -i -X POST https://fluentlive-proxy.<계정>.workers.dev/gemini/gemini-2.5-flash \
  -H 'Origin: https://example.com' -H 'Content-Type: application/json' -d '{}'

# 허용된 출처는 통과합니다
curl -i -X POST https://fluentlive-proxy.<계정>.workers.dev/gemini/gemini-2.5-flash \
  -H 'Origin: https://<사용자명>.github.io' -H 'Content-Type: application/json' \
  -d '{"contents":[{"parts":[{"text":"안녕하세요"}]}]}'

# 로그 보기
npx wrangler tail
```
