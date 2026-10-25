import UIKit
import AVKit
import AVFoundation
import CoreMedia
import Capacitor

@objc(AyanaCompanionPlugin)
public class AyanaCompanionPlugin: CAPPlugin, CAPBridgedPlugin, AVPictureInPictureControllerDelegate, AVPictureInPictureSampleBufferPlaybackDelegate {
    public let identifier = "AyanaCompanionPlugin"
    public let jsName = "AyanaCompanion"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "present", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "connect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "send", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "disconnect", returnType: CAPPluginReturnPromise)
    ]
    private var pip: AVPictureInPictureController?
    private var sourceView: UIView?
    private let displayLayer = AVSampleBufferDisplayLayer()
    private var possible: NSKeyValueObservation?
    private var renderTimer: Timer?
    private var starting: CAPPluginCall?
    private var startTimeout: DispatchWorkItem?
    private var restoring = false
    private var paused = false
    private var defaults: [String: Any] = [:]
    private var transport: CompanionTransport!
    private var foregroundObserver: NSObjectProtocol?

    public override func load() {
        transport = CompanionTransport { [weak self] event in
            self?.notifyListeners("transport", data: event)
        }
        transport.changed = { [weak self] in self?.render() }
        foregroundObserver = NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in self?.transport.flush() }
    }
    private var supported: Bool { AVPictureInPictureController.isPictureInPictureSupported() }
    private var state: [String: Any] { ["overlay": false, "pip": supported, "active": pip?.isPictureInPictureActive == true, "collapsed": false, "permission": true] }
    private func changed() { notifyListeners("state", data: state) }
    @objc func status(_ call: CAPPluginCall) { DispatchQueue.main.async { call.resolve(self.state) } }
    @objc func present(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.defaults = call.options
            self.transport.presentation = call.options
            self.render()
            call.resolve()
        }
    }
    @objc func connect(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            do { try self.transport.connect(call.options); call.resolve() }
            catch { call.reject("无法建立画中画聊天连接") }
        }
    }
    @objc func send(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let id = call.getString("id"), let text = call.getString("text"), self.transport.id == id else { call.reject("连接已关闭"); return }
            self.transport.sendCommand(text); call.resolve()
        }
    }
    @objc func disconnect(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if self.transport.id == call.getString("id") { self.transport.disconnect() }
            call.resolve()
        }
    }
    @objc func start(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard self.supported else { call.reject("当前设备不支持画中画"); return }
            if self.pip?.isPictureInPictureActive == true { call.resolve(); return }
            guard self.starting == nil, let parent = self.bridge?.viewController?.view, parent.window != nil else { call.reject("请在 Ayana 界面中打开画中画"); return }
            self.starting = call; self.restoring = false; self.paused = false
            do {
                let audio = AVAudioSession.sharedInstance()
                try audio.setCategory(.playback, mode: .moviePlayback)
                try audio.setActive(true)
                let view = UIView(frame: CGRect(x: 16, y: parent.safeAreaInsets.top + 64, width: 240, height: 160))
                view.isUserInteractionEnabled = false; view.layer.cornerRadius = 14; view.clipsToBounds = true
                parent.addSubview(view); self.sourceView = view
                self.displayLayer.frame = view.bounds; self.displayLayer.videoGravity = .resizeAspect
                self.displayLayer.backgroundColor = UIColor.black.cgColor
                view.layer.addSublayer(self.displayLayer)
                var timebase: CMTimebase?
                CMTimebaseCreateWithSourceClock(allocator: kCFAllocatorDefault, sourceClock: CMClockGetHostTimeClock(), timebaseOut: &timebase)
                if let timebase = timebase { CMTimebaseSetTime(timebase, time: .zero); CMTimebaseSetRate(timebase, rate: 1); self.displayLayer.controlTimebase = timebase }
                self.render()
                let content = AVPictureInPictureController.ContentSource(sampleBufferDisplayLayer: self.displayLayer, playbackDelegate: self)
                let controller = AVPictureInPictureController(contentSource: content)
                controller.delegate = self; controller.requiresLinearPlayback = true
                self.pip = controller
                self.possible = controller.observe(\.isPictureInPicturePossible, options: [.initial, .new]) { [weak self] controller, _ in
                    DispatchQueue.main.async {
                        guard let self = self, self.starting != nil, controller.isPictureInPicturePossible else { return }
                        controller.startPictureInPicture()
                    }
                }
                self.renderTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in self?.render() }
                let timeout = DispatchWorkItem { [weak self] in self?.failStart("画中画暂时无法启动，请重试或检查系统画中画设置") }
                self.startTimeout = timeout; DispatchQueue.main.asyncAfter(deadline: .now() + 8, execute: timeout)
            } catch { self.failStart("无法启用画中画音频会话") }
        }
    }
    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.restoring = call.getBool("restore") == true
            if self.pip?.isPictureInPictureActive == true { self.pip?.stopPictureInPicture() }
            else { self.failStart("画中画已关闭"); self.cleanup() }
            call.resolve()
        }
    }
    private func failStart(_ message: String) {
        let call = starting; starting = nil; call?.reject(message)
        if pip?.isPictureInPictureActive != true { cleanup() }
    }
    private func cleanup() {
        startTimeout?.cancel(); startTimeout = nil; possible = nil
        renderTimer?.invalidate(); renderTimer = nil
        displayLayer.flushAndRemoveImage(); displayLayer.removeFromSuperlayer()
        sourceView?.removeFromSuperview(); sourceView = nil; pip = nil
        changed()
    }
    public func pictureInPictureControllerDidStartPictureInPicture(_ pictureInPictureController: AVPictureInPictureController) {
        startTimeout?.cancel(); starting?.resolve(); starting = nil; changed()
    }
    public func pictureInPictureController(_ pictureInPictureController: AVPictureInPictureController, failedToStartPictureInPictureWithError error: Error) { failStart("系统未能打开画中画，请稍后重试") }
    public func pictureInPictureControllerDidStopPictureInPicture(_ pictureInPictureController: AVPictureInPictureController) {
        if !restoring { transport.cancelTurn() }
        paused = false; cleanup()
    }
    public func pictureInPictureController(_ pictureInPictureController: AVPictureInPictureController, restoreUserInterfaceForPictureInPictureStopWithCompletionHandler completionHandler: @escaping (Bool) -> Void) {
        restoring = true
        if let scene = bridge?.viewController?.view.window?.windowScene {
            UIApplication.shared.requestSceneSessionActivation(scene.session, userActivity: nil, options: nil, errorHandler: nil)
            completionHandler(true)
        } else { completionHandler(false) }
    }
    public func pictureInPictureController(_ pictureInPictureController: AVPictureInPictureController, setPlaying playing: Bool) {
        paused = !playing; transport.setPlaying(playing); pictureInPictureController.invalidatePlaybackState()
    }
    public func pictureInPictureControllerTimeRangeForPlayback(_ pictureInPictureController: AVPictureInPictureController) -> CMTimeRange { CMTimeRange(start: .zero, duration: .positiveInfinity) }
    public func pictureInPictureControllerIsPlaybackPaused(_ pictureInPictureController: AVPictureInPictureController) -> Bool { paused }
    public func pictureInPictureController(_ pictureInPictureController: AVPictureInPictureController, didTransitionToRenderSize newRenderSize: CMVideoDimensions) { render() }
    public func pictureInPictureController(_ pictureInPictureController: AVPictureInPictureController, skipByInterval skipInterval: CMTime, completion completionHandler: @escaping () -> Void) { completionHandler() }

    private func color(_ value: Any?, fallback: UInt32) -> UIColor {
        let raw = (value as? String ?? "").replacingOccurrences(of: "#", with: "")
        let number = raw.count == 6 ? UInt32(raw, radix: 16) ?? fallback : fallback
        return UIColor(red: CGFloat((number >> 16) & 255) / 255, green: CGFloat((number >> 8) & 255) / 255, blue: CGFloat(number & 255) / 255, alpha: 1)
    }
    private func render() {
        guard sourceView != nil, !paused else { return }
        let size = CGSize(width: 960, height: 640)
        let state = transport.frame
        let ink = color(defaults["ink"], fallback: 0xf3efe7)
        let accent = color(defaults["accent"], fallback: 0xe8c48a)
        let image = UIGraphicsImageRenderer(size: size).image { context in
            color(defaults["background"], fallback: 0x25282d).setFill(); context.fill(CGRect(origin: .zero, size: size))
            let paragraph = NSMutableParagraphStyle(); paragraph.lineBreakMode = .byTruncatingTail
            let body: [NSAttributedString.Key: Any] = [.font: UIFont.systemFont(ofSize: 35, weight: .regular), .foregroundColor: ink, .paragraphStyle: paragraph]
            ("Ayana" as NSString).draw(in: CGRect(x: 40, y: 28, width: 250, height: 45), withAttributes: [.font: UIFont(name: "Georgia", size: 32) ?? UIFont.systemFont(ofSize: 32), .foregroundColor: ink])
            let path = (state["asset"] as? String) ?? (defaults["assetFile"] as? String ?? "")
            if !path.contains(".."), path.hasPrefix("characters/"), let url = Bundle.main.url(forResource: "public/" + path, withExtension: nil), let portrait = UIImage(contentsOfFile: url.path) {
                let area = CGRect(x: 500, y: 70, width: 440, height: 570)
                let scale = min(area.width / portrait.size.width, area.height / portrait.size.height)
                portrait.draw(in: CGRect(x: area.midX - portrait.size.width * scale / 2, y: area.maxY - portrait.size.height * scale, width: portrait.size.width * scale, height: portrait.size.height * scale))
            }
            let panel = CGRect(x: 34, y: 210, width: 510, height: 320)
            UIColor(white: 0.06, alpha: 0.9).setFill(); UIBezierPath(roundedRect: panel, cornerRadius: 20).fill()
            ("彩名" as NSString).draw(in: CGRect(x: 58, y: 231, width: 400, height: 26), withAttributes: [.font: UIFont.systemFont(ofSize: 19), .foregroundColor: accent])
            let text = state["text"] as? String ?? defaults["text"] as? String ?? "我在这里。"
            let attributed = NSMutableAttributedString(string: text, attributes: body.merging([.foregroundColor: UIColor(white: 0.94, alpha: 0.4)], uniquingKeysWith: { _, new in new }))
            let progress = state["progress"] as? Double ?? 1
            let length = (text as NSString).length
            attributed.addAttribute(.foregroundColor, value: UIColor(white: 0.96, alpha: 1), range: NSRange(location: 0, length: min(length, max(0, Int(Double(length) * progress)))))
            attributed.draw(in: CGRect(x: 58, y: 278, width: 460, height: 163))
            let secondary = state["secondary"] as? String ?? ""
            (secondary as NSString).draw(in: CGRect(x: 58, y: 454, width: 460, height: 54), withAttributes: [.font: UIFont.systemFont(ofSize: 22), .foregroundColor: UIColor(white: 0.8, alpha: 1), .paragraphStyle: paragraph])
            ("返回 Ayana 继续对话" as NSString).draw(in: CGRect(x: 40, y: 582, width: 460, height: 30), withAttributes: [.font: UIFont.systemFont(ofSize: 20), .foregroundColor: ink.withAlphaComponent(0.65)])
        }
        guard let cgImage = image.cgImage else { return }
        var pixelBuffer: CVPixelBuffer?
        let attributes = [kCVPixelBufferCGImageCompatibilityKey: true, kCVPixelBufferCGBitmapContextCompatibilityKey: true] as CFDictionary
        guard CVPixelBufferCreate(kCFAllocatorDefault, 960, 640, kCVPixelFormatType_32ARGB, attributes, &pixelBuffer) == kCVReturnSuccess, let buffer = pixelBuffer else { return }
        CVPixelBufferLockBaseAddress(buffer, [])
        if let canvas = CGContext(data: CVPixelBufferGetBaseAddress(buffer), width: 960, height: 640, bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRow(buffer), space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue) { canvas.draw(cgImage, in: CGRect(origin: .zero, size: size)) }
        CVPixelBufferUnlockBaseAddress(buffer, [])
        var description: CMVideoFormatDescription?
        CMVideoFormatDescriptionCreateForImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: buffer, formatDescriptionOut: &description)
        guard let format = description else { return }
        guard let timebase = displayLayer.controlTimebase else { return }
        var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: 10), presentationTimeStamp: CMTimebaseGetTime(timebase), decodeTimeStamp: .invalid)
        var sample: CMSampleBuffer?
        CMSampleBufferCreateReadyWithImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: buffer, formatDescription: format, sampleTiming: &timing, sampleBufferOut: &sample)
        if let sample = sample {
            if displayLayer.status == .failed { displayLayer.flush() }
            if displayLayer.isReadyForMoreMediaData { displayLayer.enqueue(sample) }
        }
    }
    deinit {
        if let observer = foregroundObserver { NotificationCenter.default.removeObserver(observer) }
        renderTimer?.invalidate(); startTimeout?.cancel()
    }
}
