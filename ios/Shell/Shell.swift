import UIKit
import WebKit
import UserNotifications
import UniformTypeIdentifiers

/// What differs between the apps. Each app's App.swift fills one in.
struct ShellConfig {
    /// The object pages talk to: `window.<bridge>.postMessage(json)`.
    let bridge: String
    /// Where the bundled pages appear to live: app://<host><root>...
    let host: String
    let root: String
    /// The first page.
    let start: String
    let background: UIColor
    /// For single-page apps: addresses with no file behind them that still show the app.
    var isAppPath: (String) -> Bool = { _ in false }
}

/// Shows the app's own bundled pages in a web view and gives them a few things
/// a page can't do alone: the share sheet, haptics, notifications.
final class Shell: UIViewController, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    static let scheme = "app"
    static private(set) weak var current: Shell?

    let config: ShellConfig
    private(set) var web: WKWebView!
    /// Messages only this app knows. Return true when one is dealt with.
    var onMessage: (String, [String: Any]) -> Bool = { _, _ in false }
    /// More to tell a page when it says hello.
    var info: () -> [String: Any] = { [:] }
    /// A page has said hello and can take messages.
    var onReady: () -> Void = {}
    /// The app is in front again.
    var onActive: () -> Void = {}
    /// iOS ended the page's process and the page is starting again: it can't take messages until it says hello.
    var onRestart: () -> Void = {}
    /// Scripts to run before each page's own.
    var scripts: [String] = []
    /// Answers a page needs before it can carry on: `prompt('shell:<what>')`.
    var answer: (String) -> String? = { _ in nil }

    private var first: String?
    private let tick = UISelectionFeedbackGenerator()
    private let tap = UIImpactFeedbackGenerator(style: .light)

    init(config: ShellConfig) {
        self.config = config
        super.init(nibName: nil, bundle: nil)
        Shell.current = self
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func url(_ path: String) -> URL { URL(string: "\(Shell.scheme)://\(config.host)\(path)")! }

    /// Opens a page of the app, now or as the first page if nothing is up yet.
    func show(_ path: String) {
        if isViewLoaded { web.load(URLRequest(url: url(path))) } else { first = path }
    }

    // MARK: Screen

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = config.background

        let setup = WKWebViewConfiguration()
        setup.setURLSchemeHandler(Pages(config: config), forURLScheme: Shell.scheme)
        setup.allowsInlineMediaPlayback = true
        setup.mediaTypesRequiringUserActionForPlayback = []
        setup.dataDetectorTypes = []
        let content = setup.userContentController
        content.add(self, name: "shell")
        let bridge = """
        (() => {
          const out = window.webkit.messageHandlers.shell;
          window.\(config.bridge) = { postMessage: s => out.postMessage(String(s)), onmessage: null };
        })();
        """
        for source in [Shell.restoreScript(), bridge, Shell.feel] + scripts where !source.isEmpty {
            content.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }

        web = WKWebView(frame: view.bounds, configuration: setup)
        web.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        web.navigationDelegate = self
        web.uiDelegate = self
        web.isOpaque = false
        web.backgroundColor = config.background
        web.scrollView.backgroundColor = config.background
        // The pages keep clear of the notch and home bar themselves.
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.allowsBackForwardNavigationGestures = true
        web.allowsLinkPreview = false
        #if DEBUG
        web.isInspectable = true
        #endif
        view.addSubview(web)
        web.load(URLRequest(url: url(first ?? config.start)))

        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(resigned), name: UIApplication.willResignActiveNotification, object: nil)
        center.addObserver(self, selector: #selector(active), name: UIApplication.didBecomeActiveNotification, object: nil)
    }

    /// What makes the pages sit like an app: no pinch or double-tap zoom, no
    /// long-press menus or text selection outside fields, and nothing showing
    /// through behind the clock when a page scrolls.
    private static let feel = #"""
    (() => {
      const style = document.createElement('style');
      style.textContent =
        '*{-webkit-touch-callout:none}' +
        'body{-webkit-user-select:none;user-select:none}' +
        'input,textarea,[contenteditable]{-webkit-user-select:text;user-select:text}' +
        'a,img{-webkit-user-drag:none}' +
        'body::before{content:"";position:fixed;top:0;left:0;right:0;height:env(safe-area-inset-top,0px);background:inherit;z-index:9;pointer-events:none}';
      document.documentElement.appendChild(style);
      const fix = () => {
        const meta = document.querySelector('meta[name="viewport"]');
        if (meta && !/user-scalable/.test(meta.content)) meta.content += ',maximum-scale=1,user-scalable=no';
      };
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fix); else fix();
    })();
    """#

    @objc private func active() { onActive() }
    @objc private func resigned() { keepStorage() }

    // MARK: Messages

    /// To the page: arrives as `<bridge>.onmessage({ data: json })`.
    func send(_ message: [String: Any]) {
        guard isViewLoaded,
              let json = try? JSONSerialization.data(withJSONObject: message),
              let text = String(data: json, encoding: .utf8),
              let quoted = try? JSONSerialization.data(withJSONObject: text, options: .fragmentsAllowed),
              let literal = String(data: quoted, encoding: .utf8) else { return }
        run("(() => { const a = window.\(config.bridge); if (a && typeof a.onmessage === 'function') a.onmessage({ data: \(literal) }); })()")
    }

    /// Runs a line of script in the page.
    func run(_ script: String) {
        guard isViewLoaded else { return }
        web.evaluateJavaScript(script, completionHandler: nil)
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        // Only the app's own pages are ever the main frame: anything else opens in Safari.
        guard message.frameInfo.isMainFrame, web.url?.scheme == Shell.scheme,
              let text = message.body as? String, let data = text.data(using: .utf8),
              let msg = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let type = msg["type"] as? String else { return }
        if onMessage(type, msg) { return }
        switch type {
        case "hello":
            Notices.allowed { [weak self] allowed in
                guard let self else { return }
                var reply: [String: Any] = [
                    "type": "info",
                    "version": Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "",
                    "updates": false,
                    "platform": "ios",
                    "notifications": allowed,
                ]
                reply.merge(self.info()) { _, new in new }
                self.send(reply)
                self.onReady()
            }
        case "share":
            let sheet = UIActivityViewController(activityItems: [msg["text"] as? String ?? ""], applicationActivities: nil)
            if let title = msg["title"] as? String { sheet.setValue(title, forKey: "subject") }
            sheet.popoverPresentationController?.sourceView = view
            sheet.popoverPresentationController?.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.maxY - 80, width: 1, height: 1)
            if presentedViewController == nil { present(sheet, animated: true) }
        case "haptic":
            if msg["kind"] as? String == "tick" { tick.selectionChanged() } else { tap.impactOccurred() }
        case "askNotifications":
            Notices.ask { [weak self] allowed in self?.send(["type": "notifications", "allowed": allowed]) }
        case "notify":
            Notices.replace(msg["items"] as? [[String: Any]] ?? [])
        case "openSettings":
            if let settings = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(settings) }
        default:
            break
        }
    }

    // MARK: Leaving the app's pages

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { return decisionHandler(.cancel) }
        if url.scheme == Shell.scheme || url.scheme == "about" || url.scheme == "blob" { return decisionHandler(.allow) }
        if let frame = navigationAction.targetFrame, !frame.isMainFrame { return decisionHandler(.allow) }
        leave(to: url)
        decisionHandler(.cancel)
    }

    /// Opens a link outside the app. With no mail app set up, an email link
    /// would do nothing, so the address is shown instead.
    private func leave(to url: URL) {
        UIApplication.shared.open(url) { [weak self] opened in
            guard !opened, url.scheme == "mailto", let self, self.presentedViewController == nil else { return }
            let address = URLComponents(url: url, resolvingAgainstBaseURL: false)?.path ?? ""
            guard !address.isEmpty else { return }
            let alert = UIAlertController(title: "No mail app is set up", message: "Email \(address) from any device.", preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "Copy address", style: .default) { _ in UIPasteboard.general.string = address })
            alert.addAction(UIAlertAction(title: "OK", style: .cancel))
            self.present(alert, animated: true)
        }
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url {
            if url.scheme == Shell.scheme { webView.load(navigationAction.request) } else { leave(to: url) }
        }
        return nil
    }

    /// iOS ended the page's process to free memory: start the page again.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        onRestart()
        if webView.url == nil { webView.load(URLRequest(url: url(config.start))) } else { webView.reload() }
    }

    // MARK: Page dialogs

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        // WebKit must get its answer even when nothing can be shown.
        guard viewIfLoaded?.window != nil, presentedViewController == nil else { return completionHandler() }
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        guard viewIfLoaded?.window != nil, presentedViewController == nil else { return completionHandler(false) }
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        present(alert, animated: true)
    }

    // The pages never ask for typed text this way, so prompt() is how one gets
    // an answer from the app without waiting for a message back.
    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        guard frame.isMainFrame, webView.url?.scheme == Shell.scheme, prompt.hasPrefix("shell:") else { return completionHandler(nil) }
        completionHandler(answer(String(prompt.dropFirst(6))))
    }

    // MARK: Keeping what the pages store

    // Pages keep their data in web storage, which iOS may clear when the phone
    // runs short of space. A copy goes in the app's own files, which are in the
    // phone's backup, and is put back if the storage is ever found empty.
    private static var storageFile: URL {
        let folder = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder.appendingPathComponent("storage.json")
    }

    private static func restoreScript() -> String {
        guard let saved = try? String(contentsOf: storageFile, encoding: .utf8), saved.hasPrefix("{"), saved.count > 2 else { return "" }
        return "(() => { try { if (!localStorage.length) { const s = \(saved); for (const k in s) localStorage.setItem(k, s[k]); } } catch (e) {} })();"
    }

    func keepStorage() {
        guard isViewLoaded, web.url?.scheme == Shell.scheme else { return }
        web.evaluateJavaScript("JSON.stringify(localStorage)") { value, _ in
            guard let text = value as? String, text.hasPrefix("{"), let data = text.data(using: .utf8) else { return }
            try? data.write(to: Shell.storageFile, options: .atomic)
        }
    }
}

/// Serves the bundled web folder to the web view.
final class Pages: NSObject, WKURLSchemeHandler {
    private let config: ShellConfig
    private let folder: URL
    private static let types = [
        "html": "text/html; charset=utf-8", "js": "text/javascript; charset=utf-8", "mjs": "text/javascript; charset=utf-8",
        "css": "text/css; charset=utf-8", "json": "application/json", "webmanifest": "application/manifest+json",
        "svg": "image/svg+xml", "png": "image/png", "jpg": "image/jpeg", "webp": "image/webp", "ico": "image/x-icon",
        "woff2": "font/woff2", "woff": "font/woff", "txt": "text/plain; charset=utf-8", "wasm": "application/wasm",
    ]

    init(config: ShellConfig) {
        self.config = config
        folder = Bundle.main.resourceURL!.appendingPathComponent("web", isDirectory: true).standardizedFileURL
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url, let file = file(for: url.path), let data = try? Data(contentsOf: file) else {
            return task.didFailWithError(URLError(.fileDoesNotExist))
        }
        let ext = file.pathExtension.lowercased()
        let type = Pages.types[ext] ?? UTType(filenameExtension: ext)?.preferredMIMEType ?? "application/octet-stream"
        let headers = ["Content-Type": type, "Content-Length": String(data.count), "Cache-Control": "no-cache"]
        guard let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers) else {
            return task.didFailWithError(URLError(.badServerResponse))
        }
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}

    private func file(for path: String) -> URL? {
        guard path.hasPrefix(config.root) else { return nil }
        var rest = String(path.dropFirst(config.root.count))
        if rest.isEmpty || rest.hasSuffix("/") { rest += "index.html" }
        let file = folder.appendingPathComponent(rest).standardizedFileURL
        var isFolder: ObjCBool = false
        if file.path.hasPrefix(folder.path + "/"), FileManager.default.fileExists(atPath: file.path, isDirectory: &isFolder), !isFolder.boolValue { return file }
        return config.isAppPath(path) ? folder.appendingPathComponent("index.html") : nil
    }
}

/// Notifications the phone shows by itself at a set time. No server involved.
enum Notices {
    static func allowed(_ done: @escaping (Bool) -> Void) {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            let status = settings.authorizationStatus
            DispatchQueue.main.async { done(status == .authorized || status == .provisional) }
        }
    }

    static func ask(_ done: @escaping (Bool) -> Void) {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { allowed, _ in
            DispatchQueue.main.async { done(allowed) }
        }
    }

    /// Swaps everything waiting for these: [{ id, at (ms), title, body, open }].
    /// iOS keeps at most 64 per app, so only the soonest go in.
    static func replace(_ items: [[String: Any]], limit: Int = 60) {
        let center = UNUserNotificationCenter.current()
        center.removeAllPendingNotificationRequests()
        let now = Date().timeIntervalSince1970 * 1000
        let due = items
            .compactMap { item -> (at: Double, item: [String: Any])? in
                guard let at = (item["at"] as? NSNumber)?.doubleValue, at > now else { return nil }
                return (at, item)
            }
            .sorted { $0.at < $1.at }
            .prefix(limit)
        for (at, item) in due {
            let content = UNMutableNotificationContent()
            content.title = item["title"] as? String ?? ""
            content.body = item["body"] as? String ?? ""
            content.sound = .default
            if let open = item["open"] as? String { content.userInfo = ["open": open] }
            let when = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute, .second], from: Date(timeIntervalSince1970: at / 1000))
            let id = item["id"] as? String ?? String(Int(at))
            center.add(UNNotificationRequest(identifier: id, content: content, trigger: UNCalendarNotificationTrigger(dateMatching: when, repeats: false)))
        }
    }
}

@main
final class AppDelegate: UIResponder, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        App.launched()
        return true
    }

    func application(_ application: UIApplication, configurationForConnecting connectingSceneSession: UISceneSession, options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let scene = UISceneConfiguration(name: "Default", sessionRole: connectingSceneSession.role)
        scene.delegateClass = SceneDelegate.self
        return scene
    }

    // A reminder that comes due while the app is open still shows.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
        DispatchQueue.main.async { App.opened(notification: info) }
        completionHandler()
    }
}

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        let shell = Shell(config: App.config)
        App.setUp(shell)
        let window = UIWindow(windowScene: scene)
        window.backgroundColor = App.config.background
        window.rootViewController = shell
        window.makeKeyAndVisible()
        self.window = window
        let web = connectionOptions.userActivities.first { $0.activityType == NSUserActivityTypeBrowsingWeb }?.webpageURL
        if let link = web ?? connectionOptions.urlContexts.first?.url { App.opened(link: link) }
        #if DEBUG
        // For checks in the simulator: `simctl launch <device> <bundle> -link <url>`.
        let args = ProcessInfo.processInfo.arguments
        if let at = args.firstIndex(of: "-link"), at + 1 < args.count, let link = URL(string: args[at + 1]) { App.opened(link: link) }
        #endif
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        if userActivity.activityType == NSUserActivityTypeBrowsingWeb, let link = userActivity.webpageURL { App.opened(link: link) }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        if let link = URLContexts.first?.url { App.opened(link: link) }
    }
}
