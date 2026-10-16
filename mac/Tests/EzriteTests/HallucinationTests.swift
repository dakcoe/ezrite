import Testing
@testable import Ezrite

/// 소리가 없거나 잡음뿐인 구간에서 Whisper 가 지어내는 문장 거르기
struct HallucinationTests {
    typealias Seg = Hallucination.Segment

    @Test func 무음에서_나온_단골_문장은_버린다() {
        // 6초 잡음을 Groq large-v3 에 보냈을 때 실제로 돌아온 결과 (말소리 없음 확률 0.22)
        #expect(Hallucination.keep([Seg(text: " 시청해주셔서 감사합니다.", noSpeechProb: 0.22)]) == "")
        #expect(Hallucination.keep([Seg(text: "MBC 뉴스 김성현입니다.", noSpeechProb: 0.1)]) == "")
        #expect(Hallucination.keep([Seg(text: "Thank you for watching!", noSpeechProb: 0.1)]) == "")
        #expect(Hallucination.keep([Seg(text: "ご視聴ありがとうございました", noSpeechProb: 0.1)]) == "")
    }

    @Test func 강의_문장_끝에_붙은_단골_문장만_떼어낸다() {
        let segs = [Seg(text: " 그래서 이 값을 두 배로 하면 40이 됩니다", noSpeechProb: 0.001),
                    Seg(text: " 구독과 좋아요 부탁드립니다.", noSpeechProb: 0.3)]
        #expect(Hallucination.keep(segs) == "그래서 이 값을 두 배로 하면 40이 됩니다")
    }

    @Test func 단골_표현이_들어_있어도_긴_강의_문장은_남긴다() {
        let text = "오늘 수업 들어 주셔서 감사합니다 다음 시간에는 정렬 알고리즘을 보겠습니다"
        #expect(Hallucination.keep([Seg(text: text, noSpeechProb: 0.02)]) == text)
    }

    @Test func 말소리가_없을_확률이_높은_구간은_버린다() {
        let segs = [Seg(text: "사과가 3개씩 두 줄 있죠", noSpeechProb: 0.001),
                    Seg(text: "다음 장면입니다.", noSpeechProb: 0.8)]
        #expect(Hallucination.keep(segs) == "사과가 3개씩 두 줄 있죠")
    }

    @Test func 바로_앞_줄과_똑같은_줄은_반복으로_본다() {
        #expect(Hallucination.isRepeat("이 그래프를 보면 오른쪽으로 올라가요.",
                                        previous: "이 그래프를 보면 오른쪽으로 올라가요"))
        #expect(!Hallucination.isRepeat("그래서 답은 12가 되고", previous: "표를 다시 볼게요"))
        #expect(!Hallucination.isRepeat("네", previous: "네"))     // 짧은 대답은 반복될 수 있다
    }
}
