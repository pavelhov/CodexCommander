import AppKit
import MenuBarCore

/// Confirmation copy and button ordering for lifecycle actions.
///
/// Cancel is deliberately focused and made the Return-key default so confirmation
/// keeps the current process state. Immediate stop actions are visually destructive.
package enum LifecycleConfirmation {
    case stopProxy
    case restartProxy
    case stopAndQuit

    package var messageText: String {
        switch self {
        case .stopProxy:
            return "Stop the CodexCommander proxy?"
        case .restartProxy:
            return "Restart CodexCommander?"
        case .stopAndQuit:
            return "Stop CodexCommander and quit?"
        }
    }

    package var informativeText: String {
        switch self {
        case .stopProxy:
            return "Fully quit ChatGPT and Codex before stopping to avoid interrupted work or a cached old endpoint. Reopen them afterward to use native routing. The menu bar app will stay open."
        case .restartProxy:
            return "CodexCommander will stop safely and start again on the same port. Active work may be interrupted."
        case .stopAndQuit:
            return "Fully quit ChatGPT and Codex before stopping to avoid interrupted work or a cached old endpoint. Reopen them afterward to use native routing. The proxy and any installed service will stop."
        }
    }

    package var confirmTitle: String {
        switch self {
        case .stopProxy: return "Stop Proxy"
        case .restartProxy: return "Restart Proxy"
        case .stopAndQuit: return "Stop and Quit"
        }
    }

    package var confirmationResponse: NSApplication.ModalResponse {
        .alertFirstButtonReturn
    }

    package func makeAlert() -> NSAlert {
        let alert = NSAlert()
        alert.messageText = messageText
        alert.informativeText = informativeText
        alert.alertStyle = .warning
        let confirmation = alert.addButton(withTitle: confirmTitle)
        let cancel = alert.addButton(withTitle: "Cancel")
        confirmation.hasDestructiveAction = self != .restartProxy
        // NSAlert places the first-added button on the trailing edge. Add the action
        // first for the conventional visual order, then explicitly keep Cancel as the
        // safe Return-key default and initial focus.
        alert.window.defaultButtonCell = cancel.cell as? NSButtonCell
        alert.window.initialFirstResponder = cancel
        return alert
    }
}

package enum LifecycleResultMessage {
    package static let proxyStopped =
        "Proxy stopped. Fully quit ChatGPT and Codex if still open, then reopen them to use native routing."

    package static func codexRouteSaved(_ destination: CodexRouteDestination) -> (
        title: String,
        detail: String
    ) {
        (
            "\(destination.name) route saved",
            "Quit ChatGPT completely, reopen it, then start a new task to use this route."
        )
    }

    package static func codexRouteFailure(
        _ rawMessage: String,
        errorCode: String? = nil
    ) -> (
        title: String,
        detail: String,
        technicalDetail: String?
    ) {
        if errorCode == "ROUTING_RECOVERY_REQUIRED" {
            return (
                "Codex route was not changed",
                "CodexCommander could not safely verify its previous recovery checkpoint. Your existing route was left unchanged.",
                rawMessage
            )
        }
        return (
            "Codex route could not be confirmed",
            "CodexCommander could not verify the requested route. Check the Codex route shown above before restarting ChatGPT.",
            rawMessage
        )
    }

    package static let codexRouteConfirmationPending = (
        title: "Route was saved, but confirmation is unavailable",
        detail: "Refresh to confirm the Codex route shown above before reopening ChatGPT."
    )
}

/// Fresh activity evidence used only to explain the risk of applying a catalog update.
/// A zero count is deliberately not called "idle": another request can begin between
/// the observation and the confirmed worker restart.
package enum CatalogUpdateActivity: Equatable, Sendable {
    case active(Int)
    case noActiveRequests
    case unknown

    package init(snapshot: AgentActivitySnapshot?) {
        guard let snapshot, snapshot.isSupported, snapshot.activeTurnCount >= 0 else {
            self = .unknown
            return
        }
        self = snapshot.activeTurnCount > 0
            ? .active(snapshot.activeTurnCount)
            : .noActiveRequests
    }
}

package enum CatalogUpdateChoice: Equatable, Sendable {
    case applyNow
    case later
}

