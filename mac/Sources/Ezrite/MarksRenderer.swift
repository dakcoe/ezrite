import SwiftUI

/// 예전 방식(classic) 밖의 화면 표시를 한 장씩 그린다. MarksView 가 TimelineView 로 시간(t: 장면이 바뀐 뒤 초)을 넘긴다.
/// 좌표는 오버레이 포인트(왼쪽 위 원점). R = 글자 상자를 조금 넓힌 상자, Q = 글자 상자 그대로
struct MarksRenderer {
    let m: OverlayModel
    let t: Double
    let size: CGSize
    let R: [Int: CGRect]
    let Q: [Int: CGRect]

    static let accent = Color(red: 1, green: 0.42, blue: 0.17)
    static let pen = Color(red: 0.85, green: 0.21, blue: 0.17)
    static let gray = Color(white: 0.6)
    static let palette: [Color] = [Color(red: 0.49, green: 0.36, blue: 1), Color(red: 0.06, green: 0.62, blue: 0.54),
                                   Color(red: 0.9, green: 0.28, blue: 0.3)]
    static let penFont: Font = NSFont(name: "NanumPen", size: 30) != nil || NSFontManager.shared.availableFontFamilies.contains("Nanum Pen Script")
        ? .custom("Nanum Pen Script", size: 31) : .system(size: 22, weight: .bold, design: .rounded)

    init(model: OverlayModel, t: Double, size: CGSize) {
        m = model; self.t = t; self.size = size
        let lines = model.allLines.filter { !model.missing.contains($0.id) }
        R = MarksView.layout(lines, size: size)
        var q: [Int: CGRect] = [:]
        for l in lines { q[l.id] = CGRect(x: l.box.minX * size.width, y: l.box.minY * size.height,
                                          width: l.box.width * size.width, height: l.box.height * size.height) }
        Q = q
    }

    // MARK: 지금 무엇을 보여 주나

    var current: Int? { m.scene }
    var scenes: [Explain.Scene] { m.scenes }
    var markIDs: [Int] { m.marks.map(\.line.id).filter { R[$0] != nil } }
    /// 경로는 한 칸이라도 화면 밖이면 통째로 숨긴다 (끊긴 화살표는 헷갈린다)
    var pathIDs: [Int] {
        guard let p = m.path, p.steps.allSatisfy({ R[$0.id] != nil }) else { return [] }
        return p.steps.map(\.id)
    }
    func targets(_ i: Int) -> [Int] {
        guard scenes.indices.contains(i) else { return [] }
        let sc = scenes[i]
        var out: [Int] = []
        for id in sc.focus.map(\.id) + [sc.arrow?.from.id, sc.arrow?.to.id].compactMap({ $0 }) where !out.contains(id) && R[id] != nil {
            out.append(id)
        }
        return out
    }
    func arrow(_ i: Int) -> (Int, Int)? {
        guard scenes.indices.contains(i), let a = scenes[i].arrow, R[a.from.id] != nil, R[a.to.id] != nil else { return nil }
        return (a.from.id, a.to.id)
    }
    func focus(_ i: Int) -> [Int] { scenes.indices.contains(i) ? scenes[i].focus.map(\.id).filter { R[$0] != nil } : [] }
    /// 카드에서 마우스를 올린 항목이 가리키는 줄
    var hoverIDs: [Int]? {
        guard let h = m.hover, let n = Int(h.dropFirst()) else { return m.hover == "say" ? current.map(targets) : nil }
        switch h.first {
        case "m": return m.marks.indices.contains(n) ? [m.marks[n].line.id].filter { R[$0] != nil } : nil
        case "s": return targets(n)
        case "p": return pathIDs.indices.contains(n) ? [pathIDs[n]] : nil
        default: return nil
        }
    }
    /// "지금 하나만" 방식이 보여 줄 줄: 마우스 > 지금 장면 > (장면이 없을 때) 짚은 곳 > 없음
    var focusNow: [Int] {
        if let h = hoverIDs { return h }
        if let i = current { return targets(i) }
        return scenes.isEmpty ? markIDs : []
    }
    /// 글자 상자가 가로로 길지 않으면(그림 속 라벨) 밑줄 대신 동그라미
    func blob(_ id: Int) -> Bool { guard let q = Q[id] else { return false }; return q.width < q.height * 2.2 }

    // MARK: 그리기

    func draw(_ g: inout GraphicsContext) {
        switch m.style {
        case .classic: break
        case .spotlight: spotlight(&g)
        case .highlighter: highlighter(&g)
        case .corners: corners(&g)
        case .hover: hover(&g)
        case .colors: colors(&g)
        case .leader: leader(&g)
        case .flow: flow(&g)
        case .trail: trail(&g)
        case .minimap: minimap(&g)
        case .bubble: bubble(&g)
        case .notes: notes(&g)
        case .pen: penMarks(&g)
        }
    }

