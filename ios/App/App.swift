import UIKit

/// Tally on iPhone: the same page as the website, kept in the app.
@MainActor
enum App {
    // The page already knows this address as "inside the app".
    static let config = ShellConfig(
        bridge: "tallyApp",
        host: "appassets.androidplatform.net",
        root: "/assets/",
        start: "/assets/index.html",
        background: UIColor(named: "Page") ?? .systemBackground
    )

    private static var ready = false
    /// A page has been ready at some point since the app started.
    private static var started = false
    /// A group link that came while the page was starting again.
    private static var waiting: String?
    private static var unsent = false
    private static var holding = UIBackgroundTaskIdentifier.invalid

    static func launched() {
        NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { _ in
            // Straight away: the time iOS allows has to be asked for before this returns.
            MainActor.assumeIsolated { hold() }
        }
    }

    static func setUp(_ shell: Shell) {
        // The page reads this before it draws.
        shell.scripts = ["window.tallyApp.ios = true;"]
        shell.onReady = {
            ready = true
            started = true
            if let id = waiting {
                waiting = nil
                Shell.current?.send(["type": "openLink", "url": id])
            }
        }
        // The page is starting again: a link waits for it rather than going to a page that isn't there.
        shell.onRestart = { ready = false }
        shell.onMessage = { type, msg in
            switch type {
            case "unsent":
                unsent = msg["on"] as? Bool ?? false
                if !unsent { letGo() }
                return true
            // Android's Back key, its background check and its updater.
            case "back", "watch", "checkUpdate", "installUpdate":
                return true
            default:
                return false
            }
        }
    }

    /// Changes still waiting to be sent: ask iOS for a little longer when the app goes out of sight.
    private static func hold() {
        guard unsent, holding == .invalid else { return }
        holding = UIApplication.shared.beginBackgroundTask { Task { @MainActor in letGo() } }
    }

    private static func letGo() {
        guard holding != .invalid else { return }
        UIApplication.shared.endBackgroundTask(holding)
        holding = .invalid
    }

    /// A group's link: https://tally.teloone.au/g/<id>, or tally://g/<id>.
    /// A join code's link: https://tally.teloone.au/j/<code>.
    static func opened(link: URL) {
        let path = link.scheme == "tally" ? "/" + (link.host ?? "") + link.path : link.path
        let isCode = path.range(of: "^/j/[A-Za-z]{4}/?$", options: .regularExpression) != nil
        guard isCode || path.range(of: "^/g/[A-Za-z0-9_-]{22}/?$", options: .regularExpression) != nil else { return }
        let id = String(path.dropFirst(3).prefix(isCode ? 4 : 22))
        // What the page is told: a group's id, or a code as its short path.
        let told = isCode ? "/j/" + id : id
        if ready {
            Shell.current?.send(["type": "openLink", "url": told])
        } else if started {
            // The page is on its way back and would miss a change of address: it gets the link when it says hello.
            waiting = told
        } else {
            Shell.current?.show(config.start + (isCode ? "#j=" : "#g=") + id)
        }
    }

    static func opened(notification: [AnyHashable: Any]) {}
}