/// Confirmation for restarting only Codex's catalog-caching workers.
///
/// This stays separate from proxy lifecycle confirmation because the proxy remains
/// running and a future activity monitor can add an Apply-when-idle choice here.
package struct CatalogUpdateConfirmation {
    package let activity: CatalogUpdateActivity

    package init(activity: CatalogUpdateActivity) {
        self.activity = activity
    }

    package var messageText: String { "Apply the agent catalog update?" }

    package var informativeText: String {
        let activityText: String
        switch activity {
        case .active(let count):
            let requests = count == 1 ? "1 active agent request" : "\(count) active agent requests"
            activityText = "CodexCommander currently reports \(requests)."
        case .noActiveRequests:
            activityText = "CodexCommander currently reports no active agent requests. A new request can still begin before the update is applied."
        case .unknown:
            activityText = "CodexCommander could not verify whether agent requests are active."
        }
        return "\(activityText) Applying now restarts only Codex background workers and may interrupt an answer. CodexCommander remains running."
    }

    package func makeAlert() -> NSAlert {
        let alert = NSAlert()
        alert.messageText = messageText
        alert.informativeText = informativeText
        alert.alertStyle = .warning
        let apply = alert.addButton(withTitle: "Apply Now")
        let later = alert.addButton(withTitle: "Later")
        // Even a fresh zero is only an observation; a request can start before apply.
        apply.hasDestructiveAction = true
        alert.window.defaultButtonCell = later.cell as? NSButtonCell
        alert.window.initialFirstResponder = later
        return alert
    }

    package func choice(for response: NSApplication.ModalResponse) -> CatalogUpdateChoice {
        response == .alertFirstButtonReturn ? .applyNow : .later
    }
}

package enum CompanionShortcut {
    package static let keyEquivalent = "q"
    package static let quitModifiers: NSEvent.ModifierFlags = [.command]
    package static let stopAndQuitModifiers: NSEvent.ModifierFlags = [.command, .option]
}

package enum LifecycleActionAvailability {
    package static func canStopAndQuit(
        state: ProxyState?,
        controlsAllowed: Bool
    ) -> Bool {
        guard controlsAllowed, let state else { return false }
        switch state {
        case .running, .unauthorized, .degraded: return true
        case .loading, .unreachable: return false
        }
    }
}

package enum CatalogUpdateActionAvailability {
    package static func canApply(
        updateReady: Bool,
        state: ProxyState?,
        controlsAllowed: Bool
    ) -> Bool {
        updateReady && controlsAllowed && state?.isRunning == true
    }
}

/// Registers both exit contracts with standard macOS key equivalents while the
/// companion is active, and preserves responder-chain editing commands.
package enum ApplicationMenuFactory {
    package static func make(
        target: AnyObject,
        quitAction: Selector,
        stopAndQuitAction: Selector
    ) -> NSMenu {
        let applicationMenu = NSMenu(title: "CodexCommander")

        let stopAndQuit = NSMenuItem(
            title: "Stop CodexCommander and Quit…",
            action: stopAndQuitAction,
            keyEquivalent: CompanionShortcut.keyEquivalent
        )
        stopAndQuit.target = target
        stopAndQuit.keyEquivalentModifierMask = CompanionShortcut.stopAndQuitModifiers
        stopAndQuit.isEnabled = false
        applicationMenu.addItem(stopAndQuit)
        applicationMenu.addItem(.separator())

        // Keep the conventional last application-menu item and ⌘Q behavior safe:
        // quitting the companion never silently stops the independently running proxy.
        let quitMenuBar = NSMenuItem(
            title: "Quit Menu Bar",
            action: quitAction,
            keyEquivalent: CompanionShortcut.keyEquivalent
        )
        quitMenuBar.target = target
        quitMenuBar.keyEquivalentModifierMask = CompanionShortcut.quitModifiers
        applicationMenu.addItem(quitMenuBar)

        let root = NSMenu(title: "Main")
        let applicationItem = NSMenuItem(title: "CodexCommander", action: nil, keyEquivalent: "")
        applicationItem.submenu = applicationMenu
        root.addItem(applicationItem)

        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(responderItem("Cut", action: #selector(NSText.cut(_:)), key: "x"))
        editMenu.addItem(responderItem("Copy", action: #selector(NSText.copy(_:)), key: "c"))
        editMenu.addItem(responderItem("Paste", action: #selector(NSText.paste(_:)), key: "v"))
        editMenu.addItem(.separator())
        editMenu.addItem(
            responderItem("Select All", action: #selector(NSText.selectAll(_:)), key: "a")
        )
        let editItem = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
        editItem.submenu = editMenu
        root.addItem(editItem)
        return root
    }

    private static func responderItem(
        _ title: String,
        action: Selector,
        key: String
    ) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.keyEquivalentModifierMask = [.command]
        // A nil target deliberately follows the responder chain to the active field
        // editor, which keeps selectable command text keyboard-accessible.
        item.target = nil
        return item
    }
}

/// The companion exits only after the lifecycle helper proves the proxy is stopped.
/// A failed or ambiguous stop leaves the UI alive so the user can see and recover.
package enum StopAndQuitPolicy {
    package static func shouldTerminate(after outcome: ProxyControlOutcome) -> Bool {
        if case .stopped = outcome { return true }
        return false
    }
}