    /// 표시가 다 그려져 멈추는 때 (초). 그 뒤로는 다시 그리지 않아 CPU 를 쓰지 않는다
    static func settleTime(_ s: MarkStyle) -> Double {
        switch s {
        case .spotlight: return 3.6
        case .flow: return 9
        case .minimap: return 6
        case .pen, .notes, .bubble: return 2.2
        default: return 1.6
        }
    }

    // ── 지금 하나만 ──
    private func spotlight(_ g: inout GraphicsContext) {
        let ids = focusNow
        guard !ids.isEmpty else { return }
        let cur: [CGRect] = ids.compactMap { R[$0]?.insetBy(dx: -8, dy: -8) }
        let prev: [CGRect] = m.previous.compactMap { R[$0]?.insetBy(dx: -8, dy: -8) }
        let k = m.hover == nil ? Self.ease(t / 0.5) : 1
        var shade = Path(CGRect(origin: .zero, size: size))
        for (i, r) in cur.enumerated() {
            let from = prev.isEmpty ? r : prev[min(i, prev.count - 1)]
            shade.addRoundedRect(in: Self.lerp(from, r, k), cornerSize: CGSize(width: 12, height: 12))
        }
        let alpha: Double = m.hover != nil ? 0.45 : t < 0.4 ? 0.6 * t / 0.4 : t < 2.1 ? 0.6 : max(0.2, 0.6 - 0.4 * (t - 2.1) / 1.3)
        g.fill(shade, with: .color(Color(red: 0.02, green: 0.03, blue: 0.07).opacity(alpha)), style: FillStyle(eoFill: true))
        if let i = current, m.hover == nil, let (a, b) = arrow(i) {
            strokeArrow(&g, R[a]!.insetBy(dx: -8, dy: -8), R[b]!.insetBy(dx: -8, dy: -8), Self.accent, 3.5, progress: (t - 0.45) / 0.6)
        }
    }

    private func highlighter(_ g: inout GraphicsContext) {
        let ids = focusNow
        var layer = g
        layer.blendMode = .multiply
        for (k, id) in ids.enumerated() {
            guard let q = Q[id] else { continue }
            let band = blob(id) ? CGRect(x: q.minX - 8, y: q.minY + q.height * 0.28, width: q.width + 16, height: q.height * 0.44)
                                : CGRect(x: q.minX - 3, y: q.minY + q.height * 0.45, width: q.width + 6, height: q.height * 0.55)
            let p = m.hover == nil ? Self.ease((t - Double(k) * 0.4) / 0.45) : 1
            guard p > 0 else { continue }
            let r = CGRect(x: band.minX, y: band.minY, width: band.width * p, height: band.height)
            layer.fill(Path(roundedRect: r, cornerRadius: 3), with: .color(Color(red: 1, green: 0.84, blue: 0.04).opacity(0.55)))
        }
        if let i = current, m.hover == nil, let (a, b) = arrow(i) {
            strokeArrow(&g, R[a]!, R[b]!, Color(red: 0.94, green: 0.7, blue: 0), 5, bend: 16, progress: (t - 0.35) / 0.6)
        }
    }

    private func corners(_ g: inout GraphicsContext) {
        let pop = m.hover == nil ? min(1, t / 0.3) : 1
        for id in focusNow {
            guard let r0 = R[id] else { continue }
            let r = r0.insetBy(dx: -3, dy: -3), L: CGFloat = 13
            if m.hover == nil, t < 0.9 {
                let s = 1 + 0.35 * t / 0.9
                let ring = CGRect(x: r.midX - r.width * s / 2, y: r.midY - r.height * s / 2, width: r.width * s, height: r.height * s)
                g.stroke(Path(roundedRect: ring, cornerRadius: 8), with: .color(Self.accent.opacity(0.9 * (1 - t / 0.9))), lineWidth: 2.5)
            }
            var c = Path()
            c.move(to: CGPoint(x: r.minX, y: r.minY + L)); c.addLine(to: CGPoint(x: r.minX, y: r.minY)); c.addLine(to: CGPoint(x: r.minX + L, y: r.minY))
            c.move(to: CGPoint(x: r.maxX - L, y: r.minY)); c.addLine(to: CGPoint(x: r.maxX, y: r.minY)); c.addLine(to: CGPoint(x: r.maxX, y: r.minY + L))
            c.move(to: CGPoint(x: r.maxX, y: r.maxY - L)); c.addLine(to: CGPoint(x: r.maxX, y: r.maxY)); c.addLine(to: CGPoint(x: r.maxX - L, y: r.maxY))
            c.move(to: CGPoint(x: r.minX + L, y: r.maxY)); c.addLine(to: CGPoint(x: r.minX, y: r.maxY)); c.addLine(to: CGPoint(x: r.minX, y: r.maxY - L))
            shadowed(&g) { $0.stroke(c, with: .color(Self.accent.opacity(pop)), style: StrokeStyle(lineWidth: 3.5, lineCap: .round, lineJoin: .round)) }
        }
        if let i = current, m.hover == nil, let (a, b) = arrow(i) {
            let op = min(1, max(0, (t - 0.3) / 0.3))
            let (line, head) = Self.arrowParts(R[a]!, R[b]!, gap: 9)
            shadowed(&g) {
                $0.stroke(line, with: .color(Self.accent.opacity(op)), style: StrokeStyle(lineWidth: 2.5, lineCap: .round, dash: [1, 7]))
                $0.stroke(head, with: .color(Self.accent.opacity(op)), style: StrokeStyle(lineWidth: 2.5, lineCap: .round, lineJoin: .round))
            }
        }
    }

