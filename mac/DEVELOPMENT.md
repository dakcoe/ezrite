# Ezrite (Swift) — 개발 메모

옛 Python 앱(지금은 지움)을 대체하는 mac 전용 네이티브 앱. 메뉴바 아이콘을 누르면 작은 팝업(지금 받아 적는 내용)이 뜨고 다시 누를 때까지 떠 있다(MenuBarExtra 는 바깥을 누르면 닫혀서 NSStatusItem + 패널로 직접 만든다). 그 안의 ⚙ 버튼으로 전체 창(실시간 / 지난 기록 / 설정)을 설정 화면으로 연다. 색은 시스템 라이트·다크를 따른다.

## 빌드

```
./build.sh          # swift build → build/Ezrite.app → 서명 → /Applications 로 옮겨 설치 (켜져 있으면 먼저 정상 종료)
open -a "Ezrite"
```

- **Xcode 없음, Command Line Tools 만 있다.** SwiftUI 미리보기는 못 쓴다.
- **`@State` 를 쓰지 않는다.** macOS 26 SDK 에서 매크로가 됐고 CLT 에는 그 플러그인이 없어 빌드가 깨진다. 화면 상태는 `ObservableObject` + `@StateObject`/`@Published` 로 둔다.
- **SwiftUI 뷰 안에 수식을 인라인으로 쓰지 않는다.** 타입 추론이 수 분씩 걸려 빌드가 멈춘다. 타입을 박은 헬퍼 함수로 뺀다. 느린 식 찾기: `swift build -Xswiftc -Xfrontend -Xswiftc -warn-long-expression-type-checking=300`
- 서명 인증서: 로그인 키체인의 `StudyAI Dev Signing` (자체 서명, 2036년 만료). 서명이 빌드마다 같아서 마이크·화면 녹화 권한이 유지된다. 지워졌으면 같은 이름으로 Code Signing 인증서를 다시 만든다. 다른 이름의 인증서를 쓰려면 `EZRITE_SIGN_ID="이름" ./build.sh`.
- 권한 테스트는 반드시 `open` 으로 띄운다. 셸에서 실행 파일을 바로 실행하면 권한 요청이 터미널 앱에 붙는다. 화면 녹화는 처음 허용한 뒤 앱을 한 번 다시 켜야 잡힌다.

## 배포

```
./release.sh 0.9.1 notes.md        # 테스트 → 버전 올림 → Apple·Intel 겸용 빌드 → DMG → GitHub 릴리스
./release.sh 0.9.1 notes.md --dry  # DMG 까지만
```

- 저장소는 Info.plist 의 `EzriteUpdateRepo`. 앱은 켤 때와 6시간마다 그 저장소의 `releases/latest` 를 보고, 앱 버전보다 높으면 팝업 위에 "새 버전" 띠를 띄운다. [받기] 는 DMG 링크를 연다.
- `releases/latest` 는 prerelease 를 건너뛰므로 시험판(0.x)도 prerelease 로 표시하지 않는다. 앱이 로그인 없이 읽으려면 저장소가 공개여야 한다.
- 자체 서명이라 받는 사람은 처음 한 번 "그래도 열기"가 필요하다 (DMG 안 `설치 안내.txt`).
- 공개 저장소 README 맨 위 다운로드 버튼 두 개는 버전이 박힌 파일 주소다. 릴리스마다 `v x.y.z` 와 파일 이름, 버튼 그림(`docs/download-*.svg`)의 버전을 바꾼다.
- 옛 릴리스와 바뀐 점 파일(`notes-*.md`)은 지우지 않는다. 다운로드 수가 릴리스마다 따로 세어져서 지우면 그 수가 사라진다.

## 테스트

```
./test.sh           # swift test. CLT 에 Swift Testing 매크로 플러그인 경로를 직접 넘긴다
```

## 설명해줘 (화면 위 표시 + 설명 카드)

