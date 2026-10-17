# Ezrite Windows판

강의 소리를 받아 적고, 영어·일본어 강의는 한국어로 옮겨 주는 트레이 앱입니다. 맥판 Ezrite 를 Windows 로 옮겼습니다
(화면 구조·간격·색·기록 형식은 맥판과 같습니다). 아래 명령은 모두 이 폴더(`windows/`)에서 실행합니다.

## 할 수 있는 것

- **받아쓰기** — 트레이 아이콘을 누르면 팝업이 열리고, ● 로 시작합니다. 소리 출처는 **프로그램 하나**(크롬·줌 등, 그 프로그램 소리만) 또는 **마이크**.
  "내 목소리도 함께"를 켜면 프로그램 소리에 기본 마이크를 섞어 받습니다. 녹음 중에 출처·언어·마이크 섞기를 바꾸면 같은 기록에 이어서 받고 바꾼 자리를 남깁니다.
  일시정지·이어 하기, 소리가 끊기면 저절로 다시 붙이기, 작은 창(최근 한 줄과 번역만).
- **번역** — 인식 언어가 한국어가 아니면 줄마다 한국어 번역을 아래에 붙입니다 (설정 → 자동 번역).
- **✨ 설명해줘** — 마우스가 있는 화면을 찍어 글자를 읽고(Windows OCR), 화면 사진·글자·최근 강의 말을 Groq 에 보내 설명을 받습니다.
  화면 위에 ①②③ 로 짚고, 오른쪽 설명 카드에서 장면별로 보여 주며 그림(단계·표·공식·관계도)을 그립니다. 카드 아래 칸에서 이어 묻기.
  설정 → AI 지침에 원하는 설명 방식을 적어 두면 함께 보냅니다. 설명 카드와 화면 표시는 녹화·화면 공유에 찍히지 않습니다.
- **기록** — 받아 적은 글(.txt)과 녹음 소리(.m4a)를 저절로 저장합니다. 지난 기록 탭에서 열어 이름 붙이기, 전체 듣기와 줄마다 듣기,
  복사·내보내기·폴더에서 보기·휴지통으로 지우기. 저장 위치를 바꿀 수 있고, 기본 위치의 기록은 30일 뒤 지웁니다.
- **남은 한도** — 팝업 아래 막대 세 개(받아쓰기·번역·화면 설명)가 Groq 무료 한도(호출 수와 하루 토큰·음성 시간 중 적게 남은 쪽)를 보여 주고,
  설명·질문을 몇 번 더 할 수 있는지 셉니다.
- **그 밖** — 처음 안내 창(키 넣기·마이크 권한), 사용 가이드(7장), 새 버전 알림, 로그인할 때 자동 실행, 화면 테마(설정 → 옵션: 시스템 설정 따르기·밝게·어둡게),
  Windows 11 22H2 이상은 Mica·Acrylic 바탕.
- **다른 AI 서비스** — 설정 → AI 서비스 키에 Claude·Gemini·GPT 키를 넣으면 기능별 AI 에서 번역·화면 설명에 고를 수 있습니다 (받아쓰기는 Groq).
  키를 저장하면 모델 목록을 받아 확인하고, 용도별로 실제로 답하는 모델을 기본으로 정합니다. 실패하면(키 오류 제외) Groq 로 대신합니다.
  유료 서비스로 돌린 기능은 팝업 아래 막대 대신 서비스 이름이 보입니다. 키는 `%APPDATA%\Ezrite\<서비스>_key` 에만 저장됩니다.
  실제 서비스로 직접 불러 보려면: 설정 → AI 서비스 키에 그 서비스 키를 넣고 [저장] → "연결됨 · 화면 설명 … · 번역 …" 이 뜨면,
  기능별 AI 에서 그 서비스를 고르고 녹음(번역)이나 ✨(화면 설명)을 써 봅니다.

맥판과 다른 점: 저장된 소리로 다시 받아 적기는 아직 없습니다.
"시스템 전체 소리" 출처 대신 프로그램을 하나씩 고릅니다.

## 구성

- `helper/` — Rust 로 만든 `ezrite-audio.exe`. 앱이 필요할 때 실행합니다.
  - `list` 창이 떠 있거나 소리를 내는 프로그램과 마이크 목록 (JSON)
  - `capture --pid N` 그 프로그램(과 하위 프로세스)의 소리만 받기 (WASAPI process loopback, Windows 10 Build 20348 이상 = Windows 11) · `capture --mic <id>`.
    16kHz mono s16le 를 stdout 으로 흘립니다
  - `ocr <그림> [--lang]` Windows.Media.Ocr 로 글자와 줄 상자 (언어를 안 정하면 한국어 → 사용자 언어 → 영어 순서로 설치된 것) · `encode --in pcm --out m4a` (Media Foundation AAC) · `corner --hwnd` (둥근 모서리)
