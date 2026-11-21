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

    @Test func 답의_수식_명령은_줄바꿈으로_바꾸지_않는다() {
        let json = #"{"answer":"기울기 $\\nabla f$ 를 봅니다.\\n다음 줄","marks":[]}"#
        #expect(Explain.answer(from: Data(json.utf8)) == "기울기 $\\nabla f$ 를 봅니다.\n다음 줄")
    }

    @Test func 답_글이_닫혔을_때만_깨진_JSON_대신_쓴다() {
        // 뒤쪽이 깨져도 답 글이 닫혔으면 그 글
        #expect(Explain.closedAnswer(#"{"answer":"합성곱은 \"이름\"\n끝","marks":[{"id":3,"note":"x"}],"path":{"#) == "합성곱은 \"이름\"\n끝")
        // 답 글이 중간에 잘렸으면 nil (다시 묻는다)
        #expect(Explain.closedAnswer(#"{"answer":"합성곱은 \"이름\"이고"#) == nil)
        #expect(Explain.closedAnswer(#"{"marks":[]"#) == nil)
    }

    @Test func 다_오지_않은_JSON_에서_답_글을_온_만큼_꺼낸다() {
        #expect(Explain.partialAnswer(#"{"ans"#) == nil)
        #expect(Explain.partialAnswer(#"{"answer":""#) == nil)
        #expect(Explain.partialAnswer(#"{"answer": "합성곱은 \"이름\"이고\n$\\nabla"#) == "합성곱은 \"이름\"이고\n$\\nabla")
        // 반쯤 온 이스케이프는 그 앞까지
        #expect(Explain.partialAnswer(#"{"answer":"δ 는 δ, 끝\"#) == "δ 는 δ, 끝")
        #expect(Explain.partialAnswer(#"{"answer":"값 \u03"#) == "값")
        // 답 글이 끝나면 뒤의 칸은 보지 않는다
        #expect(Explain.partialAnswer(#"```json\n{"answer":"끝","marks":[{"note":"x"#) == "끝")
        // 역슬래시를 하나만 쓴 수식 명령은 글자 그대로 둔다
        #expect(Explain.partialAnswer(#"{"answer":"$0\le x$ 와 $\frac{1}{2}$"#) == #"$0\le x$ 와 $\frac{1}{2}$"#)
    }

    @Test func 스트리밍_조각에서_글과_토큰을_모은다() throws {
        var c = AI.StreamState()
        #expect(try !c.take(.claude, ["type": "message_start", "message": ["usage": ["input_tokens": 100]]]))
        #expect(try !c.take(.claude, ["type": "content_block_delta", "delta": ["type": "thinking_delta", "thinking": "음"]]))
        #expect(try c.take(.claude, ["type": "content_block_delta", "delta": ["type": "text_delta", "text": "{\"answer\":\"안"]]))
        #expect(try c.take(.claude, ["type": "content_block_delta", "delta": ["type": "text_delta", "text": "녕\"}"]]))
        _ = try c.take(.claude, ["type": "message_delta", "usage": ["output_tokens": 20]])
        #expect(c.text == "{\"answer\":\"안녕\"}")
        #expect(c.tokens(.claude) == 120)
        #expect(throws: AI.Failure.self) { try c.take(.claude, ["type": "error", "error": ["message": "Overloaded"]]) }

        var g = AI.StreamState()
        #expect(try g.take(.openai, ["choices": [["delta": ["content": "가"]]]]))
        #expect(try !g.take(.openai, ["choices": [], "usage": ["prompt_tokens": 5, "completion_tokens": 3, "total_tokens": 8]]))
        #expect(g.text == "가" && g.tokens(.openai) == 8)
    }
}