- 흐름: ScreenCaptureKit 스크린샷(우리 앱 창 제외) → Vision 글자 인식 → Groq 두 요청을 동시에 (`qwen3.8-27b` 이미지+글자로 짚을 줄 번호, `gpt-oss-120b` 글자로 요약·그림) → 투명 창에 ①②③, 설명 카드(WKWebView `Resources/web/explain.html`).
- 카드 자리: 창은 건드리지 않는다(창 너비만 줄이면 웹페이지 오른쪽이 잘려서 화면 나누기를 없앴다). 새로 뜬 카드는 글자를 읽은 뒤 화면 글자를 가장 적게 가리는 자리로 옮긴다(`ExplainCard.freeSpot`, 늘어날 높이 60% 기준, 같으면 오른쪽 위). 사용자가 끌어 옮기면 그 자리를 지킨다. 제목 막대 오른쪽 접기 버튼(`NSTitlebarAccessoryViewController`)은 지금 자막 두 줄만 남기고(explain.html `fold()`, `body.folded`), 펼치면 접기 전 높이로 돌린다. 새 설명이 오면 저절로 펼친다.
- 움직이는 그림(anim) 배치: row·column·cycle·layers(층=열)·grid(cols 칸)·graph(자료 값 좌표의 곡선·점, set 으로 옮기면 미끄러진다).
- 표시 방식(설정 "설명 표시 방식", `defaults` 키 `markStyle`, 기본 `trail`): `MarkStyle.swift` 가 13가지 목록·이름·설명. classic 만 예전 `MarksView.classic`(상자+번호+파란 경로)이고, 나머지는 `MarksRenderer.swift` 가 `TimelineView`+`Canvas` 로 그린다. 그리기가 끝나면(`settleTime`) 다시 그리기를 멈춘다. 카드(explain.html)도 같은 `style` 을 받아 목록 번호·색·지도·장면 목록을 바꾼다.
- 설정의 표시 방식 미리보기(`MarkStylePreview.swift`): 가상 화면 760×400 에 가짜 슬라이드·카드 자리를 그리고 실제 `MarksView` 를 그 위에 돌린다. 3.4초마다 장면 → 네 장면 뒤 전체 보기. hover 방식은 장면 중간에 마우스를 올린 것처럼, leader 는 카드 자리에서 선. 폭에 맞춰 줄여 보인다.
- 카드 ↔ 화면 표시 연결: 카드의 `data-ref` 에 마우스를 올리면 `hover` 메시지로 그 표시만 진하게(spotlight·highlighter·corners·hover·leader·trail). leader 는 카드 글 위치(`anchors`)를 받아 선을 긋는다. 메모·말풍선 자리는 다른 글자 줄(`others`)과 이미 놓은 메모를 피해 고른다.
- 장면 꼬리표(`tag`, 2~4단어): bubble·notes·pen 일 때만 AI 에게 요청한다(`GroqClient.sceneTags`). 없으면 자막 첫 마디로 대신한다.
- AI 가 화면 좌표를 직접 말하게 하면 빗나간다. 글자 인식으로 찾은 줄 번호만 고르게 한다.
- 그림 형식은 과목을 가리지 않는 steps · table · card(KaTeX) · mermaid · anim 다섯 가지. anim 은 물체(items)를 id 로 정의하고 단계(frames)마다 나타나기·강조·잇기·자리 바꾸기·글 바꾸기만 지시하는 움직이는 그림이다. 자리는 explain.html 이 layout(row·column·cycle)으로 계산한다 — AI 에게 좌표를 맡기지 않는다. mermaid·KaTeX 는 `Resources/web` 에 넣어 두어 인터넷 없이 그린다.

## 화면 번역 (실험 기능, 설정 "실험 기능" 을 켜야 팝업에 단추가 보인다)

