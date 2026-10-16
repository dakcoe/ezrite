import CoreGraphics
import Foundation
import Testing
@testable import Ezrite

/// "설명해줘": AI 응답 검사와 화면 좌표
struct ExplainTests {
    static let lines = [
        Explain.Line(id: 0, text: "파일 편집 보기", box: CGRect(x: 0.01, y: 0.0, width: 0.2, height: 0.02)),
        Explain.Line(id: 7, text: "Pareto 효율성", box: CGRect(x: 0.3, y: 0.3, width: 0.25, height: 0.05)),
        Explain.Line(id: 9, text: "MRS_A = MRS_B", box: CGRect(x: 0.4, y: 0.5, width: 0.3, height: 0.06)),
    ]

    @Test func 화면에_없는_줄번호는_버리고_표시는_3개까지만_남긴다() throws {
        let json = #"{"marks":[{"id":7,"note":"자원 배분 기준"},{"id":42,"note":"없는 줄"},{"id":9,"note":"조건"},{"id":7,"note":"중복"},{"id":0},{"id":9}]}"#
        let marks = Explain.marks(from: Data(json.utf8), lines: Self.lines)
        #expect(marks.map(\.line.id) == [7, 9, 0])                 // 없는 42 와 중복은 빠지고 3개까지
        #expect(marks.map(\.note) == ["자원 배분 기준", "조건", ""])  // 설명이 빠진 표시는 빈 설명으로
    }

    @Test func 깨진_응답이면_표시를_그리지_않는다() {
        #expect(Explain.marks(from: Data("not json".utf8), lines: Self.lines).isEmpty)
    }

