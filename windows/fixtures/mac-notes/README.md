# 맥판 1.1.3 원본 (기록 폴더 + 저장됨 띠)

공개 저장소에는 아직 1.1.2 까지만 있어서, 맥북의 최신 파일을 그대로 둔다 (1.1.3 배포 때 공개 저장소에도 올라간다).

| 파일 | 볼 곳 |
|---|---|
| `Notes.swift` | `isFoldered`, `trashTargets`, `rename`(폴더째) · `rename(inPlace:)`, `delete`, `recoverParts`(하위 폴더), `Writer.create`(폴더 만들기), `newURL`(폴더 이름 겹침), `sessions`·`subfolders`, `prune`(소리만 남은 폴더, 오래된 폴더), `export`(폴더째) |
| `SessionFolderTests.swift` | 시험 8개 |
| `PauseResumeTests.swift` | `audioSeconds` 가 하위 폴더까지 찾도록 바뀜 |
| `MenuPopover.swift` | `SavedBanner` (팝업 `MenuPopover.full` 과 전체 창 `MainView` 맨 위, UpdateBanner 아래) |
| `Transcriber.swift` | `start()` 에서 `state.savedSession = nil`, `stop()` 에서 `state.savedSession = writer.url` |
| `StatusBar.swift` | 팝업 높이 맞춤에 `state.$savedSession` 추가 (Merge4) |