    // ── 카드와 짝 ──
    private func hover(_ g: inout GraphicsContext) {
        let soft: [Int] = current.map(focus) ?? (scenes.isEmpty ? markIDs : [])
        for id in soft { if let r = R[id] { g.fill(Path(roundedRect: r, cornerRadius: 7), with: .color(Self.accent.opacity(0.13 * min(1, t / 0.4)))) } }
        if let i = current, let (a, b) = arrow(i) {
            strokeArrow(&g, R[a]!, R[b]!, Self.accent.opacity(0.55), 2)
        }
        for id in hoverIDs ?? [] {
            guard let r = R[id] else { continue }
            shadowed(&g, glow: true) {
                $0.fill(Path(roundedRect: r, cornerRadius: 7), with: .color(Self.accent.opacity(0.14)))
                $0.stroke(Path(roundedRect: r, cornerRadius: 7), with: .color(Self.accent), lineWidth: 3)
            }
        }
    }

    func color(of id: Int) -> Color? {
        guard let i = m.marks.firstIndex(where: { $0.line.id == id }) else { return nil }
        return Self.palette[i % Self.palette.count]
    }

    private func colors(_ g: inout GraphicsContext) {
        let p = min(1, t / 0.45)
        func mark(_ id: Int, _ c: Color) {
            guard let q = Q[id] else { return }
            if blob(id) {
                let rr = max(q.width, q.height) / 2 + 6
                shadowed(&g) { $0.stroke(Path(ellipseIn: CGRect(x: q.midX - rr, y: q.midY - rr, width: rr * 2, height: rr * 2)), with: .color(c.opacity(p)), lineWidth: 4) }
            } else {
                g.fill(Path(roundedRect: q.insetBy(dx: -5, dy: -2), cornerRadius: 5), with: .color(c.opacity(0.12 * p)))
                let bar = CGRect(x: q.minX - 3, y: q.maxY + 1, width: (q.width + 6) * p, height: 4)
                shadowed(&g) { $0.fill(Path(roundedRect: bar, cornerRadius: 2), with: .color(c)) }
            }
        }
        if let i = current {
            if let (a, b) = arrow(i) { strokeArrow(&g, R[a]!, R[b]!, Color(white: 0.3), 2.5, progress: t / 0.6) }
            for id in focus(i) { mark(id, color(of: id) ?? Color(white: 0.25)) }
        } else {
            let path = pathIDs
            for k in path.indices.dropLast() {
                strokeArrow(&g, R[path[k]]!, R[path[k + 1]]!, Self.gray, 2.5, dash: [7, 6])
            }
            for id in markIDs { mark(id, color(of: id)!) }
        }
    }

    private func leader(_ g: inout GraphicsContext) {
        func lead(_ from: CGPoint, _ id: Int, _ op: Double, _ k: Int) {
            guard let r = R[id], let q = Q[id] else { return }
            let node = blob(id)
            let to = node ? CGPoint(x: r.midX, y: r.minY) : CGPoint(x: r.maxX, y: r.midY)
            var line = Path()
            line.move(to: from)
            line.addCurve(to: to, control1: CGPoint(x: from.x - 140, y: from.y),
                          control2: node ? CGPoint(x: to.x, y: to.y - 110) : CGPoint(x: to.x + 130, y: to.y))
            let p = Self.ease((t - Double(k) * 0.15) / 0.6)
            shadowed(&g) {
                $0.opacity = op
                $0.stroke(line.trimmedPath(from: 0, to: p), with: .color(Self.accent), lineWidth: 2)
                $0.fill(Path(ellipseIn: CGRect(x: from.x - 4.5, y: from.y - 4.5, width: 9, height: 9)), with: .color(Self.accent))
                if p >= 1 { $0.fill(Path(ellipseIn: CGRect(x: to.x - 4.5, y: to.y - 4.5, width: 9, height: 9)), with: .color(Self.accent)) }
                if node {
                    let rr = max(q.width, q.height) / 2 + 5
                    $0.stroke(Path(ellipseIn: CGRect(x: q.midX - rr, y: q.midY - rr, width: rr * 2, height: rr * 2)), with: .color(Self.accent), lineWidth: 3)
                } else {
                    var u = Path(); u.move(to: CGPoint(x: q.minX, y: q.maxY + 3)); u.addLine(to: CGPoint(x: q.maxX, y: q.maxY + 3))
                    $0.stroke(u, with: .color(Self.accent), lineWidth: 3)
                }
            }
        }
        if let i = current {
            let ids = focus(i)
            if let a = m.anchors["say"] { for (k, id) in ids.enumerated() { lead(a, id, 1, k) } }
            else { for id in ids { underline(&g, id, Self.accent, 3, progress: 1) } }
            if let (a, b) = arrow(i) { strokeArrow(&g, R[a]!, R[b]!, Self.accent, 2.5, progress: (t - 0.5) / 0.5) }
        } else {
            for (k, mk) in m.marks.enumerated() where R[mk.line.id] != nil {
                let ref = "m\(k)"
                let op = m.hover == nil ? 0.5 : (m.hover == ref ? 1 : 0.12)
                if let a = m.anchors[ref] { lead(a, mk.line.id, op, k) } else { underline(&g, mk.line.id, Self.accent.opacity(op), 3, progress: 1) }
            }
        }
    }

