import Foundation
import Testing
@testable import Ezrite

/// 한국어로 시켰는데 다른 문자(중국어 한자, 가나, 키릴 등)가 섞여 나온 조각 찾기와 고치기
struct ScriptTests {
    @Test func 한국어에_섞인_한자_조각만_찾는다() {
        #expect(Script.foreignRuns("이 과정은 本课程에서 다룬 光合成입니다", source: "") == ["本课程", "光合成"])
    }

    @Test func 로마자_숫자_기호_그리스문자는_정상이다() {
        #expect(Script.foreignRuns("TCP 3-way handshake, δ = ŷ − y, λW, √ŝ + ε, 93.6%", source: "").isEmpty)
    }

    @Test func 원문에_있던_글자는_섞인_것으로_보지_않는다() {
        // 화면에 원래 있던 한자·가나는 답에 그대로 나와도 된다
        #expect(Script.foreignRuns("슬라이드의 経済 는 경제라는 뜻이에요", source: "第3章 経済").isEmpty)
    }

    @Test func 키릴_문자도_찾는다() {
        #expect(Script.foreignRuns("결과는 привет 입니다", source: "") == ["привет"])
    }

    @Test func 교정표대로_제자리에_끼워_넣는다() {
        let fixed = Script.apply("이 과정은 本课程에서 다룬 光合成입니다", reply: "本课程=이 강의\n光合成=광합성\n", runs: ["本课程", "光合成"])
        #expect(fixed == "이 과정은 이 강의에서 다룬 광합성입니다")
    }

    @Test func 교정이_빠지거나_또_섞이면_고치지_않는다() {
        #expect(Script.apply("本课程 光合成", reply: "本课程=이 강의", runs: ["本课程", "光合成"]) == nil)
        #expect(Script.apply("本课程", reply: "本课程=本强의", runs: ["本课程"]) == nil)
    }
}