    @Test func 모르는_그림_형식과_필수_칸이_빠진_그림은_버린다() throws {
        let json = #"""
        {"summary":"요약","visuals":[
          {"type":"steps","title":"과정","items":["수요 증가","가격 상승"]},
          {"type":"steps","title":"빈 과정","items":[]},
          {"type":"table","title":"비교","headers":["구분","A"],"rows":[["장점","싸다"]]},
          {"type":"table","title":"행 없음","headers":["a"],"rows":[]},
          {"type":"card","title":"정의","formula":"MRS_A = MRS_B","terms":[["MRS","한계대체율"]]},
          {"type":"mermaid","title":"관계","code":"flowchart TD\nA-->B"},
          {"type":"hologram","title":"?"}
        ]}
        """#
        let (summary, visuals) = Explain.visuals(from: Data(json.utf8))
        #expect(summary == "요약")
        #expect(visuals.compactMap { $0["title"] as? String } == ["과정", "비교", "정의", "관계"])
    }

    @Test func 비전_좌표를_화면_위쪽_기준으로_뒤집는다() {
        // Vision 은 왼쪽 아래가 원점: 아래쪽 10%~30% 높이의 상자는 위에서 보면 70%~90% 자리다
        let flipped = Explain.topLeft(CGRect(x: 0.2, y: 0.1, width: 0.5, height: 0.2))
        #expect(abs(flipped.minY - 0.7) < 1e-9)
        #expect(abs(flipped.height - 0.2) < 1e-9)
        #expect(flipped.minX == 0.2)
    }

    static let figure = [
        Explain.Line(id: 1, text: "V1", box: CGRect(x: 0.1, y: 0.4, width: 0.03, height: 0.03)),
        Explain.Line(id: 2, text: "R1", box: CGRect(x: 0.3, y: 0.2, width: 0.03, height: 0.03)),
        Explain.Line(id: 3, text: "R2", box: CGRect(x: 0.5, y: 0.2, width: 0.03, height: 0.03)),
        Explain.Line(id: 4, text: "GND", box: CGRect(x: 0.3, y: 0.7, width: 0.05, height: 0.03)),
    ]

    @Test func 그림_속_경로는_라벨_순서대로_잇고_없는_라벨과_연달아_같은_라벨은_뺀다() {
        let json = #"{"path":{"ids":[1,2,2,99,3,4,1],"note":"전류가 흐르는 길"}}"#
        let path = Explain.path(from: Data(json.utf8), lines: Self.figure)
        #expect(path?.steps.map(\.text) == ["V1", "R1", "R2", "GND", "V1"])   // 한 바퀴 돌아오는 건 남긴다
        #expect(path?.note == "전류가 흐르는 길")
    }

    @Test func 이을_라벨이_둘보다_적으면_경로를_그리지_않는다() {
        #expect(Explain.path(from: Data(#"{"path":{"ids":[2,99]}}"#.utf8), lines: Self.figure) == nil)
        #expect(Explain.path(from: Data(#"{"marks":[]}"#.utf8), lines: Self.figure) == nil)
    }
}

/// Groq gpt-oss 의 그림·요약 요청은 형식을 스키마로 고정한다 (칸 이름이 틀려 그림이 조용히 빠지는 일을 막는다)
struct VisualsSchemaTests {
    @Test func 그림_요청은_네_가지_틀을_엄격한_스키마로_고정한다() throws {
        let body = GroqClient.visualsBody(prompt: "p")
        let format = try #require(body["response_format"] as? [String: Any])
        #expect(format["type"] as? String == "json_schema")
        let js = try #require(format["json_schema"] as? [String: Any])
        #expect(js["strict"] as? Bool == true)
        let schema = try #require(js["schema"] as? [String: Any])
        let items = try #require(((schema["properties"] as? [String: Any])?["visuals"] as? [String: Any])?["items"] as? [String: Any])
        let kinds = (items["anyOf"] as? [[String: Any]] ?? []).compactMap {
            (($0["properties"] as? [String: Any])?["type"] as? [String: Any])?["enum"] as? [String]
        }.flatMap { $0 }
        #expect(kinds == ["steps", "table", "card", "mermaid"])
    }

    @Test func 카드의_빈_공식은_null_로_와도_그림이_남는다() {
        let json = #"{"summary":"s","visuals":[{"type":"card","title":"t","formula":null,"body":"설명","terms":[]}]}"#
        #expect(Explain.visuals(from: Data(json.utf8)).visuals.count == 1)
    }
}

/// 장면 대본: 교수님 설명 순서대로 짚을 곳·자막·그림 단계를 차례로 보여준다
struct ScenesTests {
    static let lines = [
        Explain.Line(id: 1, text: "파레토 효율", box: CGRect(x: 0.1, y: 0.3, width: 0.3, height: 0.04)),
        Explain.Line(id: 2, text: "MRS_A = MRS_B", box: CGRect(x: 0.4, y: 0.5, width: 0.2, height: 0.05)),
    ]

    @Test func 화면에_없는_줄과_빈_자막은_버리고_그림_번호와_단계를_범위_안으로() {
        let json = #"""
        {"scenes":[
          {"say":"먼저 정의입니다","focus":[1,99],"arrow":null,"visual":0,"reveal":1},
          {"say":"","focus":[2]},
          {"say":"이 조건이 핵심입니다","focus":[2],"arrow":{"from":1,"to":2},"visual":5,"reveal":-3},
          {"say":"없는 줄로 화살표","focus":[],"arrow":{"from":1,"to":42}}
        ]}
        """#
        let s = Explain.scenes(from: Data(json.utf8), lines: Self.lines, visualCount: 2)
        #expect(s.map(\.say) == ["먼저 정의입니다", "이 조건이 핵심입니다", "없는 줄로 화살표"])
        #expect(s[0].focus.map(\.id) == [1])
        #expect(s[0].visual == 0 && s[0].reveal == 1)
        #expect(s[1].arrow?.from.id == 1 && s[1].arrow?.to.id == 2)
        #expect(s[1].visual == nil && s[1].reveal == nil)       // 없는 그림 번호, 음수 단계
        #expect(s[2].arrow == nil)
    }

    @Test func 장면은_6개까지() {
        let one = #"{"say":"a","focus":[1]}"#
        let json = "{\"scenes\":[" + Array(repeating: one, count: 9).joined(separator: ",") + "]}"
        #expect(Explain.scenes(from: Data(json.utf8), lines: Self.lines, visualCount: 0).count == 6)
    }

    @Test func 대본이_없으면_빈_목록이라_예전처럼_한번에_보여준다() {
        #expect(Explain.scenes(from: Data(#"{"summary":"s"}"#.utf8), lines: Self.lines, visualCount: 0).isEmpty)
    }
}

/// Groq 이 그림 답을 객체 대신 목록으로 줄 때도 그림을 살린다
struct VisualsShapeTests {
    @Test func 목록으로_온_답은_그림_목록으로_감싼다() throws {
        let arr = #"[{"type":"steps","title":"흐름","items":["가","나"]}]"#
        let fixed = GroqClient.asVisualsObject(Data(arr.utf8))
        #expect(Explain.visuals(from: fixed).visuals.count == 1)
    }

    @Test func 객체로_온_답은_그대로_둔다() {
        let obj = #"{"summary":"요약","visuals":[]}"#
        #expect(GroqClient.asVisualsObject(Data(obj.utf8)) == Data(obj.utf8))
    }
}
