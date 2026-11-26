import AppKit

/// 화면 번역의 글자 묶기·자리 잡기. 글자 인식 조각 → 같은 높이의 조각을 한 줄로 → 이어지는 줄을 문단으로 →
/// 문단 하나를 한 번에 옮겨 그 문단 자리에 줄바꿈해 채운다. 바탕·글자색·굵기는 원래 그림에서 뽑는다.
/// 좌표는 모두 창 안 포인트, 왼쪽 위 원점
extension ScreenTranslate {
    struct Row: Equatable {
        var text: String
        var rect: CGRect
    }

    struct Block: Equatable {
        var rows: [Row]
        var rect: CGRect { rows.dropFirst().reduce(rows[0].rect) { $0.union($1.rect) } }
        /// 옮길 글: 줄을 이어 붙인다. 줄 끝 하이픈으로 끊긴 낱말은 붙인다
        var text: String {
            rows.map(\.text).reduce("") { acc, t in
                if acc.isEmpty { return t }
                if acc.hasSuffix("-"), let f = t.first, f.isLowercase { return String(acc.dropLast()) + t }
                return acc + " " + t
            }
        }
        /// 줄 간격 (윗줄 위 → 아랫줄 위). 한 줄이면 줄 높이의 1.25배
        var pitch: CGFloat {
            guard rows.count > 1 else { return rows[0].rect.height * 1.25 }
            let gaps = zip(rows, rows.dropFirst()).map { $1.rect.midY - $0.rect.midY }.sorted()
            return gaps[gaps.count / 2]
        }
        var rowHeight: CGFloat {
            let hs = rows.map(\.rect.height).sorted()
            return hs[hs.count / 2]
        }
    }

    /// 덮개 하나: 이 자리를 bg 로 칠하고 text 를 font 로 줄바꿈해 쓴다
    struct Item: Identifiable {
        let id: Int
        let rect: CGRect
        let text: String
        let font: NSFont
        let lineHeight: CGFloat
        let bg: NSColor
        let ink: NSColor
    }

    // ── 줄 만들기 ──

    /// 같은 높이에 나란히 있는 조각을 한 줄로 합친다 (고정폭 글꼴·넓은 띄어쓰기에서 글자 인식이 줄을 쪼갠다).
    /// 사이가 줄 높이의 1.6배를 넘으면 다른 칸(두 단, 표)으로 본다
    static func rows(_ lines: [Explain.Line], size: CGSize) -> [Row] {
        let frags = lines.map { Row(text: $0.text.trimmingCharacters(in: .whitespaces),
                                     rect: CGRect(x: $0.box.minX * size.width, y: $0.box.minY * size.height,
                                                  width: $0.box.width * size.width, height: $0.box.height * size.height)) }
            .sorted { $0.rect.minX < $1.rect.minX }
        var out: [Row] = []
        for f in frags {
            if let i = out.lastIndex(where: { sameRow($0.rect, f.rect) }) {
                out[i].text += " " + f.text
                out[i].rect = out[i].rect.union(f.rect)
            } else {
                out.append(f)
            }
        }
        return out.sorted { $0.rect.minY == $1.rect.minY ? $0.rect.minX < $1.rect.minX : $0.rect.minY < $1.rect.minY }
    }

    static func sameRow(_ a: CGRect, _ b: CGRect) -> Bool {
        let h = min(a.height, b.height)
        let overlap = min(a.maxY, b.maxY) - max(a.minY, b.minY)
        let ratio = max(a.height, b.height) / max(h, 1)
        let gap = b.minX - a.maxX
        // 세로로 세운 글(그래프 축 이름)은 옆 글과 잇지 않는다
        let upright = a.height > a.width * 1.2 || b.height > b.width * 1.2
        return !upright && overlap > 0.6 * h && ratio < 1.5 && gap > -0.5 * h && gap < 1.6 * h
    }

    // ── 문단 만들기 ──