    // ── 순서를 남기기 ──
    private func flow(_ g: inout GraphicsContext) {
        var segs: [(CGRect, CGRect)] = []
        if let i = current { if let (a, b) = arrow(i) { segs = [(R[a]!, R[b]!)] } }
        else { let p = pathIDs; for k in p.indices.dropLast() { segs.append((R[p[k]]!, R[p[k + 1]]!)) } }
        for (a, b) in segs {
            let (line, _) = Self.arrowParts(a, b, gap: 6)
            g.stroke(line, with: .color(Self.gray), style: StrokeStyle(lineWidth: 2.5, lineCap: .round, dash: [2, 7]))
        }
        let sweep: [Int] = current.map { i in focus(i).filter { id in arrow(i)?.0 != id && !blob(id) } }
            ?? markIDs.filter { !blob($0) && !pathIDs.contains($0) }
        for id in sweep { underline(&g, id, current == nil ? Self.gray : Self.accent, 3.5, progress: t / 1.0) }
        if current == nil, segs.isEmpty { for id in markIDs where blob(id) { ring(&g, id, Self.accent.opacity(0.6), 3) } }
        guard !segs.isEmpty else { return }
        let per = 0.95, rest = current == nil ? 0.9 : 1.3, cycle = Double(segs.count) * per + rest
        let done = t >= RendererTimes.flowCycles * cycle
        let tc = done ? cycle - 0.0001 : t.truncatingRemainder(dividingBy: cycle)
        for (j, (_, b)) in segs.enumerated() {
            let hit = tc - Double(j + 1) * per
            let base: Double = current == nil ? 0.25 : (done ? 0.9 : 0)
            let op = hit >= 0 ? max(current == nil ? 0.25 : 0.9, 1 - hit / 0.9) : base
            if op > 0, let id = R.first(where: { $0.value == b })?.key, let q = Q[id] {
                let rr = max(q.width, q.height) / 2 + 6
                g.stroke(Path(ellipseIn: CGRect(x: q.midX - rr, y: q.midY - rr, width: rr * 2, height: rr * 2)), with: .color(Self.accent.opacity(op)), lineWidth: 3.5)
            }
        }
        guard !done else { return }
        let k = min(segs.count - 1, Int(tc / per))
        let moving = tc < Double(segs.count) * per
        let f = moving ? Self.ease((tc - Double(k) * per) / per) : 1
        let (line, _) = Self.arrowParts(segs[k].0, segs[k].1, gap: 6)
        let pt = line.trimmedPath(from: 0, to: max(0.001, f)).currentPoint ?? .zero
        let op = moving ? 1 : max(0, 1 - (tc - Double(segs.count) * per) / 0.4)
        var glow = g
        glow.addFilter(.shadow(color: Self.accent.opacity(0.9 * op), radius: 7))
        glow.fill(Path(ellipseIn: CGRect(x: pt.x - 8, y: pt.y - 8, width: 16, height: 16)), with: .color(Self.accent.opacity(op)))
    }