- 흐름: 창 고르기(화면마다 전체 화면 패널, 마우스 아래 창 파랗게, 클릭 고름·Esc·오른쪽 클릭 취소. 메뉴바 앱은 앞으로 못 나와 키를 못 받으므로 Esc 는 고르는 동안만 `RegisterEventHotKey` 로 잡는다) → 그 창만 찍기(ScreenCaptureKit, 13 은 `OneFrame`) → Vision 글자 인식 → 줄 합치기 → 문단 묶기(칸 구분, 문서 흐름 규칙) → 문단 단위 번역 → 클릭 통과 투명 창에 원래 자리를 덮어 그림. 코드는 `ScreenTranslate.swift`(창·찍기·반복), `ScreenTranslateLayout.swift`(묶기·색·크기·그리기).
- 기억: 공백 정규화한 문단 글 → 번역. 스크롤해도 같은 문단은 다시 보내지 않는다. 0.5초마다 절반 해상도로 바뀜을 보고, 멈추면 다시 읽는다. 마우스를 올린 문단은 원문.
- 잘린 문단: 창 위·아래 끝, 또는 도구막대 같은 가로 경계(`Pixels.crossLines`)에 줄 높이 0.5배 안쪽으로 붙은 문단은 다 보일 때까지 보내지 않는다. 반쯤 가려진 줄은 글자 인식이 아예 못 읽으므로, 바로 위·아래 경계와 문단 사이(2.5배 안)에 다른 줄 없이 글자색 화소가 있어도 잘린 것으로 본다(`cutBlocks`). 잘린 조각을 보내면 모델이 앞뒤를 채워 넣는다.
- 모델: `GroqClient.screenModels` = gpt-oss-120b → qwen3.8-27b. 20b 는 긴 문맥에서 묶음 대부분을 영어 그대로 돌려줘서 뺐다. 그래도 절반 넘게 원문 그대로면 다시 묻고, 또 그러면 실패로 쳐서 기억하지 않는다(`ScreenTranslate.checked`). 무료 키는 모델마다 분당 8000 토큰이라 문맥에서 이번에 보내는 문단은 뺀다.
- 기록에는 개수·시간만 남긴다 (화면 글·번역 글 금지).

## 데이터 위치 (`~/Library/Application Support/Ezrite/`)

| 파일 | 내용 |
|---|---|
| `groq_key` | Groq API 키 (권한 0600). 없으면 옛 앱 `settings.json` 에서 한 번 옮겨 온다 |
| `notes/autosave/*.txt` | 받아쓰기 자동 저장. 옛 앱과 같은 폴더·형식 (번역은 네 칸 들여쓰기, `── ` 은 끊김 표시). 30일 지나면 실행 시 삭제 |

## 앱 기록 (`~/Library/Logs/Ezrite/`)

사용자가 겪은 문제를 나중에 되짚는 자료. 재현이 안 되는 버그는 먼저 여기를 본다.

| 파일 | 내용 |
|---|---|
| `ezrite-날짜.log` | 시작(버전·OS)·종료(단계별 시간), 녹음 시작·일시정지·이어서·끝(길이·줄 수)·출처 바꿈·자동 쉼·끊김·다시 연결, 받아쓰기 실패·5초 넘게 느린 것, 번역 실패, 소리 파일 닫기·합치기(시간·실패), 설명해줘·질문(시간·실패·Groq 대신), 업데이트 확인·설치 실패, Mac 잠자기·깨기·화면 잠금·발열. 줄 끝 `(main)` 은 화면 스레드 |
| `hang-시각.txt` | 화면(메인 스레드)이 3초 넘게 멈추면 그 순간 모든 스레드를 `/usr/bin/sample` 로 2초 뜬 것. 멈춘 줄이 `파일.swift:줄` 로 나온다. 로그에는 "멈춤 … 풀림 N초" 가 남는다 |

- 14일 지나면 실행할 때 지운다. 받아 적은 글·질문 글·AI 답 글·API 키는 남기지 않는다 (길이만)
- 같은 내용이 시스템 로그에도 간다: `/usr/bin/log show --predicate 'subsystem == "com.dakcoe.ezrite"' --last 1h`
- 앱 번들(`com.dakcoe.ezrite`)로 돌 때만 파일에 쓴다. 테스트는 쓰지 않는다. `EZRITE_NO_LOG=1` 이면 앱도 쓰지 않는다
- 멈춤 기록 시험: `EZRITE_SCRIPT=hang@8=5` (8초에 화면을 5초 멈춤)