    /// 줄 머리가 목록 표시면 새 문단
    static func startsItem(_ s: String) -> Bool {
        guard let c = s.first else { return false }
        if "•·◦▪●■–—*-‣".contains(c) { return true }
        // 1. a) 그리고 목차 번호 (5 The…, 9.2 Backshift)
        return s.range(of: #"^(\d{1,2}|[a-zA-Z])[.)]\s"#, options: .regularExpression) != nil
            || s.range(of: #"^\d{1,2}(\.\d{1,2})*\s+\p{Lu}"#, options: .regularExpression) != nil
    }

    /// 코드 줄: 옮기지 않고 다른 줄과 묶지도 않는다 (주석 줄은 따로 옮긴다)
    static func isCode(_ s: String) -> Bool {
        if s.hasPrefix("#") || s.hasPrefix("//") { return false }
        let symbols = s.filter { "=(){};[]<>".contains($0) }.count
        // 기호가 많아도 "(a) ...; (b) ..." 같은 글이면 코드가 아니다: 대입·중괄호·대괄호·꺾쇠나 이름(… 호출이 있어야 코드
        if symbols >= 3 && s.range(of: #"[=\{\}\[\]<>]|\w\("#, options: .regularExpression) != nil { return true }
        // 코드 낱말로 시작하는 짧은 줄 (return model, import os) 이나 기호가 섞인 줄
        let words = s.split(separator: " ").count
        return s.range(of: #"^(def|return|import|from|func|let|var|const|class|if|elif|else|for|while|print|try|except|catch)\b"#,
                       options: .regularExpression) != nil && (symbols >= 1 || words <= 4)
    }

    static func isComment(_ s: String) -> Bool { s.hasPrefix("#") || s.hasPrefix("//") }

    /// 위아래로 이어지는 줄을 문단으로. ink: 줄마다 글자색 (다르면 다른 문단: 제목과 설명, 링크 목록).
    /// 화면이 여러 칸(목차·본문·옆 목차)이면 위에서부터 칸이 섞여 들어오므로, 줄마다 바로 위·같은 칸의 문단을 찾아 붙인다
    /// size: 줄마다 잰 글자 크기 (못 재면 nil). 있으면 상자 높이 대신 이것으로 크기가 같은지 본다
    static func blocks(_ rows: [Row], ink: [NSColor]? = nil, size: [CGFloat?]? = nil) -> [Block] {
        var out: [Block] = []
        var inks: [NSColor?] = []        // 문단마다 마지막 줄 글자색
        let right = columnRight(rows)
        for (i, r) in rows.enumerated() {
            let color = ink?[i]
            let at = out.indices.reversed().first { k in
                guard let prev = out[k].rows.last, let pi = rows.firstIndex(of: prev) else { return false }
                let ratio = size.flatMap { s in s[pi].flatMap { a in s[i].map { b in max(a, b) / max(min(a, b), 1) } } }
                return wrapped(prev, before: r, right: right[pi]) && joins(prev, r, block: out[k], sameInk: sameColor(inks[k], color), sizeRatio: ratio)
            }
            if let at {
                out[at].rows.append(r)
                inks[at] = color
            } else {
                out.append(Block(rows: [r]))
                inks.append(color)
            }
        }
        return out.sorted { $0.rect.minY == $1.rect.minY ? $0.rect.minX < $1.rect.minX : $0.rect.minY < $1.rect.minY }
    }

    /// 줄마다 칸 오른쪽 끝: 왼쪽 끝이 비슷한 줄들 중 가장 긴 줄의 끝
    static func columnRight(_ rows: [Row]) -> [CGFloat] {
        rows.map { r in
            rows.filter { abs($0.rect.minX - r.rect.minX) < 1.5 * r.rect.height }.map(\.rect.maxX).max() ?? r.rect.maxX
        }
    }

    /// 윗줄이 꽉 차서 넘어간 것인가 (문서 흐름 규칙): 아랫줄 첫 낱말이 윗줄 끝에 들어갈 자리가 없었으면 넘어간 것.
    /// 자리가 남았는데 줄이 바뀌었으면 일부러 끊은 것(목록 항목, 제목, 문단 끝)
    static func wrapped(_ prev: Row, before next: Row, right: CGFloat) -> Bool {
        if prev.text.hasSuffix("-") { return true }
        let first = next.text.split(separator: " ").first.map(String.init) ?? next.text
        let perChar = next.rect.width / CGFloat(max(next.text.count, 1))
        let need = CGFloat(first.count + 1) * perChar
        return prev.rect.maxX + need > right - 0.2 * prev.rect.height
    }

    static func joins(_ prev: Row, _ r: Row, block: Block, sameInk: Bool, sizeRatio: CGFloat? = nil) -> Bool {
        let h = max(prev.rect.height, r.rect.height), ratio = h / max(min(prev.rect.height, r.rect.height), 1)
        let gap = r.rect.minY - prev.rect.maxY
        // 인식 상자 높이는 글자에 따라(g·p 꼬리) ±50% 흔들리고 윗줄과 겹치기도 한다. 잰 글자 크기가 있으면 그것으로,
        // 없으면 상자 높이로 제목(보통 1.4배 넘게 큼)만 가른다
        let sameSize = sizeRatio.map { $0 < 1.3 } ?? (ratio < 1.4)
        guard sameInk, sameSize, gap > -0.5 * h, gap < 0.9 * h else { return false }
        // 줄 사이가 조금 벌어졌으면(줄 간격 넓은 본문) 윗줄이 긴 본문 줄일 때만. 짧은 메뉴·목차 항목끼리는 잇지 않는다
        if gap > 0.55 * h && prev.text.count < 30 { return false }
        // 왼쪽 끝이 맞거나, 목록처럼 이어지는 줄이 들여 쓰였다 (3 Time series ↵ decomposition)
        let indent = r.rect.minX - block.rect.minX
        guard indent > -1.0 * h, indent < 3.0 * h else { return false }
        // 같은 칸: 가로로 겹쳐야 한다
        guard r.rect.minX < block.rect.maxX, r.rect.maxX > block.rect.minX else { return false }
        // 문단 안 줄 간격은 일정하다. 목록 항목 사이처럼 더 벌어지면 끊는다
        if block.rows.count > 1 {
            let step = r.rect.midY - prev.rect.midY
            guard step < block.pitch * 1.3, step > block.pitch * 0.7 else { return false }
        }
        guard !startsItem(r.text), !isCode(r.text), !isCode(prev.text), !isComment(r.text), !isComment(prev.text) else { return false }
        // 앞줄이 문단 폭보다 한참 짧게 문장으로 끝났으면 문단 끝
        let ended = prev.text.last.map { ".!?:。".contains($0) } ?? false
        if ended && prev.rect.width < 0.7 * block.rect.width { return false }
        return true
    }

    static func sameColor(_ a: NSColor?, _ b: NSColor?) -> Bool {
        guard let a, let b else { return true }
        return distance(a, b) < 0.22
    }

    static func distance(_ a: NSColor, _ b: NSColor) -> CGFloat {
        guard let a = a.usingColorSpace(.deviceRGB), let b = b.usingColorSpace(.deviceRGB) else { return 1 }
        return max(abs(a.redComponent - b.redComponent), abs(a.greenComponent - b.greenComponent), abs(a.blueComponent - b.blueComponent))
    }

    /// 읽는 순서: 왼쪽 끝이 가까운(40pt) 문단끼리 한 칸, 칸은 왼쪽부터, 칸 안은 위에서부터
    static func readingOrder(_ blocks: [Block]) -> [Int] {
        var columns: [(x: CGFloat, items: [Int])] = []
        for (i, b) in blocks.enumerated() {
            if let k = columns.firstIndex(where: { abs($0.x - b.rect.minX) < 40 }) { columns[k].items.append(i) }
            else { columns.append((b.rect.minX, [i])) }
        }
        return columns.sorted { $0.x < $1.x }.flatMap { c in c.items.sorted { blocks[$0].rect.minY < blocks[$1].rect.minY } }
    }

    /// 번역 지시 + 이번에 옮기지 않는 화면 글(읽는 순서, 참고용). 문단을 따로따로 옮기면 앞뒤 문맥·용어가 어긋난다.
    /// 옮길 문단(skip)은 번호 목록에 이미 읽는 순서로 들어가므로 빼서 토큰을 아낀다 (Groq 무료는 분당 8000 토큰)
    static func prompt(context blocks: [Block], skip: Set<String> = []) -> String {
        var text = ""
        for i in readingOrder(blocks) where text.count < 3000 && !skip.contains(key(blocks[i].text)) { text += blocks[i].text + "\n" }
        guard !text.isEmpty else { return GroqClient.screenTranslatePrompt }
        return GroqClient.screenTranslatePrompt + "\n\nOther on-screen text in reading order, for context only (do not output it):\n<<<\n" + text + ">>>"
    }

    /// 모델이 가끔 묶음 대부분을 영어 그대로 돌려준다. 그러면 한 번 더 묻고, 또 그러면 그대로인 것은 실패로 친다
    /// (그대로 기억하면 그 문단은 다시는 번역되지 않는다)
    static func checked(_ todo: [String], _ run: () async throws -> [String?]) async throws -> [String?] {
        func echoed(_ out: [String?]) -> Int { zip(todo, out).filter { k, t in t.map { key($0) == key(k) } ?? false }.count }
        var out = try await run()
        guard todo.count >= 4, echoed(out) * 2 > todo.count else { return out }
        Log.warn("화면 번역", "문단 \(todo.count)개 중 \(echoed(out))개를 원문 그대로 받음, 다시 물음")
        out = try await run()
        guard echoed(out) * 2 > todo.count else { return out }
        return zip(todo, out).map { k, t in t.flatMap { key($0) == key(k) ? nil : $0 } }
    }

    /// 옮길 문단인가
    static func translatable(_ b: Block) -> Bool {
        // 세로로 세운 글(그래프 축 이름)은 가로 글로 덮을 수 없다
        let upright = b.rows.contains { $0.rect.height > $0.rect.width * 0.9 && $0.text.count >= 2 }
        // 숫자가 글자보다 많으면 그래프 눈금·날짜 줄 ("Jan 2015 Apr 2015", "2000 2010 2020 Month")
        let digits = b.text.filter(\.isNumber).count, letters = b.text.filter(\.isLetter).count
        return !upright && digits <= letters && needsTranslation(b.text) && !(b.rows.count == 1 && isCode(b.rows[0].text))
    }

    // ── 그림에서 색·굵기 뽑기 ──

    /// 창 그림의 화소. 포인트 좌표로 묻는다
    final class Pixels {
        let width: Int, height: Int
        let scale: CGFloat
        private var data: [UInt8]

        init?(_ image: CGImage, size: CGSize) {
            width = image.width; height = image.height
            scale = CGFloat(image.width) / max(size.width, 1)
            data = [UInt8](repeating: 0, count: width * height * 4)
            let ok = data.withUnsafeMutableBytes { buf -> Bool in
                guard let ctx = CGContext(data: buf.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                          space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return false }
                ctx.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
                return true
            }
            if !ok { return nil }
        }

        /// 화소 (0~1). 위에서부터 센다
        func rgb(_ x: Int, _ y: Int) -> (CGFloat, CGFloat, CGFloat) {
            let cx = min(max(x, 0), width - 1), cy = min(max(y, 0), height - 1)
            let i = (cy * width + cx) * 4
            return (CGFloat(data[i]) / 255, CGFloat(data[i + 1]) / 255, CGFloat(data[i + 2]) / 255)
        }

        func px(_ v: CGFloat) -> Int { Int((v * scale).rounded(.down)) }

        /// 창 위 30%·아래 20% 에서 창 폭의 85% 넘게 색이 바뀌는 가로 경계 (도구막대·탭 막대·상태 막대의 끝). 포인트 y
        func crossLines() -> [CGFloat] {
            let step = max(1, width / 240)
            var out: [CGFloat] = []
            let rows = Array(1..<Int(CGFloat(height) * 0.3)) + Array(Int(CGFloat(height) * 0.8)..<(height - 1))
            for y in rows {
                var n = 0, changed = 0
                for x in stride(from: 0, to: width, by: step) {
                    let a = rgb(x, y - 1), b = rgb(x, y)
                    if max(abs(a.0 - b.0), abs(a.1 - b.1), abs(a.2 - b.2)) > 0.04 { changed += 1 }
                    n += 1
                }
                if changed * 100 > n * 85 { out.append(CGFloat(y) / scale) }
            }
            return out
        }

        /// 상자 둘레(바로 바깥 띠)에서 가장 많은 색 = 바탕색
        func background(around r: CGRect) -> NSColor {
            var bins: [Int: (n: Int, r: CGFloat, g: CGFloat, b: CGFloat)] = [:]
            let x0 = px(r.minX) - 3, x1 = px(r.maxX) + 3, y0 = px(r.minY) - 3, y1 = px(r.maxY) + 3
            let step = max(1, (x1 - x0) / 200)
            func add(_ x: Int, _ y: Int) {
                let (cr, cg, cb) = rgb(x, y)
                let k = Int(cr * 15) << 8 | Int(cg * 15) << 4 | Int(cb * 15)
                let e = bins[k] ?? (0, 0, 0, 0)
                bins[k] = (e.n + 1, e.r + cr, e.g + cg, e.b + cb)
            }
            for x in stride(from: x0, through: x1, by: step) { add(x, y0); add(x, y1) }
            for y in stride(from: y0, through: y1, by: max(1, (y1 - y0) / 40)) { add(x0, y); add(x1, y) }
            guard let best = bins.values.max(by: { $0.n < $1.n }) else { return .white }
            let n = CGFloat(best.n)
            return NSColor(deviceRed: best.r / n, green: best.g / n, blue: best.b / n, alpha: 1)
        }

        private func far(_ c: (CGFloat, CGFloat, CGFloat), from bg: (CGFloat, CGFloat, CGFloat)) -> Bool {
            max(abs(c.0 - bg.0), abs(c.1 - bg.1), abs(c.2 - bg.2)) > 0.3
        }

        /// 상자 안에서 글자색에 가까운(채널 차 0.25 안) 화소 수 (2화소 간격으로 센다)
        func inkCount(_ r: CGRect, ink: NSColor) -> Int {
            let c = comps(ink)
            var n = 0
            for y in stride(from: px(r.minY), to: px(r.maxY), by: 2) {
                for x in stride(from: px(r.minX), to: px(r.maxX), by: 2) {
                    let p = rgb(x, y)
                    if max(abs(p.0 - c.0), abs(p.1 - c.1), abs(p.2 - c.2)) < 0.25 { n += 1 }
                }
            }
            return n
        }

        private func comps(_ c: NSColor) -> (CGFloat, CGFloat, CGFloat) {
            let d = c.usingColorSpace(.deviceRGB) ?? .white
            return (d.redComponent, d.greenComponent, d.blueComponent)
        }

        /// 글자색: 줄 안에서 바탕과 가장 먼 화소들의 평균. ratio: 줄 안에서 글자 화소의 비율 (굵기 짐작)
        func ink(in r: CGRect, bg: NSColor) -> (color: NSColor, ratio: CGFloat) {
            let b = comps(bg)
            var sum = (CGFloat(0), CGFloat(0), CGFloat(0)), n = 0, total = 0, best: CGFloat = 0
            let x0 = px(r.minX), x1 = px(r.maxX), y0 = px(r.minY + r.height * 0.2), y1 = px(r.maxY - r.height * 0.2)
            guard x1 > x0, y1 > y0 else { return (contrast(bg), 0) }
            let sx = max(1, (x1 - x0) / 300)
            var samples: [((CGFloat, CGFloat, CGFloat), CGFloat)] = []
            for y in y0..<y1 {
                for x in stride(from: x0, to: x1, by: sx) {
                    let c = rgb(x, y)
                    total += 1
                    let d = max(abs(c.0 - b.0), abs(c.1 - b.1), abs(c.2 - b.2))
                    if d > 0.3 { samples.append((c, d)); best = max(best, d) }
                }
            }
            // 글자 가장자리(번진 화소)를 빼고 바탕과 충분히 먼 것만 평균
            for (c, d) in samples where d > best * 0.75 {
                sum.0 += c.0; sum.1 += c.1; sum.2 += c.2; n += 1
            }
            guard n > 0 else { return (contrast(bg), 0) }
            let k = CGFloat(n)
            return (NSColor(deviceRed: sum.0 / k, green: sum.1 / k, blue: sum.2 / k, alpha: 1), CGFloat(samples.count) / CGFloat(max(total, 1)))
        }

        /// 상자 오른쪽으로 바탕만 이어지는 폭 (다른 줄·그림을 만나면 멈춘다)
        func freeRight(of r: CGRect, bg: NSColor, limit: CGFloat, others: [CGRect]) -> CGFloat {
            let b = comps(bg)
            let y0 = px(r.minY), y1 = px(r.maxY)
            guard y1 > y0 else { return 0 }
            let sy = max(1, (y1 - y0) / 12)
            var w: CGFloat = 0
            while w < limit {
                let x = r.maxX + w + 1
                let col = CGRect(x: x, y: r.minY, width: 1, height: r.height)
                if others.contains(where: { $0.intersects(col) }) { break }
                let xp = px(x)
                if xp >= width { break }
                if stride(from: y0, to: y1, by: sy).contains(where: { far(rgb(xp, $0), from: b) }) { break }
                w += 2
            }
            return max(0, w - 4)
        }

        /// 글자 인식 상자가 첫·끝 글자를 놓친 만큼 옆으로 넓힌다: 상자 밖으로 이어진 글자색 화소를 따라간다
        /// (바탕과 다르기만 한 화소는 따라가지 않는다: 형광펜 띠 바깥의 흰 바탕을 글자로 보지 않게)
        func inkExtent(_ r: CGRect, ink: NSColor) -> CGRect {
            let k = comps(ink)
            let y0 = px(r.minY + r.height * 0.15), y1 = px(r.maxY - r.height * 0.15)
            guard y1 > y0 else { return r }
            func hasInk(_ x: Int) -> Bool { (y0..<y1).contains { !far(rgb(x, $0), from: k) } }
            let reach = px(r.height * 1.2), gapMax = px(r.height * 0.3)
            func walk(from start: Int, dir: Int) -> Int {
                var x = start, last = start - dir, gap = 0
                while abs(x - start) < reach, x >= 0, x < width {
                    if hasInk(x) { last = x; gap = 0 } else { gap += 1; if gap > gapMax { break } }
                    x += dir
                }
                return last
            }
            let left = walk(from: px(r.minX) - 1, dir: -1), right = walk(from: px(r.maxX) + 1, dir: 1)
            let minX = min(r.minX, CGFloat(left + 1) / scale), maxX = max(r.maxX, CGFloat(right) / scale)
            return CGRect(x: minX, y: r.minY, width: maxX - minX, height: r.height)
        }
    }

    /// 글자 크기 짐작: 줄 안 글자 화소의 세로 분포에서 가장 빽빽한 띠(라틴 글자의 x 높이, 한중일 글자의 몸통)를 잰다.
    /// 상자 높이는 g·p 같은 꼬리 유무로 달라져서 쓰지 않는다. 못 재면 nil
    static func xBand(_ p: Pixels, _ r: CGRect, ink: NSColor) -> CGFloat? {
        let k = (ink.usingColorSpace(.deviceRGB) ?? .black)
        let kc = (k.redComponent, k.greenComponent, k.blueComponent)
        let y0 = p.px(r.minY - r.height * 0.1), y1 = p.px(r.maxY + r.height * 0.1)
        let x0 = p.px(r.minX), x1 = p.px(r.maxX)
        guard y1 > y0 + 4, x1 > x0 + 4 else { return nil }
        let sx = max(1, (x1 - x0) / 400)
        let counts: [Int] = (y0..<y1).map { y in
            stride(from: x0, to: x1, by: sx).reduce(0) { n, x in
                let c = p.rgb(x, y)
                return max(abs(c.0 - kc.0), abs(c.1 - kc.1), abs(c.2 - kc.2)) < 0.3 ? n + 1 : n
            }
        }
        guard let peak = counts.max(), peak > 2 else { return nil }
        let dense = counts.enumerated().filter { CGFloat($0.element) >= CGFloat(peak) * 0.4 }.map(\.offset)
        guard let a = dense.first, let b = dense.last, b > a else { return nil }
        return CGFloat(b - a + 1) / p.scale
    }

    /// 띠 높이 → 글자 크기. 라틴 x 높이 ≈ 0.52em, 대문자·숫자가 대부분이면 대문자 높이 ≈ 0.7em, 한자·가나·한글 몸통 ≈ 0.8em
    static func fontSize(band: CGFloat, text: String) -> CGFloat {
        let cjk = text.unicodeScalars.filter { (0x3040...0x30FF).contains($0.value) || (0x4E00...0x9FFF).contains($0.value) || (0xAC00...0xD7A3).contains($0.value) }.count
        let letters = max(text.unicodeScalars.filter { $0.properties.isAlphabetic }.count, 1)
        if cjk * 2 > letters { return band / 0.8 }
        let lower = text.unicodeScalars.filter { $0.properties.isLowercase }.count
        let tall = text.unicodeScalars.filter { $0.properties.isUppercase || ("0"..."9").contains(Character($0)) }.count
        return band / (tall > lower ? 0.7 : 0.52)
    }

    static func contrast(_ bg: NSColor) -> NSColor {
        let c = bg.usingColorSpace(.deviceRGB) ?? .white
        return 0.299 * c.redComponent + 0.587 * c.greenComponent + 0.114 * c.blueComponent > 0.5 ? .black : .white
    }

    // ── 자리 잡기 ──

    /// 글자 인식 상자 높이 → 글꼴 크기. 시험 그림(시스템 글꼴 11~40pt)에서 잰 값
    static var fontPerHeight: CGFloat = 0.82

    /// 문단 자리에 번역을 채운다. 원래 크기에서 시작해 자리에 들어갈 때까지 줄인다 (원래의 60% 까지)
    /// 문단마다 글자 크기: 줄마다 잰 크기의 가운데 값, 그리고 비슷한(±12%) 문단끼리 맞춘다
    static func sizes(_ blocks: [Block], pixels: Pixels) -> [CGFloat] {
        let raw: [CGFloat] = blocks.map { b in
            let bg = pixels.background(around: b.rect)
            let est = b.rows.compactMap { r -> CGFloat? in
                let ink = pixels.ink(in: r.rect, bg: bg).color
                return xBand(pixels, r.rect, ink: ink).map { fontSize(band: $0, text: r.text) }
            }.sorted()
            // 못 재면 상자 높이로
            // 짝수면 작은 쪽 가운데값 (두 줄 문단에서 큰 쪽 오측이 이기지 않게)
            return est.isEmpty ? b.rowHeight * fontPerHeight : min(est[(est.count - 1) / 2], b.rowHeight * 1.25)
        }
        return raw.map { s in
            let near = raw.filter { abs($0 - s) <= s * 0.12 }.sorted()
            return near[near.count / 2]
        }
    }

    /// others: 이 문단 밖의 줄 상자. 덮개가 이웃 줄을 가리지 않게 위아래를 깎는다 (인식 상자가 실제 글보다 클 때가 있다)
    static func layout(_ b: Block, id: Int, translation: String, pixels: Pixels, boldRatio: CGFloat = 0.26, size fitted: CGFloat? = nil,
                       others: [CGRect] = []) -> Item {
        let bg = pixels.background(around: b.rect)
        let first = pixels.ink(in: b.rows[0].rect, bg: bg)
        let rowsCovered = b.rows.map { pixels.inkExtent($0.rect, ink: first.color) }
        let raw = rowsCovered.dropFirst().reduce(rowsCovered[0]) { $0.union($1) }
        let pad = b.rowHeight * 0.12
        // 양옆을 조금 더 덮는다 (굵은 글자 가장자리가 남지 않게)
        var rect = raw.insetBy(dx: -max(2, b.rowHeight * 0.08), dy: -pad)
        for o in others where o.minX < rect.maxX && o.maxX > rect.minX && o.minY < rect.maxY && o.maxY > rect.minY {
            if o.midY > raw.midY { rect.size.height = max(raw.height * 0.6, o.minY - 1 - rect.minY) }
            else { let bottom = rect.maxY; rect.origin.y = min(raw.midY - raw.height * 0.3, o.maxY + 1); rect.size.height = bottom - rect.minY }
        }
        let (ink, ratio) = first
        let bold = ratio > boldRatio
        // 잰 크기가 상자보다 터무니없이 크면(그림 속 글, 잘못 잰 띠) 상자 높이로 막는다
        let base = min(fitted ?? b.rowHeight * fontPerHeight, b.rowHeight * 1.3)
        // 여러 줄이면 원래 줄 간격을 글자 크기 비율로 지킨다
        let pitchPerSize = b.pitch / max(base, 1)
        var size = base
        // 코드 주석은 고정폭으로 (둘레 코드와 같은 모양)
        let mono = isComment(b.text)
        func make(_ z: CGFloat) -> NSFont {
            mono ? .monospacedSystemFont(ofSize: z, weight: bold ? .semibold : .regular) : .systemFont(ofSize: z, weight: bold ? .semibold : .regular)
        }
        var font = make(size)
        var line = rect.height
        // 안 들어가면 줄이기 전에 오른쪽 빈 바탕으로 먼저 넓힌다 (원래 폭의 1.6배까지)
        let fullLine = b.rows.count > 1 ? base * pitchPerSize : rect.height
        if textHeight(translation, font: font, width: rect.width, lineHeight: fullLine) > rect.height + fullLine * 0.2 {
            let free = pixels.freeRight(of: rect, bg: bg, limit: rect.width * 0.6, others: others)
            rect.size.width += free
        }
        while size > base * 0.6 {
            font = make(size)
            line = b.rows.count > 1 ? size * pitchPerSize : rect.height
            if textHeight(translation, font: font, width: rect.width, lineHeight: line) <= rect.height + line * 0.2 { break }
            size -= 0.5
        }
        return Item(id: id, rect: rect, text: translation, font: font, lineHeight: line, bg: bg, ink: ink)
    }

    static func attributed(_ text: String, font: NSFont, lineHeight: CGFloat, color: NSColor) -> NSAttributedString {
        let p = NSMutableParagraphStyle()
        p.minimumLineHeight = lineHeight
        p.maximumLineHeight = lineHeight
        p.lineBreakMode = .byWordWrapping
        p.lineBreakStrategy = .hangulWordPriority          // 한국어도 낱말 단위로 줄을 바꾼다 ("원리와 실/무" 방지)
        return NSAttributedString(string: text, attributes: [.font: font, .foregroundColor: color, .paragraphStyle: p])
    }

    static func textHeight(_ text: String, font: NSFont, width: CGFloat, lineHeight: CGFloat) -> CGFloat {
        attributed(text, font: font, lineHeight: lineHeight, color: .black)
            .boundingRect(with: CGSize(width: width, height: 10_000), options: [.usesLineFragmentOrigin, .usesFontLeading]).height
    }

    /// 덮개 하나를 지금 그리기 판(위가 0 인 뒤집힌 판)에 그린다. 화면 덮개와 개발용 그림이 같은 길을 쓴다
    static func draw(_ it: Item) {
        it.bg.setFill()
        NSBezierPath(roundedRect: it.rect, xRadius: 2, yRadius: 2).fill()
        let s = attributed(it.text, font: it.font, lineHeight: it.lineHeight, color: it.ink)
        let h = s.boundingRect(with: CGSize(width: it.rect.width, height: 10_000), options: [.usesLineFragmentOrigin, .usesFontLeading]).height
        // 한 줄짜리는 세로 가운데, 여러 줄 문단은 원래처럼 위에서부터
        let single = it.lineHeight >= it.rect.height * 0.8
        let top = it.rect.minY + (single ? max(0, (it.rect.height - h) / 2) : 0)
        NSGraphicsContext.current?.cgContext.saveGState()
        NSBezierPath(rect: it.rect.insetBy(dx: 0, dy: -it.lineHeight * 0.3)).addClip()
        s.draw(with: CGRect(x: it.rect.minX, y: top, width: it.rect.width, height: max(h, it.rect.height)),
               options: [.usesLineFragmentOrigin, .usesFontLeading])
        NSGraphicsContext.current?.cgContext.restoreGState()
    }

    // ── 한 장 처리 (화면·개발용 공통) ──

    struct Page {
        var rows: [Row] = []
        var blocks: [Block] = []
        /// 문단마다 쓸 글자 크기 (비슷한 것끼리 맞춘 값)
        var sizes: [CGFloat] = []

        /// i 번째 문단 밖의 모든 줄 상자
        func others(_ i: Int) -> [CGRect] {
            blocks.enumerated().filter { $0.offset != i }.flatMap { $0.element.rows.map(\.rect) }
        }
        var pixels: Pixels?
        /// 이보다 글자 화소가 빽빽하면 굵은 글씨. 이 화면 보통 글씨의 1.3배
        var boldRatio: CGFloat = 0.26
        /// 창을 가로지르는 경계선 (도구막대 아래 등). 스크롤되는 내용은 여기서 잘린다
        var edges: [CGFloat] = []
        /// 경계에 잘린 줄이 붙어 있는 문단 (번호). 반쯤 가려진 줄은 글자 인식이 아예 못 읽어서,
        /// 문단이 둘째 줄부터 멀쩡하게 시작하는 것처럼 보인다
        var cut: Set<Int> = []
    }

    static func analyze(_ image: CGImage, size: CGSize, lines: [Explain.Line]) -> Page {
        guard let pixels = Pixels(image, size: size) else { return Page() }
        let rs = rows(lines, size: size)
        let found = rs.map { r in pixels.ink(in: r.rect, bg: pixels.background(around: r.rect)) }
        let ratios = found.map(\.ratio).sorted()
        let typical = ratios.isEmpty ? 0.2 : ratios[ratios.count / 2]
        var page = Page(rows: rs, pixels: pixels, boldRatio: max(typical * 1.3, 0.12))
        let rowSizes = zip(rs, found).map { r, f in xBand(pixels, r.rect, ink: f.color).map { fontSize(band: $0, text: r.text) } }
        page.blocks = blocks(rs, ink: found.map(\.color), size: rowSizes)
        page.sizes = sizes(page.blocks, pixels: pixels)
        page.edges = pixels.crossLines()
        page.cut = cutBlocks(page.blocks, rows: rs, pixels: pixels, edges: page.edges + [0, size.height])
        return page
    }

    /// 경계와 문단 사이(줄 높이 2.5배 안)에 다른 줄이 없는데 글자색 화소가 있으면, 읽히지 않은 잘린 줄이 있는 것
    static func cutBlocks(_ blocks: [Block], rows: [Row], pixels: Pixels, edges: [CGFloat]) -> Set<Int> {
        var out: Set<Int> = []
        for (i, b) in blocks.enumerated() {
            let reach = 2.5 * b.rowHeight
            let ink = pixels.ink(in: b.rows[0].rect, bg: pixels.background(around: b.rect)).color
            // 바로 위·아래 경계만 (더 먼 경계와의 사이엔 가까운 경계선 자체가 끼어 글자로 세진다)
            let above = edges.filter { $0 <= b.rect.minY }.max(), below = edges.filter { $0 >= b.rect.maxY }.min()
            for e in [above, below].compactMap({ $0 }) {
                let band: CGRect
                // 경계선 자체(도구막대 테두리·그림자)를 세지 않게 경계에서 3pt 떨어져 본다
                if e <= b.rect.minY && b.rect.minY - e < reach {
                    band = CGRect(x: b.rect.minX, y: e + 3, width: b.rect.width, height: b.rect.minY - e - 4)
                } else if e >= b.rect.maxY && e - b.rect.maxY < reach {
                    band = CGRect(x: b.rect.minX, y: b.rect.maxY + 1, width: b.rect.width, height: e - b.rect.maxY - 4)
                } else { continue }
                guard band.height > 1, !rows.contains(where: { $0.rect.intersects(band) }) else { continue }
                // 글자 조각이라 할 만큼 (띠 넓이의 0.3% 넘게, 최소 6화소)
                let area = Int(band.width * band.height * pixels.scale * pixels.scale / 4)
                if pixels.inkCount(band, ink: ink) > max(6, area * 3 / 1000) { out.insert(i); break }
            }
        }
        return out
    }

    // ── 개발용: 그림 파일로 시험 ──

    /// EZRITE_TRANSLATE_IMAGE=<png 또는 폴더> EZRITE_TRANSLATE_OUT=<폴더>: 그림마다 읽기 → 옮기기 → 덮은 그림(이름.png)과
    /// 상자 그림(이름-boxes.png: 빨강 글자 인식 조각, 초록 줄, 파랑 문단)을 남기고 끝낸다. 2배 해상도 그림으로 본다.
    /// EZRITE_TRANSLATE_FAKE 면 AI 없이 원문 앞에 "번역:" 을 붙인다
    static func devRun(input: String, output: String, fake: Bool) async {
        let fm = FileManager.default
        var isDir: ObjCBool = false
        fm.fileExists(atPath: input, isDirectory: &isDir)
        let files = isDir.boolValue
            ? ((try? fm.contentsOfDirectory(atPath: input)) ?? []).filter { $0.hasSuffix(".png") }.sorted().map { input + "/" + $0 }
            : [input]
        try? fm.createDirectory(atPath: output, withIntermediateDirectories: true)
        let groq = GroqClient()
        for f in files {
            guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: f) as CFURL, nil),
                  let image = CGImageSourceCreateImageAtIndex(src, 0, nil) else { print("못 읽음", f); continue }
            let size = CGSize(width: CGFloat(image.width) / 2, height: CGFloat(image.height) / 2)
            let t0 = Date()
            let lines = Explain.readText(image)
            let page = analyze(image, size: size, lines: lines)
            let todo = readingOrder(page.blocks).filter { !page.cut.contains($0) }.map { page.blocks[$0] }
                .filter { translatable($0) && !touchesEdge($0, height: size.height, edges: page.edges) }
            print("   잘린 문단:", page.cut.sorted().map { String(page.blocks[$0].text.prefix(30)) })
            print("   경계선 y:", page.edges.map { String(format: "%.0f", $0) }.joined(separator: " "))
            let t1 = Date()
            var out: [String?] = []
            if fake { out = todo.map { "번역: " + $0.text } }
            else {
                for chunk in stride(from: 0, to: todo.count, by: batch) {
                    let part = Array(todo[chunk..<min(chunk + batch, todo.count)]).map(\.text)
                    let context = prompt(context: page.blocks, skip: Set(part.map(key)))
                    // EZRITE_TRANSLATE_PROVIDER=claude:claude-haiku-5-5 면 그 서비스로 (설정의 번역 서비스와 같은 경로)
                    let other = ProcessInfo.processInfo.environment["EZRITE_TRANSLATE_PROVIDER"].flatMap { v -> (Provider, String)? in
                        let f = v.split(separator: ":", maxSplits: 1).map(String.init)
                        return f.count == 2 ? Provider(rawValue: f[0]).map { ($0, f[1]) } : nil
                    }
                    do { let r = try await checked(part) {
                            if let (p, m) = other { return try await Translation.other(p, model: m, part, context: [], prompt: context) }
                            return try await groq.translate(part, prompt: context, models: GroqClient.screenModels)
                        }; out += r
                        let same = zip(part, r).filter { p, t in t.map { key($0) == key(p) } ?? false }.count
                        print("   묶음 \(chunk / batch + 1): \(part.count)개 중 \(r.compactMap { $0 }.count)개 받음, 원문 그대로 \(same)개")
                    } catch { out += part.map { _ in nil }; print("   묶음 \(chunk / batch + 1) 실패:", error) }
                }
            }
            let done = Dictionary(zip(todo.map(\.text), out).compactMap { k, v in v.map { (k, $0) } }, uniquingKeysWith: { a, _ in a })
            let items = page.blocks.enumerated().compactMap { i, b -> Item? in
                guard let t = done[b.text], let px = page.pixels, key(t) != key(b.text) else { return nil }
                return layout(b, id: i, translation: t, pixels: px, boldRatio: page.boldRatio, size: page.sizes[i], others: page.others(i))
            }
            let name = ((f as NSString).lastPathComponent as NSString).deletingPathExtension
            print(String(format: "%@: 조각 %d → 줄 %d → 문단 %d, 옮김 %d/%d, 읽기 %.2f초, 번역 %.2f초", name, lines.count, page.rows.count,
                         page.blocks.count, items.count, todo.count, t1.timeIntervalSince(t0), Date().timeIntervalSince(t1)))
            for (b, z) in zip(page.blocks, page.sizes) { print(String(format: "   [%@] h%.1f %.1fpt %@", translatable(b) ? "옮김" : "둠", b.rowHeight, z, String(b.text.prefix(60)))) }
            save(image, size: size, to: output + "/" + name + ".png") { items.forEach(draw) }
            save(image, size: size, to: output + "/" + name + "-boxes.png") {
                NSColor.systemRed.setStroke(); lines.forEach { l in
                    NSBezierPath(rect: CGRect(x: l.box.minX * size.width, y: l.box.minY * size.height, width: l.box.width * size.width, height: l.box.height * size.height)).stroke() }
                NSColor.systemGreen.setStroke(); page.rows.forEach { NSBezierPath(rect: $0.rect.insetBy(dx: -2, dy: -2)).stroke() }
                NSColor.systemBlue.setStroke(); page.blocks.forEach { let p = NSBezierPath(rect: $0.rect.insetBy(dx: -5, dy: -5)); p.lineWidth = 2; p.stroke() }
            }
        }
    }

    private static func save(_ image: CGImage, size: CGSize, to path: String, _ body: () -> Void) {
        guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: image.width, pixelsHigh: image.height, bitsPerSample: 8,
                                         samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                                         bytesPerRow: 0, bitsPerPixel: 0),
              let base = NSGraphicsContext(bitmapImageRep: rep) else { return }
        rep.size = size
        NSGraphicsContext.saveGraphicsState()
        let cg = base.cgContext
        cg.scaleBy(x: CGFloat(image.width) / size.width, y: CGFloat(image.height) / size.height)
        cg.draw(image, in: CGRect(origin: .zero, size: size))
        cg.translateBy(x: 0, y: size.height); cg.scaleBy(x: 1, y: -1)
        NSGraphicsContext.current = NSGraphicsContext(cgContext: cg, flipped: true)
        body()
        NSGraphicsContext.restoreGraphicsState()
        try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: path))
    }
}