    private func trail(_ g: inout GraphicsContext) {
        if scenes.isEmpty {                 // 질문의 답·장면 없는 설명: 짚은 곳 번호 = 카드 목록 번호
            let p = pathIDs
            for k in p.indices.dropLast() { strokeArrow(&g, R[p[k]]!, R[p[k + 1]]!, Self.accent.opacity(0.5), 2.2) }
            for (n, id) in markIDs.enumerated() {
                if m.hover == "m\(n)", let r = R[id] { g.stroke(Path(roundedRect: r, cornerRadius: 7), with: .color(Self.accent), lineWidth: 2.8) }
                trailBadge(&g, id, "\(n + 1)", Self.accent)
            }
            return
        }
        let upto = current ?? scenes.count - 1
        let cur: Int = current ?? (m.hover?.first == "s" ? Int(m.hover!.dropFirst()) ?? -1 : -1)
        var nums: [Int: [Int]] = [:]
        var order: [Int] = []
        for k in 0...max(0, upto) { for id in targets(k) { if nums[id] == nil { order.append(id) }; nums[id, default: []].append(k) } }
        for k in 0...max(0, upto) {
            guard let (a, b) = arrow(k) else { continue }
            if k == cur { strokeArrow(&g, R[a]!, R[b]!, Self.accent, 3.5, progress: current == nil ? 1 : t / 0.6) }
            else { strokeArrow(&g, R[a]!, R[b]!, current == nil ? Self.accent.opacity(0.45) : Self.gray.opacity(0.85), 2.2) }
        }
        if cur >= 0 {
            let s = current == nil ? 1 : 1 + 0.12 * (1 - min(1, t / 0.35))
            for id in targets(cur) {
                guard let r = R[id] else { continue }
                let rr = CGRect(x: r.midX - r.width * s / 2, y: r.midY - r.height * s / 2, width: r.width * s, height: r.height * s)
                shadowed(&g) { $0.stroke(Path(roundedRect: rr, cornerRadius: 7), with: .color(Self.accent), lineWidth: 2.8) }
            }
        }
        for id in order {
            let list = nums[id]!
            let on = list.contains(cur) || (current == nil && cur < 0)
            trailBadge(&g, id, list.map { String($0 + 1) }.joined(separator: "·"), on ? Self.accent : Self.gray)
        }
    }

    /// 번호표: 가로로 긴 줄은 왼쪽 바깥, 그림 속 라벨은 왼쪽 위 모서리
    private func trailBadge(_ g: inout GraphicsContext, _ id: Int, _ text: String, _ fill: Color) {
        guard let r = R[id] else { return }
        let c = blob(id) || r.minX < 30 ? CGPoint(x: r.minX + 2, y: r.minY + 1) : CGPoint(x: r.minX - 14, y: r.midY)
        badge(&g, text, at: c, fill: fill)
    }

    private func minimap(_ g: inout GraphicsContext) {
        let ids: [Int] = hoverIDs ?? current.map(targets) ?? (scenes.isEmpty ? markIDs : [])
        let beat = t < RendererTimes.beat ? 0.5 + 0.5 * cos(t * 2 * .pi / 1.4) : 1
        for id in ids {
            guard let r = R[id] else { continue }
            let c = blob(id) ? CGPoint(x: r.midX, y: r.minY - 10) : CGPoint(x: r.minX - 10, y: r.midY)
            let outer = 9 * (1 + 0.5 * (1 - beat))
            g.fill(Path(ellipseIn: CGRect(x: c.x - outer, y: c.y - outer, width: outer * 2, height: outer * 2)), with: .color(Self.accent.opacity(0.35 + 0.5 * beat)))
            shadowed(&g) {
                $0.fill(Path(ellipseIn: CGRect(x: c.x - 5.5, y: c.y - 5.5, width: 11, height: 11)), with: .color(Self.accent))
                $0.stroke(Path(ellipseIn: CGRect(x: c.x - 5.5, y: c.y - 5.5, width: 11, height: 11)), with: .color(.white), lineWidth: 2)
            }
        }
    }

    // ── 화면에 바로 적기 ──
    /// 글을 놓을 빈 자리: 줄 오른쪽 → 아래 → 위 → 왼쪽 중 다른 글자·이미 놓은 글과 겹치지 않는 첫 자리
    func spot(for size: CGSize, near r: CGRect, taken: [CGRect], gap: CGFloat = 18) -> CGRect {
        let others: [CGRect] = m.others.map { CGRect(x: $0.minX * self.size.width, y: $0.minY * self.size.height,
                                                     width: $0.width * self.size.width, height: $0.height * self.size.height) }
        // 옆은 gap 만큼 띄우고(메모는 줄 끝에서 멀찍이), 위아래는 바짝 붙인다 (멀리 가면 다른 줄 위에 얹힌다)
        let v: CGFloat = 8
        let cands = [CGPoint(x: r.maxX + gap, y: r.midY - size.height / 2), CGPoint(x: r.midX - size.width / 2, y: r.maxY + v),
                     CGPoint(x: r.midX - size.width / 2, y: r.minY - v - size.height), CGPoint(x: r.minX - gap - size.width, y: r.midY - size.height / 2)]
        let bounds = CGRect(origin: .zero, size: self.size).insetBy(dx: 6, dy: 6)
        for p in cands {
            let c = CGRect(origin: p, size: size)
            guard bounds.contains(c) else { continue }
            let hit = (others + taken).contains { o in o.insetBy(dx: -3, dy: -3).intersects(c) && !o.insetBy(dx: 2, dy: 2).contains(CGPoint(x: r.midX, y: r.midY)) }
            if !hit { return c }
        }
        let c = CGRect(origin: cands[0], size: size)
        return CGRect(x: min(c.minX, bounds.maxX - size.width), y: max(bounds.minY, min(c.minY, bounds.maxY - size.height)), width: size.width, height: size.height)
    }

