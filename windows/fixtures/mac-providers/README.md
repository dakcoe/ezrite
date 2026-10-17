# 맥판이 실제로 쓰는 AI 서비스 요청·응답 (Windows 이식 기준)

맥 앱 코드(`mac/Sources/Ezrite/AI.swift`)가 만드는 요청을 그대로 꺼낸 것이다. 키는 `<KEY>`, 그림은 `<JPEG_BASE64>` 로 지웠다.
Claude 는 사용자 키로 실제로 불러 받은 응답(`response-claude-*.json`)과 맥이 읽은 결과(`parsed-*.txt`)까지 있다.
맥 사용자는 번역에 `claude-haiku-5-5`, 화면 설명·질문에 `claude-sonnet-5-5` 를 쓴다.

## 파일
| 파일 | 내용 |
|---|---|
| `request-<서비스>-translate.json` | 번역: json 아님, max 2000, Claude 는 thinking disabled |
| `request-<서비스>-explain.json` | 화면 설명: 그림 + json, max 3000 |
| `request-<서비스>-ask-retry-nothink.json` | 질문(두 번째 시도: 생각 단계 끔) |
| `request-<서비스>-check.json` | 키 저장 때 모델이 답하는지 확인 ("Say OK", max 16, thinking off) |
| `response-claude-models.json` | 모델 목록 (키 확인 겸) |
| `response-claude-{translate,explain,ask}-200.json` | 실제 응답 원문 |
| `response-claude-badkey-401.json` | 틀린 키 |
| `slide.jpg` | 설명·질문에 쓴 시험 슬라이드 |

## 맥과 꼭 같아야 하는 규칙
- **Claude**: `POST https://api.anthropic.com/v1/messages`, 헤더 `x-api-key`, `anthropic-version: 2023-06-01`. 그림은 텍스트보다 **앞**에 `{"type":"image","source":{"type":"base64","media_type":"image/jpeg","data":…}}`. JSON 전용 모드가 없어서 json 이면 프롬프트 끝에 `\nRespond with the JSON object only.` 를 붙이고, 받은 글에서 코드블록·앞뒤 말을 벗긴다(stripFences: ``` 안쪽 → 첫 `{` 부터 마지막 `}` 까지). 번역·확인·질문 재시도는 `"thinking":{"type":"disabled"}`. 응답 글 = `content[]` 중 type text 를 이어 붙임, 토큰 = input_tokens + output_tokens.
- **GPT / Gemini (/ Groq)**: OpenAI 호환 `POST <base>/chat/completions`, `Authorization: Bearer`. base: OpenAI `https://api.openai.com/v1`, Gemini `https://generativelanguage.googleapis.com/v1beta/openai`. 그림은 텍스트 **뒤**에 `image_url` data URL. json 이면 `response_format: {"type":"json_object"}`. **GPT 는 `max_completion_tokens`**, 나머지는 `max_tokens`. 응답 글 = `choices[0].message.content`, 토큰 = `usage.total_tokens`.
- **모델 목록**: Claude `GET https://api.anthropic.com/v1/models?limit=100`(같은 헤더), OpenAI `/v1/models`, Gemini `/v1beta/openai/models`(id 앞의 `models/` 를 뗀다). 결과 `data[].id` 정렬.
- **키 오류**: 401·403 이면 키 오류. Gemini 는 틀린 키에 **400 + "API key"** 를 준다 → 이것도 키 오류. 오류 설명은 `error.message` (Gemini 는 `[{"error":…}]` 배열로 감싸기도 함).
- **Groq 로 대신하기**: 키 오류(401·403)만 빼고는 실패하면 Groq 로 대신하고 알림을 띄운다. 응답이 60초 안에 안 오면(상태 없음) 역시 Groq 로.
- **시간 제한**: 요청 60초(전체), 키 확인 15초(전체). 연결만 붙들고 답을 안 주는 모델(Gemini 무료 등급 일부)이 있어서 "응답 멈춤 시간"이 아니라 전체 시간으로 끊는다.
- **기본 모델 고르기 (ranked/pick)**: 이름 꼴 `^claude-(opus|sonnet|haiku)-\d+(-\d+)?$`, `^gemini-\d+(\.\d+)?-(pro|flash)(-preview)?$`, `^gpt-\d+(\.\d+)?(-mini|-nano|-[a-z]+)?$` 만. GPT 의 -pro·-codex·-search·-chat·-audio·-realtime·-image·-transcribe·-tts 는 뺀다. 설명: sonnet → pro → gpt-*-sol → 큰 gpt. 번역: haiku → flash → gpt-*-luna → gpt-*-mini. 같은 등급 안에서는 버전 높은 순, 정식판이 preview 보다 먼저. 키 저장 때 앞에서부터 최대 4개를 "Say OK" 로 불러 보고 처음 답하는 모델을 쓴다.
- **번역**: 프롬프트 = `translatePrompt + "\n\n" + translationInput(lines, context)`, 응답은 Groq 와 같은 `parse`(번호가 하나 밀리면 첫 줄 버림).
- **설명**: 프롬프트 = `unifiedPrompt(lines, transcript)` (groqRules 는 **안 붙인다**), 그림은 1280px 폭 JPEG.
- **질문**: `questionPrompt(...)`, 답을 못 읽으면 thinking 끄고 한 번 더.
- **유료 서비스 표시**: 한도 막대 대신 서비스 이름. 남은 횟수(설명·질문)는 Groq 일 때만.