- `app/` — Electron 앱
  - `main.js` 창·트레이·IPC, `explain-ui.js` 설명 카드·화면 표시 창·화면 찍기
  - `lib/` Electron 없이 시험하는 부분: VAD(`vad.js`), 받아쓰기·번역(`transcriber.js`, `groq.js`), 녹음 흐름(`live.js`, `mixer.js`),
    기록(`notes.js`, `recording.js`), 설명(`explain.js`, `groq-explain.js`, `explainer.js`), 한도(`usage.js`, `budget.js`), 새 버전(`updater.js`) 등
  - `renderer/` 화면 (팝업·전체 창·처음 안내·사용 가이드·설명 카드)

## 준비물

- Windows 10 이상. 프로그램별 소리 받기는 Windows 11 (Build 20348 이상)에서만 되고, Windows 10 에서는 마이크로 받는다
- 한글 화면 읽기(✨ 설명해줘)에는 Windows 의 한국어 글자 인식(OCR) 팩이 필요하다 (한국어 Windows 는 기본 포함, 없으면 설정 → 언어에 한국어 추가)
- Visual Studio Build Tools 2022 (C++를 사용한 데스크톱 개발, Windows SDK) · Rust stable (x86_64-pc-windows-msvc) · Node.js 20 이상
- 무료 Groq API 키 (https://console.groq.com/keys)

## 실행

```
npm --prefix app install
npm run build          # helper release 빌드 (helper/target/release/ezrite-audio.exe)
npm start              # 앱 실행 (트레이에 아이콘이 생긴다. 작업 표시줄 오른쪽 ^ 안에 있을 수 있다)
```

## 시험·검사

```
npm test               # cargo test + node --test (app/test/*.test.js)
npm run lint           # cargo clippy -D warnings + node --check
```

## 데이터 위치 (`%APPDATA%\Ezrite\`)

| 파일 | 내용 |
|---|---|
| `groq_key` | Groq API 키. 화면 쪽으로 보내지 않고, 로그·상태에도 싣지 않는다 |
| `settings.json` | 인식 언어·소리 출처·옵션·저장 위치·AI 지침 |
| `usage.json` | 하루 토큰·음성 시간 (맥 `usage.json` 과 같은 모양) |
| `notes\autosave\<시작시각>[_n][ 이름].txt` | 받아쓰기 기록. 맥과 같은 형식(원문 / 네 칸 들여쓴 번역 / `── ` 끊김 표시) |
| `… .m4a` | 녹음 소리 (AAC 48kHz mono 96kbps). 녹음 중에는 `.pcm` 에 이어 쓰고 끝낼 때 바꾼다. 앱이 죽어 남은 `.pcm` 은 다음 실행 때 바꾼다 |
| `… .times.json` | 줄마다 녹음 위치 (줄 옆 ▶ 로 그 줄만 듣기) |

설치한 앱은 Chromium 캐시를 `%LOCALAPPDATA%\Ezrite` 에 둡니다.

## 화면 확인용 환경 변수 (개발용)

| 변수 | 효과 |
|---|---|
| `EZRITE_PREVIEW=popover\|compact\|live\|history\|settings\|onboarding\|guide` | 그 화면을 예시 데이터로 바로 띄운다 |
| `EZRITE_DEMO_SCRIPT=<json>` | 시연 녹화용: 녹음을 누르면 소리·Groq 받아쓰기 대신 대본 줄이 차례로 뜬다 (`{"firstDelay":2,"interval":4.2,"translationDelay":0.9,"lines":[{"text":"…","ko":"…"}]}`). 녹음 파일은 무음, 설명해줘·질문은 실제 Groq |
| `EZRITE_THEME=light\|dark` | 테마 강제 (설정의 화면 테마보다 앞선다) |
| `EZRITE_SHOT=<경로.png>` | 다 그려진 뒤 창 내용을 불투명 PNG 로 저장하고 끝낸다 (재질 대신 단색) |
| `EZRITE_SHOT_DELAY=<ms>` · `EZRITE_SHOT_SCROLL=<px>` | 찍기 전에 기다리기 (기본 1200) · 설정·목록을 내리기 |
| `EZRITE_TEST_SCALE=1\|1.5\|2` | 화면 배율 흉내 (평소에는 Windows 배율 그대로) |
| `EZRITE_TESTFILE=<16kHz mono wav>` · `EZRITE_SPEED=4` | 켜자마자 그 파일을 프로그램 소리처럼 흘리며 받아쓰기 시작 (`node app/scripts/make-test-wav.js <경로>`). "내 목소리도 함께"가 켜져 있으면 진짜 마이크를 섞는다 |
| `EZRITE_FAKE_GROQ=1` | 네트워크 없는 가짜 Groq (예시 문장·번역·설명) |
| `EZRITE_EXPLAIN=<초>` · `EZRITE_ASK=<질문>` | 그 시간 뒤 "설명해줘"를 누른다 · 설명이 뜬 6초 뒤 그 질문을 묻는다 |
| `EZRITE_CARD=<json 또는 파일>` | AI 없이 설명 카드에 그 내용을 띄운다 (`EZRITE_SHOT` 과 함께면 카드를 찍는다) |
| `EZRITE_CAPTURABLE=1` | 설명 카드·화면 표시를 화면 캡처에 보이게 둔다 |
| `EZRITE_UPDATE_JSON=<json 또는 파일>` | GitHub 대신 그 릴리스 JSON 으로 "새 버전" 띠를 띄운다 |

```
cd app
node scripts/shots.js --out <폴더> --scale 1 --themes light,dark   # 화면마다 스크린샷 (맥과 같은 논리 크기)
npx electron scripts/make-tray-icon.js                              # assets/tray-*.ico
python scripts/make-app-icon.py <맥 AppIcon.icns>                   # assets/app.ico
```

## 설치 파일 만들기

```
npm run dist           # helper release 빌드 → 오픈소스 고지 → electron-builder(NSIS) → dist\Ezrite-Setup-<버전>.exe
```

- 사용자별 설치라 관리자 권한(UAC)을 묻지 않고 `%LOCALAPPDATA%\Programs\ezrite` 에 깔리며, 시작 메뉴에 바로가기를 만든다.
- 서명하지 않는다. 내려받은 설치 파일을 처음 열면 SmartScreen 경고가 뜬다 ([추가 정보] → [실행]).
- 제거해도 `%APPDATA%\Ezrite` (키·기록·설정)는 남긴다. Chromium 캐시와 설치 파일 사본(`%LOCALAPPDATA%\ezrite-updater`)은 지운다 (`app/build/installer.nsh`).
- 조용히 설치·제거: `Ezrite-Setup-<버전>.exe /S [/D=<폴더>]`, `"<설치 폴더>\Uninstall Ezrite.exe" /S`.
- `dist\` 는 커밋하지 않는다.

### 오픈소스 고지

설치 파일에 들어가는 남의 저작물(Pretendard, Lucide, KaTeX, Mermaid 와 그 안에 묶인 라이브러리, Electron/Chromium, helper 의 Rust 크레이트)의
라이선스는 `THIRD_PARTY_NOTICES.md` 에 있고, 같은 내용이 설치 폴더 `resources\ThirdPartyNotices.txt` 로 들어간다 (설정 → 버전 아래 "오픈소스 고지").
`npm run dist` 가 `app/scripts/make-notices.js` 로 다시 만든다. 바뀌었을 때:

- helper 크레이트: `cd helper && cargo about generate about.hbs -o ../app/build/notices/rust-licenses.txt` (`cargo install cargo-about --features cli`)
- Mermaid·KaTeX 를 바꾸면: 임시 폴더에서 `npm install --omit=dev mermaid@<버전> katex@<버전>` 뒤 `node app/scripts/make-notices.js --collect <그 node_modules>`

## 릴리스

맥판과 같은 릴리스로 나간다: 공개 저장소 `dakcoe/ezrite` (`app/package.json` 의 `ezriteUpdateRepo`) 의 `v<버전>` 릴리스 하나에
맥 DMG 와 Windows 설치 파일을 함께 올린다.

1. 버전을 맥판과 맞춰 올린다: `app/package.json`·`app/package-lock.json`·루트 `package.json`·`helper/Cargo.toml`(·`Cargo.lock`).
   앱이 보이는 버전과 설치 파일 이름이 `app/package.json` 에서 나온다.
2. `npm test` · `npm run lint` · `npm run dist`
3. `v<버전>` 릴리스에 `dist\Ezrite-Setup-<버전>.exe` 를 올린다. 바뀐 점은 릴리스 본문에 쓴다 (앞 세 줄이 팝업 "새 버전" 띠에 보인다).
   시험판도 prerelease 로 표시하지 않는다 (`releases/latest` 가 prerelease 를 건너뛴다).

앱은 켤 때와 6시간마다 `https://api.github.com/repos/<저장소>/releases/latest` 를 보고, 앱보다 높은 버전이면 팝업 위에 띠를 띄운다.
[받기] 는 릴리스의 `.exe` 링크를 브라우저로 연다. DMG 만 있으면(윈도우판을 아직 안 올렸으면) 릴리스 페이지를 연다. 저장소가 비공개면 GitHub 이 404 를 돌려주고, 이때는 아무것도 띄우지 않는다.

## 라이선스

MIT — [LICENSE](LICENSE). 함께 쓰는 오픈소스의 고지는 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
