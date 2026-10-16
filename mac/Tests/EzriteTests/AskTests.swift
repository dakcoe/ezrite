import Foundation
import Testing
@testable import Ezrite

/// AI 지침과 질문: 설명·질문 요청에 사용자 지침과 앞의 대화가 들어가는지, 답을 읽는지
@Suite(.serialized)
struct AskTests {
    static let lines = [Explain.Line(id: 1, text: "MRS_A = MRS_B", box: .zero)]

    @Test func 사용자_지침이_있으면_설명과_질문_요청에_들어간다() {
        GroqClient.guide = "통계학 2학년 수준으로, 수식은 풀이까지"
        defer { GroqClient.guide = "" }
        #expect(GroqClient.unifiedPrompt(lines: Self.lines, transcript: []).contains("통계학 2학년 수준으로"))
        #expect(GroqClient.visualsPrompt(lines: Self.lines, transcript: []).contains("통계학 2학년 수준으로"))
        #expect(GroqClient.questionPrompt("왜 같아야 해?", history: [], explanation: "", lines: Self.lines, transcript: [])
            .contains("통계학 2학년 수준으로"))
    }

    @Test func 지침이_비어_있으면_아무것도_넣지_않는다() {
        GroqClient.guide = "   "
        defer { GroqClient.guide = "" }
        #expect(!GroqClient.unifiedPrompt(lines: Self.lines, transcript: []).contains("Student's instructions"))
    }

    @Test func 질문_요청에는_질문·앞의_설명·앞의_대화가_들어간다() {
        let p = GroqClient.questionPrompt("그럼 MRS가 다르면?", history: [("MRS가 뭐야?", "한계대체율이에요")],
                                          explanation: "파레토 효율 설명", lines: Self.lines, transcript: ["교환이 효율적이려면"])
        #expect(p.contains("그럼 MRS가 다르면?"))
        #expect(p.contains("한계대체율이에요"))
        #expect(p.contains("파레토 효율 설명"))
        #expect(p.contains("교환이 효율적이려면"))
        #expect(p.contains("1: MRS_A = MRS_B"))
    }

    @Test func 답에서_본문을_읽는다() {
        let json = #"{"answer":"MRS 가 다르면\n교환으로 둘 다 이득을 볼 수 있어요.","marks":[{"id":1,"note":"이 조건"}],"visuals":[]}"#
        #expect(Explain.answer(from: Data(json.utf8)) == "MRS 가 다르면\n교환으로 둘 다 이득을 볼 수 있어요.")
        #expect(Explain.marks(from: Data(json.utf8), lines: Self.lines).map(\.line.id) == [1])
        #expect(Explain.answer(from: Data("깨짐".utf8)) == nil)
    }

    @Test func 앞뒤에_말이_붙어_와도_JSON_을_꺼내_읽는다() {
        let text = "Here is the answer:\n{\"answer\":\"한계대체율이 같아야 해요\",\"marks\":[]}\nHope this helps."
        #expect(Explain.answer(from: Data(AI.stripFences(text).utf8)) == "한계대체율이 같아야 해요")
    }
}