    private func bubble(_ g: inout GraphicsContext) {
        func mark(_ id: Int, _ p: Double) { if blob(id) { ring(&g, id, Self.accent.opacity(p), 3) } else { underline(&g, id, Self.accent, 3, progress: p) } }
        var taken: [CGRect] = []
        func say(_ text: String, near id: Int, small: Bool, op: Double) {
            guard let r = R[id] else { return }
            let label = g.resolve(Text(text).font(.system(size: small ? 14.5 : 17, weight: .semibold)).foregroundColor(.white))
            let ts = label.measure(in: CGSize(width: 290, height: 200))
            let box = spot(for: CGSize(width: ts.width + (small ? 20 : 24), height: ts.height + (small ? 8 : 16)), near: r, taken: taken)
            taken.append(box)
            var shape = Path(roundedRect: box, cornerRadius: small ? box.height / 2 : 12)
            let c = CGPoint(x: r.midX, y: r.midY)          // 꼬리: 상자 가장자리에서 짚은 곳 쪽으로
            let mid = CGPoint(x: min(max(c.x, box.minX + 14), box.maxX - 14), y: min(max(c.y, box.minY + 10), box.maxY - 10))
            let edgeP = Explain.edgePoint(of: box, toward: c)
            let dx = edgeP.x - mid.x, dy = edgeP.y - mid.y, len = max(1, hypot(dx, dy))
            var tail = Path()
            tail.move(to: CGPoint(x: edgeP.x - dy / len * 7, y: edgeP.y + dx / len * 7))
            tail.addLine(to: CGPoint(x: edgeP.x + dx / len * 9, y: edgeP.y + dy / len * 9))
            tail.addLine(to: CGPoint(x: edgeP.x + dy / len * 7, y: edgeP.y - dx / len * 7))
            shape.addPath(tail)
            var l = g
            l.opacity = op
            l.addFilter(.shadow(color: .black.opacity(0.3), radius: 8, y: 4))
            l.fill(shape, with: .color(Color(white: 0.11)))
            g.opacity = op
            g.draw(label, in: box.insetBy(dx: small ? 10 : 12, dy: small ? 4 : 8))
            g.opacity = 1
        }
        if let i = current {
            for id in focus(i) { mark(id, t / 0.5) }
            if let (a, b) = arrow(i) { strokeArrow(&g, R[a]!, R[b]!, Self.accent, 2.8, progress: (t - 0.2) / 0.6) }
            if let id = focus(i).first ?? arrow(i)?.1 { say(scenes[i].shortTag, near: id, small: false, op: min(1, max(0, (t - 0.25) / 0.3))) }
        } else {
            let p = pathIDs
            for k in p.indices.dropLast() { strokeArrow(&g, R[p[k]]!, R[p[k + 1]]!, Self.gray, 2) }
            for id in markIDs { mark(id, 1) }
            var seen = Set<Int>()
            for (k, sc) in scenes.enumerated() {
                guard let id = focus(k).first, seen.insert(id).inserted else { continue }
                say(sc.shortTag, near: id, small: true, op: min(1, max(0, (t - Double(k) * 0.12) / 0.3)))
            }
        }
    }

    private func notes(_ g: inout GraphicsContext) {
        guard !scenes.isEmpty else {
            for id in markIDs { penUnderline(&g, id, progress: 1) }
            let p = pathIDs
            for k in p.indices.dropLast() { strokeArrow(&g, R[p[k]]!, R[p[k + 1]]!, Self.pen.opacity(0.8), 2, bend: 14) }
            return
        }
        let upto = current ?? scenes.count - 1
        var taken: [CGRect] = []
        for k in 0...upto {
            let now = current == k, op: Double = now || current == nil ? 1 : 0.45
            if let (a, b) = arrow(k) {
                strokeArrow(&g, R[a]!, R[b]!, Self.pen.opacity(current == nil ? 0.8 : now ? 1 : 0.35), now ? 2.8 : 2, bend: 14,
                            progress: now ? (t - 0.25) / 0.6 : 1)
            }
            guard let id = focus(k).first ?? arrow(k)?.1, let r = R[id] else { continue }
            if now { for f in focus(k) { if blob(f) { roughCircle(&g, f, progress: t / 0.6) } else { penUnderline(&g, f, progress: t / 0.6) } } }
            let label = g.resolve(Text(scenes[k].shortTag).font(Self.penFont).foregroundColor(Self.pen))
            let ts = label.measure(in: CGSize(width: 400, height: 80))
            let box = spot(for: CGSize(width: ts.width + 6, height: ts.height), near: r, taken: taken, gap: blob(id) ? 14 : 48)
            taken.append(box)
            // 줄 끝에서 메모까지 점선
            var lead = Path()
            let a = Explain.edgePoint(of: r, toward: CGPoint(x: box.midX, y: box.midY)), b = Explain.edgePoint(of: box, toward: CGPoint(x: r.midX, y: r.midY))
            lead.move(to: a); lead.addQuadCurve(to: b, control: CGPoint(x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 + 6))
            g.stroke(lead, with: .color(Self.pen.opacity(op * 0.8)), style: StrokeStyle(lineWidth: 1.6, lineCap: .round, dash: [4, 5]))
            var l = g
            l.opacity = op
            if now { l.clip(to: Path(CGRect(x: box.minX - 2, y: box.minY - 6, width: (box.width + 4) * Self.ease(t / 0.7), height: box.height + 12))) }
            l.draw(label, in: box)
        }
    }

