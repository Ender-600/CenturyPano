import ARKit
import AVFoundation
import UIKit
import WebKit
import simd

private struct MotionCommand: Decodable {
    let version: Int
    let action: String
    let sessionId: String
}

// WKUserContentController owns handlers strongly; use a weak forwarding object.
private final class WeakMotionHandler: NSObject, WKScriptMessageHandler {
    weak var target: MotionViewController?
    init(_ target: MotionViewController) { self.target = target }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.receive(message)
    }
}

final class MotionViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, ARSessionDelegate {
    private let initialURL: URL
    private let origin: DemoOrigin
    private var webView: WKWebView!
    private let statusLabel = UILabel()
    private var arSession: ARSession?
    private var sessionId: String?
    private var seenSessionIds: [String] = []
    private var sequence = 0
    private var trackingGeneration: UInt64 = 0
    private var documentGeneration: UInt64 = 0
    private var documentReady = false
    private var permissionStartGeneration: UInt64?
    private var lastPoseTimestamp: TimeInterval = -.infinity
    private var lastStatus: String?
    private var pendingStatus: [String: Any]?
    private var latestPose: [String: Any]?
    private var javaScriptInFlight: UUID?
    private var observers: [NSObjectProtocol] = []

    init(url: URL, origin: DemoOrigin) {
        initialURL = url
        self.origin = origin
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("Use init(url:origin:)") }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Historical Street View"
        view.backgroundColor = .systemBackground
        navigationItem.rightBarButtonItem = UIBarButtonItem(
            title: "Stop tracking", style: .plain, target: self, action: #selector(stopTapped)
        )

