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
- 옛 릴리스와 바뀐 점 파일(`notes-*.md`)은 지우지 않는다. 다운로드 수가 릴리스마다 따로 세어져서 지우면 그 수가 사라진다.

## 테스트

```
./test.sh           # swift test. CLT 에 Swift Testing 매크로 플러그인 경로를 직접 넘긴다
```

## 설명해줘 (화면 위 표시 + 설명 카드)

- 흐름: ScreenCaptureKit 스크린샷(우리 앱 창 제외) → Vision 글자 인식 → Groq 두 요청을 동시에 (`qwen3.8-27b` 이미지+글자로 짚을 줄 번호, `gpt-oss-120b` 글자로 요약·그림) → 투명 창에 ①②③, 설명 카드(WKWebView `Resources/web/explain.html`).
- AI 가 화면 좌표를 직접 말하게 하면 빗나간다. 글자 인식으로 찾은 줄 번호만 고르게 한다.
- 그림 형식은 과목을 가리지 않는 steps · table · card(KaTeX) · mermaid 네 가지. mermaid·KaTeX 는 `Resources/web` 에 넣어 두어 인터넷 없이 그린다.

## 데이터 위치 (`~/Library/Application Support/Ezrite/`)

| 파일 | 내용 |
|---|---|
| `groq_key` | Groq API 키 (권한 0600). 없으면 옛 앱 `settings.json` 에서 한 번 옮겨 온다 |
| `notes/autosave/*.txt` | 받아쓰기 자동 저장. 옛 앱과 같은 폴더·형식 (번역은 네 칸 들여쓰기, `── ` 은 끊김 표시). 30일 지나면 실행 시 삭제 |

API 키를 키체인에 두지 않는 이유: 자체 서명 앱은 빌드마다 키체인이 다른 앱으로 보고 로그인 암호를 다시 묻는다.

## 개발용 환경변수

| 변수 | 효과 |
|---|---|
| `EZRITE_TESTFILE=<16kHz mono wav>` | 실행하자마자 그 파일을 소리처럼 흘려 넣는다. 권한 없이 VAD→Groq→저장→알약을 확인할 때 |
| `EZRITE_EXPLAIN=<초>` | 그 초가 지나면 "설명해줘"를 한 번 누른다. 마우스가 있는 화면이 Groq 로 전송되니 시험용 화면을 띄워 두고 쓴다 |
| `EZRITE_CARD=<json>` | AI 없이 설명 카드에 그 내용(`{summary, marks, visuals}`)을 띄운다. 그림 틀 모양 확인용 |
| `EZRITE_RETX=<기록.txt>` | 확인 창 없이 그 기록을 저장된 소리로 다시 받아 적는다 (원래 글은 휴지통으로) |
| `EZRITE_UPDATE_JSON=<json>` | GitHub 대신 그 릴리스 JSON 으로 새 버전 띠를 띄운다 (모양 확인용) |
| `EZRITE_ASK=<질문>` | `EZRITE_EXPLAIN` 설명이 뜬 6초 뒤 질문 칸에 그 질문을 넣고 묻는다 |
| `EZRITE_SCRIPT=pop@1;choose@3;source@5=Google Chrome;start@7;explain@40;stop@60` | 정해 둔 시각(초)에 팝업 열기·녹음 말풍선·소리 출처·시작·설명해줘·끝내기를 한다. 홍보 영상 녹화용(`promo/`). `EZRITE_TESTFILE` 소리를 흘려 넣고, 이때는 바로 시작하지 않는다 |
| `EZRITE_SPEED=2` | 위 파일을 2배속으로 흘린다 |
| `EZRITE_PREVIEW=mini\|live\|history\|record\|settings\|onboarding` | onboarding 은 처음 쓰는 사람 안내 창. record 는 가장 최근 기록을 연 화면. mini 는 메뉴바 팝업을 연다. 나머지는 전체 창을 그 탭으로 연다 |

이 변수들은 실행 파일을 직접 실행할 때만 먹는다: `EZRITE_TESTFILE=... "/Applications/Ezrite.app/Contents/MacOS/Ezrite"`
