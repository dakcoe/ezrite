#!/bin/bash
# swift build → build/Ezrite.app 으로 묶고 고정 인증서로 서명한다.
# 서명이 매번 같아야 마이크·화면 녹화 권한이 재빌드 후에도 유지된다.
set -euo pipefail
cd "$(dirname "$0")"

IDENTITY="${EZRITE_SIGN_ID:-StudyAI Dev Signing}"   # 다른 맥에서는 자기 인증서 이름을 넘긴다
APP="build/Ezrite.app"
INSTALLED="/Applications/Ezrite.app"

# 녹음 중이면 빌드하지 않는다 — 설치 단계에서 앱을 끄면 그 녹음이 끝나 버린다
# 쓰기용으로 연 .m4a 만 본다 (FD 열이 숫자+w/u). 지난 기록을 재생하려고 읽기로 연 파일은 녹음이 아니다
if lsof -c Ezrite 2>/dev/null | awk '$4 ~ /^[0-9]+[wu]$/ && $NF ~ /\.m4a$/' | grep -q .; then
    echo "Ezrite 가 녹음 중이라 빌드하지 않았습니다. 녹음을 끝낸 뒤 다시 실행하세요." >&2
    exit 1
fi

swift build -c release
BIN="$(swift build -c release --show-bin-path)/Ezrite"

# 켜져 있는 앱의 번들을 바꿔치기하면 macOS 가 그 앱을 강제 종료해서 녹음 중이던 소리 파일이 깨진다.
# 먼저 정상 종료시켜 녹음을 마무리한다
if pgrep -f "Ezrite.app/Contents/MacOS/Ezrite" >/dev/null; then
    osascript -e 'quit app id "com.dakcoe.ezrite"' || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do pgrep -f "Ezrite.app/Contents/MacOS/Ezrite" >/dev/null || break; sleep 0.5; done
fi

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/Ezrite"
cp Resources/Info.plist "$APP/Contents/Info.plist"
cp Resources/AppIcon.icns Resources/MenuIcon.png Resources/MenuIconRec.png "$APP/Contents/Resources/"
# 앱 안 파일 이름은 영문만. 한글 이름은 DMG 에서 복사할 때 자모가 풀려(NFD) 서명이 깨지고 "손상된 앱" 으로 막힌다
cp Resources/오픈소스고지.txt "$APP/Contents/Resources/ThirdPartyNotices.txt"
cp -R Resources/web "$APP/Contents/Resources/web"          # 설명 카드 화면과 그림 도구(mermaid, KaTeX)

codesign --force --sign "$IDENTITY" "$APP"
# 응용 프로그램 폴더에 설치 — Launchpad·Spotlight 에서 "Ezrite" 로 켠다
rm -rf "$INSTALLED"
# 옮긴다(복사 아님): build 에 사본이 남으면 Launchpad·Spotlight 에 Ezrite 가 두 번 뜬다
mv "$APP" "$INSTALLED"
echo "built: $APP → installed: $INSTALLED"