    private func penMarks(_ g: inout GraphicsContext) {
        if let i = current {
            let f = focus(i)
            for (k, id) in f.enumerated() { roughCircle(&g, id, progress: (t - Double(k) * 0.5) / 0.7, seed: Double(k) + 1.7) }
            if let (a, b) = arrow(i) {
                strokeArrow(&g, R[a]!.insetBy(dx: -6, dy: -6), R[b]!.insetBy(dx: -6, dy: -6), Self.pen, 3, bend: 26, progress: (t - Double(f.count) * 0.5) / 0.6)
            }
            guard let id = f.first ?? arrow(i)?.1, let r = R[id] else { return }
            let label = g.resolve(Text(scenes[i].shortTag).font(Self.penFont).foregroundColor(Self.pen))
            let ts = label.measure(in: CGSize(width: 400, height: 80))
            let box = spot(for: CGSize(width: ts.width + 6, height: ts.height), near: r.insetBy(dx: -16, dy: -8), taken: [], gap: 10)
            var l = g
            l.opacity = min(1, max(0, (t - Double(f.count) * 0.5 - 0.4) / 0.4))
            l.draw(label, in: box)
        } else {
            for (k, id) in markIDs.enumerated() { roughCircle(&g, id, progress: (t - Double(k) * 0.3) / 0.7, seed: Double(k) * 0.3 + 1.7) }
            let p = pathIDs
            for k in p.indices.dropLast() { strokeArrow(&g, R[p[k]]!, R[p[k + 1]]!, Self.pen.opacity(0.55), 2.2, bend: 18) }
        }
    }

    // MARK: 도구

    private func shadowed(_ g: inout GraphicsContext, glow: Bool = false, _ body: (inout GraphicsContext) -> Void) {
        var l = g
        // 밝은·어두운 화면 어디서나 보이게 가는 그림자. glow 는 주황 번짐
        l.addFilter(glow ? .shadow(color: Self.accent.opacity(0.55), radius: 6) : .shadow(color: .black.opacity(0.3), radius: 1.5))
        body(&l)
    }

    private func underline(_ g: inout GraphicsContext, _ id: Int, _ c: Color, _ w: CGFloat, progress: Double) {
        guard let q = Q[id] else { return }
        let p = Self.ease(progress)
        guard p > 0 else { return }
        var u = Path(); u.move(to: CGPoint(x: q.minX, y: q.maxY + 3)); u.addLine(to: CGPoint(x: q.minX + q.width * p, y: q.maxY + 3))
        shadowed(&g) { $0.stroke(u, with: .color(c), style: StrokeStyle(lineWidth: w, lineCap: .round)) }
    }

    private func ring(_ g: inout GraphicsContext, _ id: Int, _ c: Color, _ w: CGFloat) {
        guard let q = Q[id] else { return }
        let rr = max(q.width, q.height) / 2 + 5
        shadowed(&g) { $0.stroke(Path(ellipseIn: CGRect(x: q.midX - rr, y: q.midY - rr, width: rr * 2, height: rr * 2)), with: .color(c), lineWidth: w) }
    }

    private func penUnderline(_ g: inout GraphicsContext, _ id: Int, progress: Double) {
        guard let q = Q[id] else { return }
        var u = Path()
        u.move(to: CGPoint(x: q.minX - 2, y: q.maxY + 3))
        u.addQuadCurve(to: CGPoint(x: q.maxX + 2, y: q.maxY + 2), control: CGPoint(x: q.midX, y: q.maxY + 7))
        g.stroke(u.trimmedPath(from: 0, to: Self.ease(progress)), with: .color(Self.pen), style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
    }

    private func roughCircle(_ g: inout GraphicsContext, _ id: Int, progress: Double, seed: Double = 1.7) {
        guard let q = Q[id], progress > 0 else { return }
        let node = blob(id)
        let cx = q.midX, cy = q.midY
        let rx = q.width / 2 + (node ? 9 : 14), ry = q.height / 2 + (node ? 9 : 4)
        let a0 = -2.2 + seed.truncatingRemainder(dividingBy: 1)
        var p = Path()
        var a: Double = 0
        while a <= 2 * .pi + 0.55 {
            let k = 1 + 0.035 * sin(seed * 3 + a * 3) + 0.025 * sin(seed + a * 7) + a * 0.012
            let pt = CGPoint(x: cx + rx * k * cos(a0 + a), y: cy + ry * k * sin(a0 + a))
            if a == 0 { p.move(to: pt) } else { p.addLine(to: pt) }
            a += 0.09
        }
        g.stroke(p.trimmedPath(from: 0, to: Self.ease(progress)), with: .color(Self.pen), style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round))
    }

