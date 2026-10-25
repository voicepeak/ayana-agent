import UIKit
import AVKit
import AVFoundation
import CoreMedia
import CoreImage
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
    private let imageContext = CIContext(options: [.cacheIntermediates: false])
    private let frameRenderer = CompanionFrameRenderer()

    public override func load() {
#if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--ayana-layout-audit") {
            do { try frameRenderer.writeLayoutAudit() }
            catch { assertionFailure("Native layout audit failed: \(error)") }
        }
#endif
        transport = CompanionTransport { [weak self] event in
            self?.notifyListeners("transport", data: event)
        }
#if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--ayana-layout-audit") { CompanionTransport.writeResponseAudit() }
#endif
        transport.changed = { [weak self] in self?.render() }
        foregroundObserver = NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in self?.transport.flush() }
    }
    private var supported: Bool { AVPictureInPictureController.isPictureInPictureSupported() }
    private var state: [String: Any] { ["overlay": false, "pip": supported, "active": pip?.isPictureInPictureActive == true, "collapsed": false, "permission": true] }
    private func changed() { notifyListeners("state", data: state) }
    @objc func status(_ call: CAPPluginCall) { DispatchQueue.main.async { call.resolve(self.state) } }
    @objc func present(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.defaults = call.options as? [String: Any] ?? [:]
            self.transport.presentation = self.defaults
            self.render()
            call.resolve()
        }
    }
    @objc func connect(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            do { try self.transport.connect(call.options as? [String: Any] ?? [:]); call.resolve() }
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
            self.transport.pipActive = true
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
        transport.pipActive = false
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

    private func render() {
        guard sourceView != nil, !paused else { return }
        let image = frameRenderer.image(state: transport.frame, defaults: defaults)
        guard let cgImage = image.cgImage else { return }
        var pixelBuffer: CVPixelBuffer?
        let attributes: [String: Any] = [kCVPixelBufferCGImageCompatibilityKey as String: true, kCVPixelBufferIOSurfacePropertiesKey as String: [:]]
        guard CVPixelBufferCreate(kCFAllocatorDefault, 960, 640, kCVPixelFormatType_32BGRA, attributes as CFDictionary, &pixelBuffer) == kCVReturnSuccess, let buffer = pixelBuffer else { return }
        imageContext.render(CIImage(cgImage: cgImage), to: buffer)
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
