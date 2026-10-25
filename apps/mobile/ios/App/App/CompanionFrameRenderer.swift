import UIKit

/// Uses the same TextKit layout for pagination and drawing. No subtitle is ellipsized.
final class CompanionFrameRenderer {
    static let size = CGSize(width: 960, height: 640)
    private let portraits = NSCache<NSString, UIImage>()
    private var contentKey = ""
    private var primaryPages: [NSAttributedString] = []
    private var secondaryPages: [NSAttributedString] = []
    private var pageStarted = Date.timeIntervalSinceReferenceDate
    private var wasPlaying = false
    private var lastPage = 0
    private var idleStartPage = 0

    init() { portraits.countLimit = 20; portraits.totalCostLimit = 32 * 1024 * 1024 }

    private func attributes(size: CGFloat, color: UIColor) -> [NSAttributedString.Key: Any] {
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineBreakMode = .byWordWrapping
        paragraph.minimumLineHeight = size * 1.3
        paragraph.maximumLineHeight = size * 1.3
        return [.font: UIFont.systemFont(ofSize: size, weight: .regular), .foregroundColor: color, .paragraphStyle: paragraph]
    }

    private func paginate(_ text: String, size: CGSize, attributes: [NSAttributedString.Key: Any]) -> [NSAttributedString] {
        let whole = NSAttributedString(string: text, attributes: attributes)
        var pages: [NSAttributedString] = [], offset = 0
        while offset < whole.length {
            let remaining = whole.attributedSubstring(from: NSRange(location: offset, length: whole.length - offset))
            let storage = NSTextStorage(attributedString: remaining)
            let layout = NSLayoutManager()
            let container = NSTextContainer(size: size)
            container.lineFragmentPadding = 0
            layout.addTextContainer(container); storage.addLayoutManager(layout)
            layout.ensureLayout(for: container)
            let glyphs = layout.glyphRange(for: container)
            let visible = layout.characterRange(forGlyphRange: glyphs, actualGlyphRange: nil)
            // TextKit keeps glyph clusters together, including emoji and combining accents.
            let length = visible.length > 0 ? visible.length : (remaining.string as NSString).rangeOfComposedCharacterSequence(at: 0).length
            pages.append(remaining.attributedSubstring(from: NSRange(location: 0, length: length)))
            offset += length
        }
        return pages
    }

    func image(state: [String: Any], defaults: [String: Any], pageOverride: Int? = nil) -> UIImage {
        let ink = color(defaults["ink"], fallback: 0xf3efe7)
        let accent = color(defaults["accent"], fallback: 0xe8c48a)
        let text = state["text"] as? String ?? defaults["text"] as? String ?? "我在这里。"
        let secondary = state["secondary"] as? String ?? ""
        let mainRect = CGRect(x: 52, y: 220, width: 524, height: secondary.isEmpty ? 306 : 234)
        let secondaryRect = CGRect(x: 52, y: 476, width: 524, height: 76)
        let key = text + "\u{0}" + secondary
        if key != contentKey {
            contentKey = key
            primaryPages = paginate(text, size: mainRect.size, attributes: attributes(size: 44, color: UIColor(white: 0.96, alpha: 1)))
            secondaryPages = paginate(secondary, size: secondaryRect.size, attributes: attributes(size: 28, color: UIColor(white: 0.8, alpha: 1)))
            pageStarted = Date.timeIntervalSinceReferenceDate; idleStartPage = 0; lastPage = 0
        }
        let count = max(1, max(primaryPages.count, secondaryPages.count))
        let playing = state["playing"] as? Bool == true
        if wasPlaying && !playing { pageStarted = Date.timeIntervalSinceReferenceDate; idleStartPage = lastPage }
        wasPlaying = playing
        let progress = min(1, max(0, state["progress"] as? Double ?? 1))
        let elapsedPages = Int(max(0, Date.timeIntervalSinceReferenceDate - pageStarted) / 7)
        let selected = playing ? min(count - 1, Int(progress * Double(count))) : (idleStartPage + elapsedPages) % count
        let page = min(count - 1, max(0, pageOverride ?? selected))
        lastPage = page
        let format = UIGraphicsImageRendererFormat(); format.scale = 1; format.opaque = true
        return UIGraphicsImageRenderer(size: Self.size, format: format).image { context in
            color(defaults["background"], fallback: 0x25282d).setFill()
            context.fill(CGRect(origin: .zero, size: Self.size))
            ("Ayana" as NSString).draw(in: CGRect(x: 36, y: 32, width: 360, height: 60), withAttributes: [.font: UIFont(name: "Georgia", size: 40) ?? UIFont.systemFont(ofSize: 40), .foregroundColor: ink])
            let path = state["asset"] as? String ?? defaults["assetFile"] as? String ?? ""
            if let portrait = portrait(path) {
                let area = CGRect(x: 530, y: 76, width: 414, height: 564)
                let scale = min(area.width / portrait.size.width, area.height / 0.72 / portrait.size.height)
                context.cgContext.saveGState(); context.cgContext.clip(to: area)
                portrait.draw(in: CGRect(x: area.midX - portrait.size.width * scale / 2, y: area.minY, width: portrait.size.width * scale, height: portrait.size.height * scale))
                context.cgContext.restoreGState()
            }
            let panel = CGRect(x: 28, y: 192, width: 572, height: 376)
            UIColor(white: 0.06, alpha: 0.94).setFill(); UIBezierPath(roundedRect: panel, cornerRadius: 22).fill()
            if !primaryPages.isEmpty { primaryPages[min(page, primaryPages.count - 1)].draw(in: mainRect) }
            if !secondaryPages.isEmpty { secondaryPages[min(page, secondaryPages.count - 1)].draw(in: secondaryRect) }
            let footer = count > 1 ? "\(page + 1) / \(count) · 自动翻页，返回 Ayana 阅读全文" : "返回 Ayana 继续对话"
            (footer as NSString).draw(in: CGRect(x: 36, y: 588, width: 888, height: 42), withAttributes: [.font: UIFont.systemFont(ofSize: 28), .foregroundColor: count > 1 ? accent : ink.withAlphaComponent(0.7)])
        }
    }

