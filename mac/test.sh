#!/bin/bash
# 테스트 실행. Xcode 없이 명령줄 도구만 있어서 Swift Testing 매크로 플러그인 경로를 직접 넘긴다.
set -euo pipefail
cd "$(dirname "$0")"
swift test -Xswiftc -plugin-path -Xswiftc /Library/Developer/CommandLineTools/usr/lib/swift/host/plugins/testing "$@"