        let content = WKUserContentController()
        content.add(WeakMotionHandler(self), name: "centuryMotion")
        let originJSON = String(data: try! JSONSerialization.data(withJSONObject: [origin.javascriptOrigin]), encoding: .utf8)!
        let bridge = """
        (() => {
          const allowedOrigin = \(originJSON)[0];
          if (window !== window.top || window.location.origin !== allowedOrigin) return;
          Object.defineProperty(window, 'CenturyMotion', {value: Object.freeze({
            version: 1,
            platform: 'ios',
            postMessage(jsonString) {
              if (typeof jsonString === 'string' && jsonString.length <= 4096)
                window.webkit.messageHandlers.centuryMotion.postMessage(jsonString);
            }
          }), writable: false, configurable: false});
        })();
        """
        content.addUserScript(WKUserScript(source: bridge, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let configuration = WKWebViewConfiguration()
        configuration.userContentController = content
        configuration.websiteDataStore = .nonPersistent()
        configuration.allowsInlineMediaPlayback = true
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        webView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(webView)

        statusLabel.text = "Loading demo…"
        statusLabel.numberOfLines = 2
        statusLabel.font = .preferredFont(forTextStyle: .caption1)
        statusLabel.textColor = .secondaryLabel
        statusLabel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(statusLabel)
        NSLayoutConstraint.activate([
            statusLabel.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 4),
            statusLabel.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 12),
            statusLabel.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -12),
            webView.topAnchor.constraint(equalTo: statusLabel.bottomAnchor, constant: 4),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            webView.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor)
        ])

        let notifications = NotificationCenter.default
        observers.append(notifications.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            self?.stopTracking(code: "background")
        })
        observers.append(notifications.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
            // A camera permission prompt itself makes the app inactive. Only an
            // already running camera is stopped here; background always cancels.
            if self?.arSession != nil { self?.stopTracking(code: "background") }
        })
        observers.append(notifications.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            guard let self, let generation = self.permissionStartGeneration else { return }
            self.beginAuthorizedSession(generation: generation)
        })
        webView.load(URLRequest(url: initialURL))
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        stopTracking(code: "background")
        documentReady = false
        documentGeneration &+= 1
    }

    deinit {
        arSession?.pause()
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
    }

    @objc private func stopTapped() { stopTracking(code: "paused") }

    fileprivate func receive(_ message: WKScriptMessage) {
        guard documentReady, message.frameInfo.isMainFrame,
              origin.matches(message.frameInfo.securityOrigin),
              origin.matches(message.frameInfo.request.url), origin.matches(webView.url),
              let text = message.body as? String, text.utf8.count <= 4096,
              let data = text.data(using: .utf8),
              let command = try? JSONDecoder().decode(MotionCommand.self, from: data),
              command.version == 1,
              command.sessionId.range(of: "^[A-Za-z0-9-]{16,128}$", options: .regularExpression) != nil
        else { return }
        switch command.action {
        case "start": startTracking(id: command.sessionId)
        case "stop":
            if command.sessionId == sessionId { stopTracking(code: "paused") }
        default: break
        }
    }

    private func startTracking(id: String) {
        guard UIApplication.shared.applicationState == .active,
              !seenSessionIds.contains(id) else { return }
        stopTracking(code: "paused", publish: false)
        seenSessionIds.append(id)
        if seenSessionIds.count > 64 { seenSessionIds.removeFirst() }
        sessionId = id
        sequence = 0
        pendingStatus = nil
        latestPose = nil
        lastStatus = nil
        lastPoseTimestamp = -.infinity
        let generation = trackingGeneration
        guard ARWorldTrackingConfiguration.isSupported else {
            publishStatus(state: "unsupported", code: "camera_unavailable")
            statusLabel.text = "This device does not support ARKit world tracking. Please use an iPhone or iPad that supports ARKit."
            return
        }
        publishStatus(state: "limited", code: "initializing")
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: beginAuthorizedSession(generation: generation)
        case .notDetermined:
            statusLabel.text = "Please allow camera access for on-device spatial tracking."
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                DispatchQueue.main.async {
                    guard let self, self.trackingGeneration == generation else { return }
                    if granted {
                        self.permissionStartGeneration = generation
                        self.beginAuthorizedSession(generation: generation)
                    } else {
                        self.publishStatus(state: "denied", code: "camera_permission")
                        self.statusLabel.text = "Camera permission was denied. You can change it in system settings."
                    }
                }
            }
        case .denied, .restricted:
            publishStatus(state: "denied", code: "camera_permission")
            statusLabel.text = "Camera permission is unavailable. Check permissions in system settings."
        @unknown default:
            publishStatus(state: "error", code: "camera_unavailable")
        }
    }

    private func beginAuthorizedSession(generation: UInt64) {
        guard trackingGeneration == generation, documentReady, origin.matches(webView.url),
              sessionId != nil, AVCaptureDevice.authorizationStatus(for: .video) == .authorized else { return }
        guard UIApplication.shared.applicationState == .active else { return }
        permissionStartGeneration = nil
        guard arSession == nil else { return }
        let configuration = ARWorldTrackingConfiguration()
        configuration.worldAlignment = .gravity
        configuration.isLightEstimationEnabled = false
        let session = ARSession()
        session.delegate = self
        session.delegateQueue = .main
        arSession = session
        session.run(configuration, options: [.resetTracking, .removeExistingAnchors])
        statusLabel.text = "Spatial tracking started. Slowly look around so the camera can recognize your surroundings."
    }

    private func stopTracking(code: String, publish: Bool = true) {
        trackingGeneration &+= 1
        permissionStartGeneration = nil
        arSession?.delegate = nil
        arSession?.pause()
        arSession = nil
        latestPose = nil
        if publish, sessionId != nil { publishStatus(state: "paused", code: code) }
        if !publish { pendingStatus = nil }
        statusLabel.text = "Tracking stopped. Turn it on again in the webpage and align your position."
    }

    private func makePacket(state: String, code: String, timestamp: Double? = nil) -> [String: Any]? {
        guard let sessionId else { return nil }
        sequence += 1
        return [
            "version": 1, "sessionId": sessionId, "sequence": sequence,
            "timestampMs": timestamp ?? Date().timeIntervalSince1970 * 1000,
            "state": state, "messageCode": code
        ]
    }

    private func publishStatus(state: String, code: String) {
        let marker = "\(state):\(code)"
        guard marker != lastStatus, let packet = makePacket(state: state, code: code) else { return }
        lastStatus = marker
        latestPose = nil
        pendingStatus = packet
        flushPacket()
    }

    private func flushPacket() {
        guard javaScriptInFlight == nil, documentReady, origin.matches(webView.url) else { return }
        let packet: [String: Any]?
        if pendingStatus != nil { packet = pendingStatus; pendingStatus = nil }
        else { packet = latestPose; latestPose = nil }
        guard let packet, packet["sessionId"] as? String == sessionId else { return }
        let generation = documentGeneration
        let poseGeneration = trackingGeneration
        let evaluationId = UUID()
        javaScriptInFlight = evaluationId
        // Arguments are serialized by WebKit, never interpolated into JS source.
        webView.callAsyncJavaScript(
            "window.dispatchEvent(new CustomEvent('century:motion', {detail: packet}));",
            arguments: ["packet": packet], in: nil, in: .page
        ) { [weak self] result in
            guard let self, self.javaScriptInFlight == evaluationId else { return }
            self.javaScriptInFlight = nil
            guard self.documentGeneration == generation else { self.flushPacket(); return }
            guard self.trackingGeneration == poseGeneration else { self.flushPacket(); return }
            if case .failure = result {
                self.stopTracking(code: "session_failed", publish: false)
                self.statusLabel.text = "The webpage connection was lost. Tracking stopped. Refresh the demo, then turn tracking on again."
                return
            }
            self.flushPacket()
        }
    }

    func session(_ session: ARSession, didUpdate frame: ARFrame) {
        guard arSession === session, UIApplication.shared.applicationState == .active else { return }
        switch frame.camera.trackingState {
        case .notAvailable:
            publishStatus(state: "limited", code: "camera_unavailable")
            return
        case .limited(let reason):
            let code: String
            switch reason {
            case .initializing: code = "initializing"
            case .relocalizing: code = "relocalizing"
            case .insufficientFeatures: code = "insufficient_features"
            case .excessiveMotion: code = "excessive_motion"
            @unknown default: code = "camera_unavailable"
            }
            publishStatus(state: "limited", code: code)
            return
        case .normal: break
        }
        guard frame.timestamp - lastPoseTimestamp >= 1.0 / 30.0,
              let orientation = view.window?.windowScene?.interfaceOrientation,
              orientation != .unknown else { return }
        lastPoseTimestamp = frame.timestamp
        let pose = simd_inverse(frame.camera.viewMatrix(for: orientation))
        let position = pose.columns.3
        let rotation = simd_quatf(pose).normalized.vector
        let values = [position.x, position.y, position.z, rotation.x, rotation.y, rotation.z, rotation.w]
        guard values.allSatisfy({ $0.isFinite }) else {
            publishStatus(state: "limited", code: "camera_unavailable")
            return
        }
        let captureTime = (Date().timeIntervalSince1970 - ProcessInfo.processInfo.systemUptime + frame.timestamp) * 1000
        guard var packet = makePacket(state: "tracking", code: "tracking", timestamp: captureTime) else { return }
        packet["position"] = [Double(position.x), Double(position.y), Double(position.z)]
        packet["quaternion"] = [Double(rotation.x), Double(rotation.y), Double(rotation.z), Double(rotation.w)]
        lastStatus = "tracking"
        latestPose = packet
        statusLabel.text = "ARKit position and orientation tracking active · Use the webpage to align and calibrate distance"
        flushPacket()
    }

    func session(_ session: ARSession, didFailWithError error: Error) {
        guard arSession === session else { return }
        stopTracking(code: "session_failed", publish: false)
        publishStatus(state: "error", code: "session_failed")
        statusLabel.text = "Spatial tracking failed. Turn it on again in the webpage."
    }

    func sessionWasInterrupted(_ session: ARSession) {
        guard arSession === session else { return }
        stopTracking(code: "camera_unavailable")
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let targetFrame = navigationAction.targetFrame else {
            decisionHandler(.cancel)
            return
        }
        // Subframes receive no injected bridge and cannot request native motion.
        guard origin.matches(navigationAction.request.url) else {
            if targetFrame.isMainFrame {
                stopTracking(code: "paused")
                statusLabel.text = "Navigation to another website was blocked. Return to the start screen to change the demo link."
            }
            decisionHandler(.cancel)
            return
        }
        if targetFrame.isMainFrame { stopTracking(code: "paused") }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        documentGeneration &+= 1
        documentReady = false
        stopTracking(code: "paused", publish: false)
        sessionId = nil
        pendingStatus = nil
        latestPose = nil
        statusLabel.text = "Loading demo…"
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        documentReady = origin.matches(webView.url)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        documentReady = origin.matches(webView.url)
        statusLabel.text = "Demo loaded. Use the Current location and Enable walking buttons in the webpage."
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        stopTracking(code: "session_failed", publish: false)
        documentReady = false
        statusLabel.text = "Could not load the demo. Check your connection, HTTPS link, and demo service."
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        stopTracking(code: "session_failed", publish: false)
        documentReady = false
        statusLabel.text = "The demo failed to load. Go back and open the link again."
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        documentGeneration &+= 1
        documentReady = false
        stopTracking(code: "session_failed", publish: false)
        statusLabel.text = "The webpage process stopped. Go back and open the demo again."
    }

    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        // This shell's camera belongs to native ARKit; no frames reach webpage JS.
        decisionHandler(.deny)
    }
}
