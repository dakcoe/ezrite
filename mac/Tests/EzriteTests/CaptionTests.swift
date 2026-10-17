import AppKit
import Testing
@testable import Ezrite

/// 아래 한도 줄에 마우스를 올리면 뜨는 글. 잘려서 "…" 가 되면 뜻이 없어지므로 게이지 자리 안에 들어가야 한다
struct CaptionTests {
    private func width(_ s: String) -> CGFloat {
        (s as NSString).size(withAttributes: [.font: NSFont.systemFont(ofSize: 10.5)]).width
    }

    @Test func 가장_긴_한도_글도_게이지_자리에_들어간다() {
        let longest = UsageFooter.gauges.flatMap { g in
            [UsageFooter.captionText(g.label, left: 1, paid: nil),
             UsageFooter.captionText(g.label, left: 1, paid: nil, uses: (explain: 999, ask: 999)),
             UsageFooter.captionText(g.label, left: 1, paid: Provider.gemini.label)]
        }
        for s in longest { #expect(width(s) <= 240, "\(s)") }
    }

    @Test func 남은_한도를_퍼센트로_보인다() {
        #expect(UsageFooter.captionText("번역", left: 0.824, paid: nil) == "번역 한도 82% 남음")
        #expect(UsageFooter.captionText("번역", left: 0.5, paid: "Claude") == "번역: Claude 사용 (유료, 한도 표시 없음)")
        #expect(UsageFooter.captionText("화면 설명", left: 0.82, paid: nil, uses: (explain: 12, ask: 14))
                == "화면 설명 82% 남음 · 설명 약 12번, 질문 약 14번")
    }
}
