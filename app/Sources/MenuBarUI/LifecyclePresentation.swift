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
            return "Stop the OpenCodex proxy?"
        case .restartProxy:
            return "Restart OpenCodex?"
        case .stopAndQuit:
            return "Stop OpenCodex and quit?"
        }
    }

    package var informativeText: String {
        switch self {
        case .stopProxy:
            return "Active Codex, Claude, OpenCode, and subagent requests will be interrupted. The menu bar app will stay open."
        case .restartProxy:
            return "Active turns will drain, then OpenCodex will come back on the same port."
        case .stopAndQuit:
            return "The background proxy will stop, along with any installed OpenCodex service. Active Codex, Claude, OpenCode, and subagent requests may be interrupted, and Codex will use native routing until OpenCodex is started again."
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

/// Registers both exit contracts with standard macOS key equivalents while the
/// companion is active, and preserves responder-chain editing commands.
package enum ApplicationMenuFactory {
    package static func make(
        target: AnyObject,
        quitAction: Selector,
        stopAndQuitAction: Selector
    ) -> NSMenu {
        let applicationMenu = NSMenu(title: "OpenCodex")

        let stopAndQuit = NSMenuItem(
            title: "Stop OpenCodex and Quit…",
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
        let applicationItem = NSMenuItem(title: "OpenCodex", action: nil, keyEquivalent: "")
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