    private func badge(_ g: inout GraphicsContext, _ text: String, at c: CGPoint, fill: Color) {
        let label = g.resolve(Text(text).font(.system(size: 12.5, weight: .bold)).foregroundColor(.white))
        let s = label.measure(in: CGSize(width: 120, height: 30))
        let w = max(22, s.width + 12)
        let r = CGRect(x: c.x - w / 2, y: c.y - 11, width: w, height: 22)
        var l = g
        l.addFilter(.shadow(color: .black.opacity(0.35), radius: 2, y: 1))
        l.fill(Path(roundedRect: r, cornerRadius: 11), with: .color(fill))
        g.draw(label, at: c, anchor: .center)
    }

    /// 두 상자 사이 화살표. 같은 높이에 나란한 두 상자(그림 속 라벨) 사이는 원래 그림의 화살표와 겹치지 않게 아래로 휜다
    private func strokeArrow(_ g: inout GraphicsContext, _ a: CGRect, _ b: CGRect, _ c: Color, _ w: CGFloat,
                             bend: CGFloat = 0, dash: [CGFloat] = [], progress: Double = 1) {
        let p = Self.ease(progress)
        guard p > 0 else { return }
        let (line, head) = Self.arrowParts(a, b, bend: bend)
        shadowed(&g) {
            $0.stroke(line.trimmedPath(from: 0, to: p), with: .color(c), style: StrokeStyle(lineWidth: w, lineCap: .round, lineJoin: .round, dash: dash))
            if p >= 0.98 { $0.stroke(head, with: .color(c), style: StrokeStyle(lineWidth: w, lineCap: .round, lineJoin: .round)) }
        }
    }

    static func arrowParts(_ a: CGRect, _ b: CGRect, bend: CGFloat = 0, gap: CGFloat = 5, head: CGFloat = 11) -> (Path, Path) {
        var bend = bend
        if abs(a.midY - b.midY) < 6 { bend = max(abs(bend), 32) * (b.midX >= a.midX ? 1 : -1) }
        let e1 = Explain.edgePoint(of: a, toward: CGPoint(x: b.midX, y: b.midY))
        let e2 = Explain.edgePoint(of: b, toward: CGPoint(x: a.midX, y: a.midY))
        let ang = atan2(e2.y - e1.y, e2.x - e1.x)
        let p1 = CGPoint(x: e1.x + cos(ang) * gap, y: e1.y + sin(ang) * gap)
        let p2 = CGPoint(x: e2.x - cos(ang) * gap, y: e2.y - sin(ang) * gap)
        let len = max(1, hypot(p2.x - p1.x, p2.y - p1.y))
        let q = CGPoint(x: (p1.x + p2.x) / 2 - (p2.y - p1.y) / len * bend, y: (p1.y + p2.y) / 2 + (p2.x - p1.x) / len * bend)
        var line = Path(); line.move(to: p1); line.addQuadCurve(to: p2, control: q)
        let t = atan2(p2.y - q.y, p2.x - q.x), s = CGFloat.pi / 7
        var h = Path()
        h.move(to: CGPoint(x: p2.x - head * cos(t - s), y: p2.y - head * sin(t - s)))
        h.addLine(to: p2)
        h.addLine(to: CGPoint(x: p2.x - head * cos(t + s), y: p2.y - head * sin(t + s)))
        return (line, h)
    }

    static func ease(_ x: Double) -> Double { let v = min(1, max(0, x)); return v < 0.5 ? 2 * v * v : 1 - pow(-2 * v + 2, 2) / 2 }
    static func lerp(_ a: CGRect, _ b: CGRect, _ k: Double) -> CGRect {
        let f = CGFloat(k)
        return CGRect(x: a.minX + (b.minX - a.minX) * f, y: a.minY + (b.minY - a.minY) * f,
                      width: a.width + (b.width - a.width) * f, height: a.height + (b.height - a.height) * f)
    }
}

enum RendererTimes {
    static let flowCycles: Double = 3        // 흐르는 점은 세 바퀴 돌고 멈춘다 (계속 움직이면 강의에서 눈을 뺏는다)
    static let beat: Double = 5.6             // 지도 방식의 점은 네 번 맥박 친 뒤 멈춘다
}

extension Explain {
    /// 상자 중심에서 target 쪽으로 나가는 선이 상자 테두리와 만나는 점
    static func edgePoint(of r: CGRect, toward target: CGPoint) -> CGPoint {
        let dx = target.x - r.midX, dy = target.y - r.midY
        guard dx != 0 || dy != 0 else { return CGPoint(x: r.midX, y: r.midY) }
        let sx = dx == 0 ? CGFloat.infinity : (r.width / 2) / abs(dx)
        let sy = dy == 0 ? CGFloat.infinity : (r.height / 2) / abs(dy)
        let s = min(sx, sy)
        return CGPoint(x: r.midX + dx * s, y: r.midY + dy * s)
    }
}
