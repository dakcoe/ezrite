import CoreGraphics
import Foundation
import Testing
@testable import Ezrite

/// Groq 모델이 프롬프트를 어기고 내부 줄 번호("25번 줄", "(28번)")를 쓰면 실제 글자로 바꾸거나 지운다
struct LineRefTests {
    static let lines = [Explain.Line(id: 25, text: "순전파: z = Wa + b", box: .zero),
                        Explain.Line(id: 28, text: #"은닉층 "오차" \delta"#, box: .zero)]

    @Test func 줄_번호를_그_줄의_글자로_바꾼다() {
        #expect(Explain.dropLineRefs("25번 줄에 보이는 것처럼 계산해요", lines: Self.lines)
                == "‘순전파: z = Wa + b’에 보이는 것처럼 계산해요")
    }

    @Test func 괄호_속_번호는_지운다() {
        #expect(Explain.dropLineRefs("1. 전방 계산 (25번)", lines: Self.lines) == "1. 전방 계산")
        #expect(Explain.dropLineRefs("화면 2번 참고) 끝", lines: Self.lines) == "화면 2번 참고) 끝")   // 줄이 아닌 번호는 둔다
    }

    @Test func JSON_안에서_써도_JSON이_깨지지_않는다() throws {
        // 바꿔 넣는 글자에 따옴표·역슬래시가 있어도 JSON 문자열이 그대로 읽혀야 한다
        let raw = #"{"answer":"28번 줄을 보세요"}"#
        let fixed = Explain.dropLineRefs(raw, lines: Self.lines)
        #expect(Explain.answer(from: Data(fixed.utf8)) == "‘은닉층 ”오차” delta’을 보세요")
    }

    @Test func 없는_번호는_건드리지_않는다() {
        #expect(Explain.dropLineRefs("3번 줄", lines: Self.lines) == "3번 줄")
    }

    @Test func 라인_line_이라고_써도_바꾼다() {
        #expect(Explain.dropLineRefs("순전파(25번 라인)에서", lines: Self.lines) == "순전파(‘순전파: z = Wa + b’)에서")
        #expect(Explain.dropLineRefs("see line 25 here", lines: Self.lines) == "see ‘순전파: z = Wa + b’ here")
        #expect(Explain.dropLineRefs("화면 25번 \"순전파\"", lines: Self.lines) == "‘순전파: z = Wa + b’ \"순전파\"")
    }
}

/// Groq 이 "Failed to generate JSON" 으로 거절한 원문(수식 역슬래시가 그대로인 JSON)을 고쳐 읽는다
struct LenientJSONTests {
    @Test func 수식_역슬래시를_고쳐_읽는다() throws {
        let raw = "```json\n" + #"{"summary":"오차 \delta 와 \frac{1}{2}","marks":[]}"# + "\n```"
        let data = try #require(Explain.lenientJSON(raw))
        #expect(Explain.visuals(from: data).summary == #"오차 \delta 와 \frac{1}{2}"#)
    }

    @Test func 올바른_이스케이프는_그대로_둔다() throws {
        let data = try #require(Explain.lenientJSON(#"{"summary":"줄\n바꿈 \"따옴표\""}"#))
        #expect(Explain.visuals(from: data).summary == "줄\n바꿈 \"따옴표\"")
    }

    @Test func JSON이_아니면_nil() {
        #expect(Explain.lenientJSON("죄송합니다") == nil)
    }
}
