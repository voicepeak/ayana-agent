import Foundation
import UIKit
import AVFoundation
import Security

/// Native transport + PCM consumer. Model context/history remain owned by LocalRuntime.
/// While WebKit sleeps, retain ordered semantic/terminal events and replay them on return.
final class CompanionTransport: NSObject, AVAudioPlayerDelegate {
    var id = ""
    var changed: (() -> Void)?
    var presentation: [String: Any] = [:] {
        didSet {
            if presentation["character"] as? String != oldValue["character"] as? String || presentation["costume"] as? String != oldValue["costume"] as? String { shown = nil }
            player?.volume = Float(presentation["volume"] as? Double ?? 1)
            if presentation["silent"] as? Bool == true { cancelAudio() }
        }
    }
    private let emit: ([String: Any]) -> Void
    private var socket: URLSessionWebSocketTask?
    private var session: [String: Any] = [:]
    private var epoch = 0
    private var heartbeat: Timer?
    private var playbackTimer: Timer?
    private var refreshTask: URLSessionDataTask?
    private var backlog: [[String: Any]] = []
    private var metadata: [String: [String: Any]] = [:]
    private var mappings: [String: Any] = [:]
    private var queue: [([String: Any], Data)] = []
    private var current: [String: Any]?
    private var shown: [String: Any]?
    private var player: AVAudioPlayer?
    private var generation = 0
    private var cancelled = -1
    private var seen = Set<String>()
    private var lastMessage = Date()
    private var textQueue: [String] = []
    private var textWork: DispatchWorkItem?
    private var paused = false
    private var retryWork: DispatchWorkItem?
    private var attempts = 0
    init(emit: @escaping ([String: Any]) -> Void) {
        self.emit = emit
        super.init()
        if let path = Bundle.main.url(forResource: "public/native-characters", withExtension: "json"),
           let data = try? Data(contentsOf: path), let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] { mappings = value }
    }
    var frame: [String: Any] {
        let event = current.flatMap { metadata[$0["utterance_id"] as? String ?? ""] } ?? shown ?? [:]
        let ja = event["speech_ja"] as? String ?? ""
        let zh = event["display_zh"] as? String ?? ja
        let en = event["display_en"] as? String ?? zh
        let primary = presentation["primary"] as? String ?? "zh"
        let translation = presentation["translation"] as? String ?? "none"
        let texts = ["ja": ja, "zh": zh, "en": en]
        let main = texts[primary] ?? zh
        let secondary = translation == "none" || translation == primary ? "" : texts[translation] ?? ""
        let duration = player?.duration ?? 0
        let ratio = current == nil || duration == 0 ? 1 : min(1, (player?.currentTime ?? 0) / duration)
        return ["text": main.isEmpty ? (presentation["text"] as? String ?? "我在这里。") : main,
                "secondary": secondary == main ? "" : secondary, "asset": event["native_asset_file"] as? String ?? presentation["assetFile"] as? String ?? "",
                "progress": ratio]
    }
    func connect(_ value: [String: Any]) throws {
        guard let connectionID = value["id"] as? String, let gateway = value["gateway"] as? String,
              let base = URL(string: gateway), ["https", "http"].contains(base.scheme ?? ""),
              base.user == nil, base.password == nil, base.host != nil else { throw NSError(domain: "Ayana", code: 1) }
        disconnect()
        session = value; id = connectionID; cancelled = -1; generation = 0; seen.removeAll(); metadata.removeAll(); shown = nil
        open()
    }
    private func open() {
        guard let gateway = session["gateway"] as? String, var url = URLComponents(string: gateway) else { return }
        url.scheme = url.scheme == "https" ? "wss" : "ws"; url.path = "/v1/mobile"
        guard let endpoint = url.url else { return }
        epoch += 1; let version = epoch
        let task = URLSession.shared.webSocketTask(with: endpoint); socket = task; lastMessage = Date()
        task.resume()
        sendWire(["access_token": session["access_token"] as? String ?? ""])
        deliver(["kind": "open"])
        receive(task, version)
        heartbeat?.invalidate()
        heartbeat = Timer.scheduledTimer(withTimeInterval: 20, repeats: true) { [weak self] _ in
            guard let self = self, self.socket === task else { return }
            if Date().timeIntervalSince(self.lastMessage) > 55 { self.close(1006); return }
            let expiry = self.session["expires_at"] as? Double ?? 0
            if expiry < Date().timeIntervalSince1970 + 45 { self.refresh(); return }
            self.sendWire(["type": "ping"])
        }
    }
    func sendCommand(_ text: String) {
        guard let data = text.data(using: .utf8), let event = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        if event["type"] as? String == "turn.start" {
            cancelAudio(); generation = event["generation_id"] as? Int ?? 0
            textWork?.cancel(); textQueue.removeAll(); metadata.removeAll(); seen.removeAll()
        }
        if event["type"] as? String == "generation.cancel" { cancelled = max(cancelled, generation); cancelAudio(); textWork?.cancel(); textQueue.removeAll() }
        sendText(text)
    }
    private func sendText(_ text: String) {
        guard let task = socket else { return }
        task.send(.string(text)) { [weak self, weak task] error in
            if error != nil { DispatchQueue.main.async { if self?.socket === task { self?.close(1006) } } }
        }
    }
    private func sendWire(_ event: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: event), let text = String(data: data, encoding: .utf8) else { return }
        sendText(text)
    }
    private func receive(_ task: URLSessionWebSocketTask, _ version: Int) {
        task.receive { [weak self, weak task] result in
            DispatchQueue.main.async {
                guard let self = self, let task = task, self.socket === task, self.epoch == version else { return }
                switch result {
                case .success(let message):
                    self.lastMessage = Date()
                    switch message {
                    case .string(let text): self.incoming(text)
                    case .data(let data): self.audio(data)
                    @unknown default: break
                    }
                    self.receive(task, version)
                case .failure:
                    let code = task.closeCode.rawValue
                    self.close(code == 0 ? 1006 : code)
                }
            }
        }
    }
    private func incoming(_ text: String) {
        guard let data = text.data(using: .utf8), var event = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { close(1002); return }
        let type = event["type"] as? String ?? ""
        if type == "generation.cancelled" {
            let old = event["cancelled_generation_id"] as? Int ?? -1
            if old == generation { cancelled = max(cancelled, old); cancelAudio() }
        }
        let gen = event["generation_id"] as? Int
        if let gen = gen, gen != generation || (gen <= cancelled && type != "generation.cancelled") { return }
        let uid = event["utterance_id"] as? String ?? ""
        if type == "utterance.ready" {
            if metadata[uid] != nil { return }
            resolveAsset(&event); metadata[uid] = event
            textQueue.append(uid); scheduleText()
        }
        if type == "subtitle.ready" || type == "subtitle.translated" {
            metadata[uid]?.merge(event, uniquingKeysWith: { _, new in new })
            if shown?["utterance_id"] as? String == uid { shown = metadata[uid] }
        }
        if type == "gateway.ready" { attempts = 0 }
        changed?(); deliverEvent(event)
    }
    private func resolveAsset(_ event: inout [String: Any]) {
        let character = "ayana"
        let mapping = (mappings[character] as? [String: Any])?["mapping"] as? [String: Any] ?? [:]
        let assets = mapping["assets"] as? [String: [String: Any]] ?? [:]
        let costume = presentation["costume"] as? String ?? "校服"
        let expression = event["expression"] as? String ?? ""
        var label = assets[expression]?["source_expression"] as? String ?? expression
        let candidates = assets.filter { $0.value["costume"] as? String == costume && $0.value["alias"] as? Bool != true }
        if !candidates.contains(where: { $0.value["source_expression"] as? String == label }) {
            let fallback = mapping["fallbacks"] as? [String: Any] ?? [:]
            label = (fallback["affect"] as? [String: String])?[event["affect"] as? String ?? ""]
                ?? (fallback["intent"] as? [String: String])?[event["intent"] as? String ?? ""]
                ?? fallback["default"] as? String ?? ""
        }
        let matching = candidates.filter { $0.value["source_expression"] as? String == label }
        let fallback = assets[mapping["default_asset_id"] as? String ?? ""]
        let selected = matching.first(where: { $0.value["pose"] as? String == "crossed" }) ?? matching.first ?? candidates.first
        if let selected = selected { event["native_asset_id"] = selected.key; event["native_asset_file"] = selected.value["file"] }
        else { event["native_asset_file"] = fallback?["file"] }
    }
    private func audio(_ data: Data) {
        guard data.count >= 4 else { close(1002); return }
        let length = Int(data.prefix(4).enumerated().reduce(UInt32(0)) { $0 | UInt32($1.element) << ($1.offset * 8) })
        guard length > 0, length <= 8192, data.count >= length + 4,
              let event = try? JSONSerialization.jsonObject(with: data.subdata(in: 4..<(4 + length))) as? [String: Any],
              event["format"] as? String == "pcm_s16le", event["channels"] as? Int == 1,
              let uid = event["utterance_id"] as? String, let gen = event["generation_id"] as? Int,
              let rate = event["sample_rate"] as? Int, rate >= 8000, rate <= 192000 else { close(1002); return }
        let pcm = data.subdata(in: (4 + length)..<data.count)
        guard !pcm.isEmpty, pcm.count <= 32 * 1024 * 1024, pcm.count % 2 == 0, event["sample_count"] as? Int == pcm.count / 2, event["byte_length"] as? Int == pcm.count else { close(1002); return }
        if gen != generation || gen <= cancelled { consumed(uid); return }
        if presentation["silent"] as? Bool == true { consumed(uid); return }
        if metadata[uid]?["native_displayed"] as? Bool == true { consumed(uid); return }
        if seen.contains(uid) { return }; seen.insert(uid)
        guard queue.count + (current == nil ? 0 : 1) < 3 else { cancelTurn(); return }
        queue.append((event, pcm)); playNext()
    }
    private func wave(_ pcm: Data, rate: Int) -> Data {
        var result = Data()
        func text(_ value: String) { result.append(value.data(using: .ascii)!) }
        func u32(_ value: Int) { var number = UInt32(value).littleEndian; withUnsafeBytes(of: &number) { result.append(contentsOf: $0) } }
        func u16(_ value: Int) { var number = UInt16(value).littleEndian; withUnsafeBytes(of: &number) { result.append(contentsOf: $0) } }
        text("RIFF"); u32(pcm.count + 36); text("WAVEfmt "); u32(16); u16(1); u16(1); u32(rate); u32(rate * 2); u16(2); u16(16); text("data"); u32(pcm.count); result.append(pcm)
        return result
    }
    private func playNext() {
        guard current == nil, !paused, !queue.isEmpty else { return }
        let item = queue.removeFirst(); current = item.0
        do {
            let audio = AVAudioSession.sharedInstance(); try audio.setCategory(.playback, mode: .moviePlayback); try audio.setActive(true)
            let rate = item.0["sample_rate"] as? Int ?? 32000
            player = try AVAudioPlayer(data: wave(item.1, rate: rate)); player?.delegate = self
            player?.volume = Float(presentation["volume"] as? Double ?? 1)
            guard player?.play() == true else { throw NSError(domain: "Ayana", code: 2) }
            receipt("started"); changed?()
            playbackTimer?.invalidate()
            playbackTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
                guard let self = self else { return }; self.receipt("progress")
            }
        } catch { receipt("error"); finishAudio(); playNext() }
    }
    private func receipt(_ type: String) {
        guard let item = current else { return }
        let total = item["sample_count"] as? Int ?? 0, rate = item["sample_rate"] as? Int ?? 32000
        let played = type == "ended" ? total : min(total, Int((player?.currentTime ?? 0) * Double(rate)))
        var value = item; value["type"] = "playback." + type; value["native_playback"] = true
        value["played_samples"] = played; value["total_samples"] = total
        value.removeValue(forKey: "seq")
        if type != "progress" || UIApplication.shared.applicationState == .active { deliverEvent(value) }
        if ["ended", "cancelled", "error"].contains(type) { consumed(item["utterance_id"] as? String ?? "") }
        if type == "started" {
            let uid = item["utterance_id"] as? String ?? ""
            metadata[uid]?["native_displayed"] = true; shown = metadata[uid]
            textQueue.removeAll { $0 == uid }; textWork?.cancel(); textWork = nil; scheduleText()
        }
        if type == "error", let text = metadata[item["utterance_id"] as? String ?? ""] {
            deliverEvent(text.merging(["type": "mobile.present", "native_playback": true, "played_samples": 0, "total_samples": 0], uniquingKeysWith: { _, new in new }))
        }
    }
    private func finishAudio() {
        player?.stop(); player = nil; current = nil; playbackTimer?.invalidate(); playbackTimer = nil; changed?()
    }
    private func cancelAudio() {
        if current != nil { receipt("cancelled") }
        for item in queue { consumed(item.0["utterance_id"] as? String ?? "") }
        queue.removeAll(); finishAudio()
    }
    func cancelTurn() {
        cancelled = max(cancelled, generation); cancelAudio(); textWork?.cancel(); textQueue.removeAll()
        sendWire(["type": "generation.cancel"])
        deliverEvent(["type": "generation.cancelled", "generation_id": generation, "cancelled_generation_id": generation])
    }
    func setPlaying(_ playing: Bool) {
        paused = !playing
        if playing { if player != nil { player?.play() } else { playNext() } }
        else { player?.pause() }
    }
    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        receipt(flag ? "ended" : "error"); finishAudio(); playNext()
    }
    func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) { receipt("error"); finishAudio(); playNext() }
    private func consumed(_ uid: String) { if !uid.isEmpty { sendWire(["type": "audio.consumed", "utterance_id": uid]) } }
    private func scheduleText() {
        guard textWork == nil, let uid = textQueue.first else { return }
        let version = epoch
        let work = DispatchWorkItem { [weak self] in
            guard let self = self, self.epoch == version else { return }
            self.textWork = nil
            if let event = self.metadata[uid], (event["generation_id"] as? Int ?? -1) > self.cancelled {
                self.metadata[uid]?["native_displayed"] = true; self.shown = self.metadata[uid]
                self.deliverEvent(event.merging(["type": "mobile.present", "native_playback": true, "played_samples": 0, "total_samples": 0], uniquingKeysWith: { _, new in new }))
                self.changed?()
            }
            if !self.textQueue.isEmpty { self.textQueue.removeFirst() }; self.scheduleText()
        }
        let audio = metadata[uid]?["audio_enabled"] as? Bool != false && presentation["silent"] as? Bool != true
        textWork = work; DispatchQueue.main.asyncAfter(deadline: .now() + (audio ? 9 : 1.2), execute: work)
    }
    private func deliverEvent(_ event: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: event.merging(["protocol_version": 1], uniquingKeysWith: { old, _ in old })), let text = String(data: data, encoding: .utf8) else { return }
        deliver(["kind": "message", "text": text])
    }
    private func deliver(_ event: [String: Any]) {
        let value = event.merging(["id": id], uniquingKeysWith: { old, _ in old })
        if UIApplication.shared.applicationState == .active { emit(value) }
        else {
            if backlog.count >= 512 { backlog.removeAll(); close(1009); return }
            backlog.append(value)
        }
    }
    func flush() { let values = backlog; backlog.removeAll(); for value in values { emit(value) } }
    private func close(_ code: Int) {
        socket?.cancel(with: .goingAway, reason: nil); socket = nil
        heartbeat?.invalidate(); heartbeat = nil; epoch += 1
        cancelAudio(); textWork?.cancel(); textWork = nil; textQueue.removeAll()
        if [1001, 1006].contains(code), UIApplication.shared.applicationState != .active, attempts < 5, !id.isEmpty {
            cancelled = max(cancelled, generation)
            deliverEvent(["type": "generation.cancelled", "generation_id": generation, "cancelled_generation_id": generation])
            deliverEvent(["type": "gateway.offline"])
            attempts += 1
            let retry = DispatchWorkItem { [weak self] in self?.open() }
            retryWork = retry; DispatchQueue.main.asyncAfter(deadline: .now() + min(10, pow(2, Double(attempts))), execute: retry)
        } else { deliver(["kind": "close", "code": code]) }
    }
    func disconnect() {
        retryWork?.cancel(); retryWork = nil; attempts = 0
        close(1000); refreshTask?.cancel(); refreshTask = nil; backlog.removeAll()
    }
    private var vaultQuery: [String: Any] { [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "dev.ayana.mobile.session.v1", kSecAttrAccount as String: "session"] }
    private func refresh() {
        guard refreshTask == nil, let gateway = session["gateway"] as? String, let url = URL(string: gateway + "/v1/refresh"), let token = session["refresh_token"] as? String else { return }
        let version = epoch
        var request = URLRequest(url: url); request.httpMethod = "POST"; request.timeoutInterval = 15
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["refresh_token": token])
        refreshTask = URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            DispatchQueue.main.async {
                guard let self = self, self.epoch == version else { return }
                self.refreshTask = nil
                guard error == nil, (response as? HTTPURLResponse)?.statusCode == 200, let data = data,
                      var next = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { self.close(4401); return }
                next["gateway"] = gateway
                guard let saved = try? JSONSerialization.data(withJSONObject: next),
                      SecItemUpdate(self.vaultQuery as CFDictionary, [kSecValueData as String: saved] as CFDictionary) == errSecSuccess else { self.close(4401); return }
                self.session = next
                if self.generation > 0 {
                    self.cancelled = max(self.cancelled, self.generation)
                    self.deliverEvent(["type": "generation.cancelled", "generation_id": self.generation, "cancelled_generation_id": self.generation])
                }
                self.socket?.cancel(with: .normalClosure, reason: nil); self.socket = nil
                self.cancelAudio(); self.open()
            }
        }
        refreshTask?.resume()
    }
    deinit { heartbeat?.invalidate(); playbackTimer?.invalidate(); textWork?.cancel(); retryWork?.cancel(); refreshTask?.cancel(); socket?.cancel(with: .goingAway, reason: nil) }
}
