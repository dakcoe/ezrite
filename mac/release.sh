#!/bin/bash
# 새 버전 배포: 버전 올리기 → Apple·Intel 겸용 빌드 → DMG → GitHub 릴리스.
# 사용자 앱은 켤 때와 6시간마다 이 저장소의 최신 릴리스를 보고 "새 버전" 띠를 띄운다.
#
#   ./release.sh 0.9.1 notes.md      # notes.md: 사용자에게 보일 바뀐 점 (첫 세 줄이 띠에 나온다)
#   ./release.sh 0.9.1 notes.md --dry   # 올리지 않고 DMG 까지만
set -euo pipefail
cd "$(dirname "$0")"

VERSION="${1:?버전을 주세요 (예: 0.9.1)}"
NOTES="${2:?바뀐 점 파일을 주세요 (예: notes.md)}"
DRY="${3:-}"
REPO="$(/usr/libexec/PlistBuddy -c 'Print EzriteUpdateRepo' Resources/Info.plist)"
IDENTITY="${EZRITE_SIGN_ID:-StudyAI Dev Signing}"   # 다른 맥에서는 자기 인증서 이름을 넘긴다
OUT="build/release"
APP="$OUT/Ezrite.app"
DMG="$OUT/Ezrite-$VERSION.dmg"

[ -f "$NOTES" ] || { echo "바뀐 점 파일이 없습니다: $NOTES" >&2; exit 1; }
CURRENT="$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' Resources/Info.plist)"
echo "버전 $CURRENT → $VERSION · 저장소 $REPO"

./test.sh >/dev/null || { echo "테스트 실패 — 배포를 멈춥니다" >&2; exit 1; }

/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION" Resources/Info.plist
BUILD_NO="$(/usr/libexec/PlistBuddy -c 'Print CFBundleVersion' Resources/Info.plist)"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $((BUILD_NO + 1))" Resources/Info.plist

# Apple 칩 + Intel 겸용
swift build -c release --arch arm64 --arch x86_64
BIN="$(swift build -c release --arch arm64 --arch x86_64 --show-bin-path)/Ezrite"

rm -rf "$OUT"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/Ezrite"
cp Resources/Info.plist "$APP/Contents/Info.plist"
cp Resources/AppIcon.icns Resources/MenuIcon.png Resources/MenuIconRec.png "$APP/Contents/Resources/"
# 앱 안 파일 이름은 영문만. 한글 이름은 DMG 에서 복사할 때 자모가 풀려(NFD) 서명이 깨지고 "손상된 앱" 으로 막힌다
cp Resources/오픈소스고지.txt "$APP/Contents/Resources/ThirdPartyNotices.txt"
cp -R Resources/web "$APP/Contents/Resources/web"
# shortcut: 자체 서명이라 받는 사람은 처음 한 번 "그래도 열기"를 눌러야 한다. Apple 개발자 계정이 생기면 Developer ID 서명 + 공증으로 바꾼다
if LC_ALL=C find "$APP" -name '*[! -~]*' | grep -q .; then
    echo "앱 안에 영문이 아닌 파일 이름이 있습니다 (서명이 깨집니다):" >&2; LC_ALL=C find "$APP" -name '*[! -~]*' >&2; exit 1
fi
codesign --force --sign "$IDENTITY" "$APP"

# DMG: 앱 + 응용 프로그램 바로가기 + 설치 안내 + 오픈소스 고지, 배경 그림 (Resources/dmg)
STAGE="$OUT/dmg"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
cp Resources/설치안내.txt "$STAGE/설치 안내.txt"
cp Resources/오픈소스고지.txt "$STAGE/오픈소스 고지.txt"
mkdir -p "$STAGE/.background"
# DMG 를 검색 색인에서 뺀다. 색인되면 DMG 안의 앱이 Launchpad·앱 목록에 하나 더 보인다
touch "$STAGE/.metadata_never_index"
cp Resources/dmg/background.tiff "$STAGE/.background/background.tiff"

# 창 모양(크기·아이콘 자리·배경)은 쓰기 가능한 이미지를 열어 Finder 로 정한 뒤 압축본으로 바꾼다
VOL="Ezrite $VERSION"
RW="$OUT/rw.dmg"
hdiutil detach "/Volumes/$VOL" -force >/dev/null 2>&1 || true
hdiutil create -volname "$VOL" -srcfolder "$STAGE" -ov -fs HFS+ -format UDRW "$RW" >/dev/null
hdiutil attach "$RW" -nobrowse -noautoopen -mountpoint "/Volumes/$VOL" >/dev/null
osascript <<APPLESCRIPT
tell application "Finder"
    tell disk "$VOL"
        open
        set current view of container window to icon view
        set toolbar visible of container window to false
        set statusbar visible of container window to false
        set bounds of container window to {200, 140, 860, 728}
        set opts to icon view options of container window
        set arrangement of opts to not arranged
        set icon size of opts to 128
        set text size of opts to 13
        set background picture of opts to file ".background:background.tiff"
        set position of item "Ezrite.app" of container window to {170, 160}
        set position of item "Applications" of container window to {490, 160}
        set position of item "설치 안내.txt" of container window to {230, 440}
        set position of item "오픈소스 고지.txt" of container window to {430, 440}
        update without registering applications
        delay 2
        close
    end tell
end tell
APPLESCRIPT
sync
hdiutil detach "/Volumes/$VOL" >/dev/null
hdiutil convert "$RW" -format UDZO -ov -o "$DMG" >/dev/null
rm -f "$RW"
rm -rf "$STAGE"

# 받는 사람처럼 DMG 에서 앱을 복사해 서명이 그대로인지 확인한다
CHECK="$(mktemp -d)"
hdiutil attach "$DMG" -nobrowse -readonly -mountpoint "$CHECK/v" >/dev/null
# Finder 로 복사해야 사용자와 같다 (cp·ditto 는 한글 이름을 그대로 둬서 문제를 못 잡는다)
osascript -e "tell application \"Finder\" to duplicate (POSIX file \"$CHECK/v/Ezrite.app\" as alias) to (POSIX file \"$CHECK\" as alias)" >/dev/null
hdiutil detach "$CHECK/v" >/dev/null
codesign --verify --deep --strict "$CHECK/Ezrite.app" || { echo "DMG 에서 복사한 앱의 서명이 깨졌습니다" >&2; exit 1; }
rm -rf "$CHECK"
rm -rf "$APP"                     # 빌드한 앱을 남겨 두면 Launchpad·Spotlight 에 Ezrite 가 하나 더 보인다
echo "DMG: $DMG ($(du -h "$DMG" | cut -f1))"

if [ "$DRY" = "--dry" ]; then
    echo "--dry: 올리지 않았습니다. 버전 번호는 Info.plist 에 $VERSION 으로 바뀌어 있습니다."
    exit 0
fi

# 시험판(0.x)이어도 prerelease 로 표시하지 않는다 — 앱이 보는 releases/latest 는 prerelease 를 건너뛴다
gh release create "v$VERSION" "$DMG" --repo "$REPO" --title "Ezrite $VERSION" --notes-file "$NOTES"
echo "올림: https://github.com/$REPO/releases/tag/v$VERSION"