API 키를 키체인에 두지 않는 이유: 자체 서명 앱은 빌드마다 키체인이 다른 앱으로 보고 로그인 암호를 다시 묻는다.

## 개발용 환경변수

| 변수 | 효과 |
|---|---|
| `EZRITE_TESTFILE=<16kHz mono wav>` | 실행하자마자 그 파일을 소리처럼 흘려 넣는다. 권한 없이 VAD→Groq→저장→알약을 확인할 때 |
| `EZRITE_EXPLAIN=<초>` | 그 초가 지나면 "설명해줘"를 한 번 누른다. 마우스가 있는 화면이 Groq 로 전송되니 시험용 화면을 띄워 두고 쓴다 |
| `EZRITE_CARD=<json>` | AI 없이 설명 카드에 그 내용(`{summary, marks, visuals}`)을 띄운다. 그림 틀 모양 확인용 |
| `EZRITE_RETX=<기록.txt>` | 확인 창 없이 그 기록을 저장된 소리로 다시 받아 적는다 (원래 글은 휴지통으로) |
| `EZRITE_UPDATE_JSON=<json>` | GitHub 대신 그 릴리스 JSON 으로 새 버전 띠를 띄운다 (모양 확인용) |
| `EZRITE_UPDATE_ZIP=<zip>` | `EZRITE_UPDATE_JSON` 과 함께. [업데이트] 가 이 zip 으로 바꿔 끼운다 (버전을 올려 같은 인증서로 다시 서명한 앱) |
| `EZRITE_ASK=<질문>` | `EZRITE_EXPLAIN` 설명이 뜬 6초 뒤 질문 칸에 그 질문을 넣고 묻는다 |
| `EZRITE_SCRIPT=pop@1;choose@3;source@5=Google Chrome;start@7;explain@40;pause@50;stop@60` | 정해 둔 시각(초)에 팝업 열기·녹음 말풍선·소리 출처·시작·설명해줘·일시정지(다시 누르면 이어서)·끝내기를 한다. 홍보 영상 녹화용(`promo/`). `EZRITE_TESTFILE` 소리를 흘려 넣고, 이때는 바로 시작하지 않는다 |
| `EZRITE_DEMO=<json>` | AI 없이 지금 화면을 찍어 글자 인식만 하고, JSON(`{summary, marks, path, scenes}`)의 글자를 인식한 줄에 맞춰 표시 방식을 띄운다. `"scene": 3` 은 시작 장면, `"all"` 은 전체 보기. `open -a Ezrite --env EZRITE_DEMO=...` 로도 먹는다. 방식은 `defaults write com.dakcoe.ezrite markStyle -string pen` |
| `EZRITE_SPEED=2` | 위 파일을 2배속으로 흘린다 |
| `EZRITE_TRANSLATE=<앱 이름 또는 번들 id>` | 창 고르기 없이 그 앱의 맨 앞 창으로 화면 번역을 시작한다. 그 창 글자가 Groq 로 전송된다 |
| `EZRITE_TRANSLATE_IMAGE=<png 또는 폴더>` | 앱을 띄우지 않고 그림(2배 해상도)마다 읽기·번역을 하고 끝낸다. 덮은 그림과 상자 그림(빨강 조각·초록 줄·파랑 문단)을 `EZRITE_TRANSLATE_OUT`(기본 `/tmp/ezrite-translate`)에 남기고 문단별 통계를 출력한다. `EZRITE_TRANSLATE_FAKE=1` 이면 AI 없이 "번역:" 만 붙인다. 기록을 더럽히지 않게 `EZRITE_NO_LOG=1` 과 같이 쓴다 |
| `EZRITE_PREVIEW=mini\|live\|history\|record\|settings\|onboarding` | onboarding 은 처음 쓰는 사람 안내 창. record 는 가장 최근 기록을 연 화면. mini 는 메뉴바 팝업을 연다. 나머지는 전체 창을 그 탭으로 연다 |

이 변수들은 실행 파일을 직접 실행할 때만 먹는다: `EZRITE_TESTFILE=... "/Applications/Ezrite.app/Contents/MacOS/Ezrite"`
