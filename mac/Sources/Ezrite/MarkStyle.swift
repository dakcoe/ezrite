import Foundation

/// "설명해줘" 화면 표시 방식. 설정에서 고른다. 오버레이(MarksRenderer)와 설명 카드(explain.html)가 같은 값을 본다
enum MarkStyle: String, CaseIterable {
    case classic        // 예전 방식: 주황 상자 ①②③ + 파란 경로
    // 지금 하나만 — 표시는 카드가 지금 말하는 곳 하나
    case spotlight, highlighter, corners
    // 카드와 짝 — 표시는 카드 글의 '그거 어디?'에 대한 답
    case hover, colors, leader
    // 순서를 남기기 — 번호는 설명 순서 하나
    case flow, trail, minimap
    // 화면에 바로 적기 — 표시 자체가 설명
    case bubble, notes, pen

    static let fallback: MarkStyle = .trail

    var label: String {
        switch self {
        case .classic: return "상자와 번호 (예전 방식)"
        case .spotlight: return "스포트라이트"
        case .highlighter: return "형광펜"
        case .corners: return "모서리 괄호"
        case .hover: return "카드에 마우스를 올린 곳만"
        case .colors: return "색으로 짝 맞추기"
        case .leader: return "카드에서 잇는 선"
        case .flow: return "흐르는 점"
        case .trail: return "발자취 (추천)"
        case .minimap: return "카드 속 지도"
        case .bubble: return "말풍선"
        case .notes: return "여백 메모"
        case .pen: return "판서"
        }
    }

    var detail: String {
        switch self {
        case .classic: return "짚은 곳은 주황 상자와 번호, 그림 속 순서는 파란 상자와 화살표로 보여 줍니다."
        case .spotlight: return "나머지 화면을 잠깐 어둡게 하고 지금 설명하는 곳만 밝힙니다. 장면이 바뀌면 밝은 자리가 옮겨 갑니다."
        case .highlighter: return "지금 설명하는 글자 아래에 형광펜을 긋습니다. 글자를 가리지 않습니다."
        case .corners: return "한 번 깜박인 뒤 상자 대신 모서리 네 곳만 남깁니다. 가리는 면적이 가장 작습니다."
        case .hover: return "평소엔 흐린 바탕만 깔고, 설명 카드의 문장·목록에 마우스를 올린 곳을 진하게 보여 줍니다."
        case .colors: return "짚은 줄마다 색을 하나씩 정하고 카드의 같은 설명에도 같은 색을 칠합니다. 번호는 쓰지 않습니다."
        case .leader: return "설명 카드의 문장에서 화면의 그 줄까지 선을 직접 긋습니다."
        case .flow: return "상자 없이 빛나는 점이 화살표 길을 따라 움직입니다. 방향이 움직임으로 보입니다."
        case .trail: return "번호는 설명 순서 하나만 뜻합니다. 지금 장면은 주황, 지난 장면은 회색 번호로 남아 끝나면 복습 지도가 됩니다."
        case .minimap: return "화면에는 작은 점 하나만 두고, 설명의 길 전체는 카드 안 축소 화면에 그립니다."
        case .bubble: return "짚은 곳 옆에 핵심 한 마디를 말풍선으로 띄웁니다."
        case .notes: return "화면 빈 곳에 손글씨 메모가 장면마다 쌓여, 끝나면 필기된 화면이 남습니다."
        case .pen: return "펜으로 동그라미 치고 화살표 긋고 한 단어 쓰는 순서대로 그립니다."
        }
    }

    /// 설정 목록의 묶음 제목
    var group: String {
        switch self {
        case .classic: return "기본"
        case .spotlight, .highlighter, .corners: return "지금 하나만"
        case .hover, .colors, .leader: return "카드와 짝"
        case .flow, .trail, .minimap: return "순서를 남기기"
        case .bubble, .notes, .pen: return "화면에 바로 적기"
        }
    }

    /// 장면마다 짧은 꼬리표를 AI 에게 받는다 (출력 토큰이 조금 는다)
    var wantsTags: Bool { [.bubble, .notes, .pen].contains(self) }
    /// 카드에 마우스를 올린 항목을 화면에 보여 준다
    var usesHover: Bool { [.spotlight, .highlighter, .corners, .hover, .leader, .trail].contains(self) }
    /// 카드 글의 화면 위치가 필요하다 (선 긋기)
    var usesAnchors: Bool { self == .leader }
}