    private func color(_ value: Any?, fallback: UInt32) -> UIColor {
        let raw = (value as? String ?? "").replacingOccurrences(of: "#", with: "")
        let number = raw.count == 6 ? UInt32(raw, radix: 16) ?? fallback : fallback
        return UIColor(red: CGFloat((number >> 16) & 255) / 255, green: CGFloat((number >> 8) & 255) / 255, blue: CGFloat(number & 255) / 255, alpha: 1)
    }
    private func portrait(_ path: String) -> UIImage? {
        guard !path.contains(".."), path.hasPrefix("characters/ayana/") else { return nil }
        if let value = portraits.object(forKey: path as NSString) { return value }
        guard let url = Bundle.main.url(forResource: "public/" + path, withExtension: nil), let image = UIImage(contentsOfFile: url.path) else { return nil }
        portraits.setObject(image, forKey: path as NSString, cost: Int(image.size.width * image.size.height * 4))
        return image
    }

#if DEBUG
    /// Simulator audit uses this production renderer, never an HTML approximation.
    func writeLayoutAudit() throws {
        let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("layout-audit")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let mappingsURL = Bundle.main.url(forResource: "public/native-characters", withExtension: "json")!
        let mapping = try JSONSerialization.jsonObject(with: Data(contentsOf: mappingsURL)) as! [String: Any]
        let character = mapping["ayana"] as! [String: Any]
        let routing = character["mapping"] as! [String: Any]
        let assets = routing["assets"] as! [String: [String: Any]]
        let asset = assets[routing["default_asset_id"] as! String]?["file"] as! String
        let chinese = "今天也辛苦了。先慢慢呼吸，再喝一口水，不必急着把所有事情一次做好。我们可以从最小的一件事开始，我会在这里陪你。"
        let japanese = "今日もおつかれさま。ゆっくり息をして、お水を飲んでね。急がなくても大丈夫だから、ここで一緒にひと休みしよう。"
        let cases: [(String, String, String)] = [
            ("short", "我在这里。慢慢来就好。", "ここにいるよ。"),
            ("long", String(repeating: chinese, count: 3) + "\n一家人 👨‍👩‍👧‍👦 和 café、A\u{301}。", japanese),
            ("english", "A very long address must wrap: " + String(repeating: "https://example.test/LongUnbrokenIdentifier", count: 4), chinese),
            ("japanese", japanese, chinese), ("primary-only", chinese, "")
        ]
        var report: [[String: Any]] = []
        for (name, main, translation) in cases {
            let state: [String: Any] = ["text": main, "secondary": translation, "asset": asset]
            _ = image(state: state, defaults: [:], pageOverride: 0)
            precondition(primaryPages.map(\.string).joined() == main, "Primary text lost during pagination")
            precondition(secondaryPages.map(\.string).joined() == translation, "Translation lost during pagination")
            for (source, segments) in [(main, primaryPages), (translation, secondaryPages)] {
                var offset = 0
                for segment in segments {
                    precondition((source as NSString).rangeOfComposedCharacterSequence(at: offset).location == offset, "Page splits an emoji or combining sequence")
                    offset += segment.length
                }
            }
            let pages = max(1, max(primaryPages.count, secondaryPages.count))
            for index in 0..<pages {
                let frame = image(state: state, defaults: [:], pageOverride: index)
                try frame.pngData()!.write(to: directory.appendingPathComponent("\(name)-\(index + 1).png"))
                let format = UIGraphicsImageRendererFormat(); format.scale = 1
                let small = UIGraphicsImageRenderer(size: CGSize(width: 240, height: 160), format: format).image { _ in frame.draw(in: CGRect(x: 0, y: 0, width: 240, height: 160)) }
                try small.pngData()!.write(to: directory.appendingPathComponent("\(name)-\(index + 1)-small.png"))
            }
            report.append(["name": name, "pages": pages, "mainCharacters": main.count, "translationCharacters": translation.count, "asset": asset])
        }
        try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]).write(to: directory.appendingPathComponent("report.json"))
    }
#endif
}
