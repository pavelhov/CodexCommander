import AppKit
import MenuBarCore
import MenuBarUI

// UI-layer tests for the approved menu-bar panel: hierarchy, accordion behaviour,
// deep-link encoding, accessibility, and panel sizing.

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)

let runner = TestRunner()

final class ApplicationMenuTarget: NSObject {
    @objc func quitMenuBar(_ sender: Any?) {}
    @objc func stopOpenCodexAndQuit(_ sender: Any?) {}
}

func quotaJSON(
    provider: String,
    label: String,
    fiveHour: Double? = nil,
    weekly: Double? = nil,
    monthly: Double? = nil
) -> String {
    var parts: [String] = []
    if let fiveHour { parts.append("\"fiveHourPercent\":\(fiveHour)") }
    if let weekly { parts.append("\"weeklyPercent\":\(weekly)") }
    if let monthly { parts.append("\"monthlyPercent\":\(monthly)") }
    let quota = parts.isEmpty ? "null" : "{\(parts.joined(separator: ","))}"
    return "{\"provider\":\"\(provider)\",\"label\":\"\(label)\",\"quota\":\(quota)}"
}

func decodeQuotas(_ json: String) -> [QuotaReport] {
    try! JSONDecoder().decode([QuotaReport].self, from: Data(json.utf8))
}

func decodeProviders(_ json: String) -> [ProviderSummary] {
    try! JSONDecoder().decode([ProviderSummary].self, from: Data(json.utf8))
}

func decodeQuotaAvailability(_ json: String) -> [ProviderQuotaAvailability] {
    try! JSONDecoder().decode([ProviderQuotaAvailability].self, from: Data(json.utf8))
}

func activitySnapshot(
    activities: String,
    unattributed: Int = 0,
    truncated: Bool = false
) -> AgentActivitySnapshot {
    let json = """
    {
      "schemaVersion": 1,
      "generatedAt": 1,
      "proxyState": "running",
      "activeTurnCount": 2,
      "displayedActivityCount": 2,
      "unattributedActiveCount": \(unattributed),
      "truncated": \(truncated ? "true" : "false"),
      "activities": [\(activities)]
    }
    """
    return try! JSONDecoder().decode(AgentActivitySnapshot.self, from: Data(json.utf8))
}

func makeSnapshot(
    quotas: [QuotaReport] = [],
    quotaAvailability: [ProviderQuotaAvailability] = [],
    activity: AgentActivitySnapshot? = nil,
    providers: [ProviderSummary] = [],
    health: StartupHealth = StartupHealth(status: "protected"),
    providersLoaded: Bool = false,
    quotasLoaded: Bool = true,
    activityLoaded: Bool = true
) -> ProxySnapshot {
    ProxySnapshot(
        state: .running(health),
        endpoint: .default,
        quotas: quotas,
        quotaAvailability: quotaAvailability,
        activity: activity,
        providers: providers,
        lastUpdated: Date(),
        providersLoaded: providersLoaded,
        quotasLoaded: quotasLoaded,
        activityLoaded: activityLoaded
    )
}

// MARK: - Hierarchy / sizing

runner.test("ui: panel prefers the approved width") {
    let controller = PopoverViewController()
    _ = controller.view
    runner.equal(controller.preferredContentSize.width, 387, "width")
    runner.equal(controller.preferredContentSize.height, 468, "height")
}

runner.test("ui: nonactivating panel remains key-capable for Escape and keyboard controls") {
    let panel = PopoverPanel()
    panel.contentViewController = PopoverViewController()
    runner.equal(panel.canBecomeKey, true)
    runner.equal(panel.canBecomeMain, false)
    runner.expect(panel.styleMask.contains(.nonactivatingPanel), "nonactivating status panel")
    runner.equal(panel.contentViewController?.preferredContentSize.width, 387)
}

runner.test("ui: menu-bar glyph distinguishes every operational state") {
    let states: [ProxyState] = [
        .loading,
        .running(StartupHealth(status: "protected")),
        .running(StartupHealth(status: "at-risk")),
        .unreachable,
        .unauthorized,
        .degraded("Unavailable"),
    ]
    let symbols = states.map(StatusIcon.symbolName(for:))
    runner.equal(Set(symbols).count, states.count, "one symbol per state")
}

runner.test("ui: footer exposes navigation, proxy lifecycle, and both exit contracts") {
    let controller = PopoverViewController()
    _ = controller.view
    let titles = controller.footerTitles
    runner.equal(
        titles,
        [
            "Dashboard", "Logs", "Refresh", "Start Proxy", "Restart Proxy…",
            "Quit Menu Bar", "Stop OpenCodex and Quit…",
        ],
        "footer titles"
    )
}

runner.test("ui: startup control exposes desktop, headless, off, and approval states") {
    let controller = PopoverViewController()
    _ = controller.view

    controller.applyLaunchAtLogin(
        LaunchAtLoginPresentation(status: .enabled, desiredEnabled: true)
    )
    controller.apply(makeSnapshot(health: StartupHealth(
        status: "protected",
        protection: "service",
        serviceInstalled: true,
        serviceEnabled: true
    )))
    runner.equal(
        controller.startupModeView.modeText,
        "Desktop · Quit Menu Bar leaves proxy running"
    )
    runner.equal(controller.startupModeView.isLaunchAtLoginOn, true)

    controller.applyLaunchAtLogin(
        LaunchAtLoginPresentation(status: .disabled, desiredEnabled: false)
    )
    runner.equal(
        controller.startupModeView.modeText,
        "Headless · proxy runs without the menu bar"
    )

    controller.apply(makeSnapshot(health: StartupHealth(status: "at-risk")))
    runner.equal(
        controller.startupModeView.modeText,
        "Off · start OpenCodex manually"
    )

    controller.applyLaunchAtLogin(
        LaunchAtLoginPresentation(status: .requiresApproval, desiredEnabled: true)
    )
    runner.expect(
        controller.startupModeView.showsSettingsButton,
        "approval state should expose Login Items settings"
    )
}

runner.test("ui: startup control forwards explicit preference changes") {
    let controller = PopoverViewController()
    _ = controller.view
    var requested: Bool?
    var openedSettings = false
    controller.onLaunchAtLoginChange = { requested = $0 }
    controller.onOpenLoginSettings = { openedSettings = true }

    controller.startupModeView.toggleForTesting(true)
    runner.equal(requested, true)
    controller.startupModeView.onOpenSettings?()
    runner.equal(openedSettings, true)
}

// MARK: - Accordion / no duplicates

runner.test("ui: ChatGPT/OpenAI expands first; Kimi and Grok stay collapsed") {
    let quotas = decodeQuotas("""
    [
      \(quotaJSON(provider: "xai", label: "Grok", monthly: 41)),
      \(quotaJSON(provider: "kimi", label: "Kimi", fiveHour: 62, weekly: 38)),
      \(quotaJSON(provider: "openai", label: "ChatGPT", fiveHour: 38, weekly: 22))
    ]
    """)
    let accordion = ProviderQuotaAccordionView()
    accordion.apply(makeSnapshot(quotas: quotas))

    runner.equal(accordion.providerIDs, ["openai", "kimi", "xai"], "stable order")
    runner.equal(accordion.providerRowCount, 3, "one row per provider")
    runner.expect(accordion.expandedProviderIDs.contains("openai"), "openai expanded")
    runner.expect(!accordion.expandedProviderIDs.contains("kimi"), "kimi collapsed")
    runner.expect(!accordion.expandedProviderIDs.contains("xai"), "grok collapsed")

    accordion.toggleForTesting("kimi")
    runner.equal(accordion.expandedProviderIDs, ["kimi"], "one open section")
}

runner.test("ui: configured Grok stays visible when its quota report is unavailable") {
    let quotas = decodeQuotas("""
    [
      \(quotaJSON(provider: "openai", label: "ChatGPT", weekly: 22)),
      \(quotaJSON(provider: "kimi", label: "Kimi", weekly: 38))
    ]
    """)
    let providers = decodeProviders("""
    [
      {"name":"openai","authMode":"forward","quotaCapable":true},
      {"name":"kimi","authMode":"oauth","quotaCapable":true},
      {"name":"xai","authMode":"oauth","quotaCapable":true}
    ]
    """)
    let accordion = ProviderQuotaAccordionView()
    let availability = decodeQuotaAvailability("""
    [{"provider":"xai","status":"unavailable",
      "reason":"local_cli_refresh_required","checkedAt":1}]
    """)
    accordion.apply(makeSnapshot(
        quotas: quotas,
        quotaAvailability: availability,
        providers: providers,
        providersLoaded: true
    ))

    runner.equal(
        accordion.providerIDs,
        ["openai", "kimi", "xai"],
        "missing Grok report gets one placeholder"
    )
    runner.equal(
        accordion.unavailableProviderIDs,
        ["xai"],
        "placeholder carries no quota claim"
    )
    runner.expect(
        accordion.providerAccessibilityLabelForTesting("xai")?.contains("login needs refresh") == true,
        "VoiceOver names the actionable login state"
    )
}

runner.test("ui: an unavailable configured provider is a row, not an empty state") {
    let providers = decodeProviders("""
    [{"name":"xai","authMode":"oauth","quotaCapable":true}]
    """)
    let accordion = ProviderQuotaAccordionView()
    accordion.apply(makeSnapshot(providers: providers, providersLoaded: true))

    runner.equal(accordion.providerIDs, ["xai"])
    runner.equal(accordion.unavailableProviderIDs, ["xai"])
    runner.expect(!accordion.showsEmptyState, "connected provider must not render the no-sources message")
}

runner.test("ui: actual reports win; disabled and unsupported providers get no placeholder") {
    let quotas = decodeQuotas("[\(quotaJSON(provider: "xai", label: "Grok", monthly: 41))]")
    let providers = decodeProviders("""
    [
      {"name":"xai","authMode":"oauth","quotaCapable":true},
      {"name":"anthropic","authMode":"oauth","quotaCapable":true,"disabled":true},
      {"name":"deepseek","authMode":"key","quotaCapable":false}
    ]
    """)
    let accordion = ProviderQuotaAccordionView()
    accordion.apply(makeSnapshot(quotas: quotas, providers: providers, providersLoaded: true))

    runner.equal(accordion.providerIDs, ["xai"], "no duplicate or unsupported placeholders")
    runner.equal(accordion.unavailableProviderIDs, [], "actual report remains authoritative")
}

runner.test("ui: provider and view-all controls invoke their dashboard handoffs") {
    let accordion = ProviderQuotaAccordionView()
    var managed: String?
    var viewedAll = false
    accordion.onManage = { managed = $0 }
    accordion.onViewAll = { viewedAll = true }
    accordion.triggerManageForTesting("kimi")
    accordion.triggerViewAllForTesting()
    runner.equal(managed, "kimi")
    runner.equal(viewedAll, true)
}

runner.test("ui: quota header toggles without covering the nested Manage control") {
    let report = quotaJSON(provider: "openai", label: "ChatGPT", fiveHour: 12)
    let quotas = decodeQuotas("[\(report)]")
    let accordion = ProviderQuotaAccordionView(
        frame: NSRect(x: 0, y: 0, width: 355, height: 180)
    )
    let window = NSWindow(
        contentRect: accordion.frame,
        styleMask: .borderless,
        backing: .buffered,
        defer: false
    )
    window.contentView = accordion
    window.orderFront(nil)
    accordion.apply(makeSnapshot(quotas: quotas))
    window.contentView?.layoutSubtreeIfNeeded()
    runner.expect(
        accordion.providerHeaderHitTestingWorksForTesting("openai"),
        "header should hit its toggle and pass Manage clicks through"
    )
}

runner.test("ui: no duplicate provider strip — accordion is the only provider surface") {
    let quotas = decodeQuotas("""
    [
      \(quotaJSON(provider: "openai", label: "ChatGPT", fiveHour: 10)),
      \(quotaJSON(provider: "kimi", label: "Kimi", weekly: 20))
    ]
    """)
    let controller = PopoverViewController()
    _ = controller.view
    controller.apply(makeSnapshot(quotas: quotas))
    runner.equal(controller.quotaAccordion.providerRowCount, 2, "single accordion")
    runner.equal(controller.quotaAccordion.providerIDs.count, Set(controller.quotaAccordion.providerIDs).count, "unique providers")
}

runner.test("ui: OpenCode Go renders published caps and honest local observation semantics") {
    let quotas = decodeQuotas("""
    [{"provider":"opencode-go","label":"OpenCode Go","quota":{
      "referenceWindows":[
        {"id":"five_hour","label":"5-hour","windowSeconds":18000,
         "publishedLimitUsd":12,"observedSpendUsd":0.3,"observedTokens":1000120,
         "observedRequests":3,"pricedRequests":3,"unpricedRequests":0,
         "unmeasuredRequests":0,"coverage":"complete"},
        {"id":"weekly","label":"7-day","windowSeconds":604800,
         "publishedLimitUsd":30,"observedSpendUsd":1.1,"observedTokens":2400000,
         "observedRequests":4,"pricedRequests":2,"unpricedRequests":1,
         "unmeasuredRequests":1,"coverage":"partial"},
        {"id":"monthly","label":"30-day","windowSeconds":2592000,
         "publishedLimitUsd":60,"observedTokens":0,"observedRequests":0,
         "pricedRequests":0,"unpricedRequests":0,"unmeasuredRequests":0,
         "coverage":"none"}],
      "observedLimitEvent":{"limitName":"weekly","observedAt":1784915000000,
                            "resetAt":1784918600000}}}]
    """)
    let report = quotas[0]
    let references = report.referenceWindows
    runner.equal(ReferenceQuotaPresentation.capText(references[0]), "5h · Published cap $12")
    runner.equal(ReferenceQuotaPresentation.capText(references[1]), "7d · Published cap $30")
    runner.equal(ReferenceQuotaPresentation.capText(references[2]), "30d · Published cap $60")
    runner.equal(
        ReferenceQuotaPresentation.observationText(references[0]),
        "Estimate $0.30 · 1,000,120 tokens · 3 requests"
    )
    runner.expect(
        ReferenceQuotaPresentation.observationText(references[1]).hasPrefix("Partial estimate $1.10"),
        "partial observation label"
    )
    runner.equal(
        ReferenceQuotaPresentation.observationText(references[2]),
        "No local usage observed"
    )
    let event = report.observedLimitEvent!
    runner.equal(ReferenceQuotaPresentation.limitTitle(event), "Observed weekly limit")
    runner.equal(
        ReferenceQuotaPresentation.limitDetail(
            event,
            now: Date(timeIntervalSince1970: 1_784_915_000)
        ),
        "Upstream event · observed just now · resets in 1h"
    )

    let rendered = references.flatMap {
        [ReferenceQuotaPresentation.capText($0), ReferenceQuotaPresentation.observationText($0)]
    }.joined(separator: " ")
    runner.expect(!rendered.contains("%"), "reference data must not manufacture a percentage")

    let accordion = ProviderQuotaAccordionView()
    accordion.apply(makeSnapshot(quotas: quotas))
    runner.equal(accordion.providerRowCount, 1, "reference-only quota stays visible")
    runner.expect(accordion.expandedProviderIDs.contains("opencode-go"), "reference provider expands")
}

// MARK: - Deep links

runner.test("ui: provider deep-link encoding preserves safe ids") {
    runner.equal(DeepLinks.encodeProvider("openai"), "openai", "plain id")
    runner.equal(DeepLinks.encodeProvider("kimi-code"), "kimi-code", "hyphen id")
    runner.equal(
        DeepLinks.providerHash("openai", accountsSupported: true),
        "providers/openai/accounts",
        "accounts tab"
    )
    runner.equal(
        DeepLinks.providerHash("custom", accountsSupported: false),
        "providers/custom/overview",
        "overview fallback"
    )
    let url = DeepLinks.url(endpoint: .default, hash: "providers/openai/accounts")
    runner.equal(url.fragment, "providers/openai/accounts", "fragment")
    runner.expect(url.absoluteString.hasPrefix("http://127.0.0.1:"), "loopback")

    let dynamicKeyProvider = try! JSONDecoder().decode(
        ProviderSummary.self,
        from: Data("{\"name\":\"deepseek\",\"authMode\":\"key\",\"hasApiKey\":false}".utf8)
    )
    runner.expect(
        ResourceAssets.supportsAccountsTab("deepseek", summary: dynamicKeyProvider),
        "runtime key providers open their API Keys tab"
    )
}

// MARK: - Activity honesty

runner.test("ui: activity empty and unavailable states stay compact") {
    let controller = PopoverViewController()
    _ = controller.view

    let unloaded = makeSnapshot(activityLoaded: false)
    controller.apply(unloaded)
    runner.expect(controller.activityView.accessibilityLabel()?.contains("unavailable") == true
        || controller.activityView.accessibilityLabel()?.contains("Activity") == true,
        "unavailable label present")

    let empty = activitySnapshot(activities: "")
    controller.apply(makeSnapshot(activity: empty))
    // Should not crash and should keep preferred width.
    runner.equal(controller.preferredContentSize.width, 387, "width stable")
}

runner.test("ui: accessibility labels exist on header and accordion") {
    let controller = PopoverViewController()
    _ = controller.view
    let quotas = decodeQuotas("[\(quotaJSON(provider: "openai", label: "ChatGPT", fiveHour: 12))]")
    controller.apply(makeSnapshot(quotas: quotas))
    _ = runner.notNil(controller.headerView.accessibilityLabel(), "header a11y")
    _ = runner.notNil(controller.quotaAccordion.accessibilityLabel(), "quota a11y")
}

runner.test("ui: running footer invokes proxy and exit actions independently") {
    let controller = PopoverViewController()
    _ = controller.view
    controller.apply(makeSnapshot())
    var calls: [String] = []
    controller.onDashboard = { calls.append("dashboard") }
    controller.onLogs = { calls.append("logs") }
    controller.onRefresh = { calls.append("refresh") }
    controller.onStop = { calls.append("stop") }
    controller.onRestart = { calls.append("restart") }
    controller.onQuitMenuBar = { calls.append("quit-menu") }
    controller.onStopAndQuit = { calls.append("stop-and-quit") }
    for index in 0..<7 { controller.activateFooterForTesting(index) }
    runner.equal(
        calls,
        ["dashboard", "logs", "refresh", "stop", "restart", "quit-menu", "stop-and-quit"]
    )
}

runner.test("ui: stopped footer offers Start and safe Quit without destructive exit") {
    let controller = PopoverViewController()
    _ = controller.view
    controller.apply(ProxySnapshot(state: .unreachable, endpoint: .default))
    var started = false
    var restarted = false
    var quitMenuBar = false
    var stoppedAndQuit = false
    controller.onStart = { started = true }
    controller.onRestart = { restarted = true }
    controller.onQuitMenuBar = { quitMenuBar = true }
    controller.onStopAndQuit = { stoppedAndQuit = true }
    controller.activateFooterForTesting(3)
    controller.activateFooterForTesting(4)
    controller.activateFooterForTesting(5)
    controller.activateFooterForTesting(6)
    runner.equal(started, true)
    runner.equal(restarted, false)
    runner.equal(quitMenuBar, true)
    runner.equal(stoppedAndQuit, false)
}

runner.test("ui: degraded and unauthorized states offer Stop without enabling Restart") {
    for state in [ProxyState.degraded("Timed out"), .unauthorized] {
        let controller = PopoverViewController()
        _ = controller.view
        controller.apply(ProxySnapshot(state: state, endpoint: .default))
        var started = false
        var stopped = false
        var restarted = false
        controller.onStart = { started = true }
        controller.onStop = { stopped = true }
        controller.onRestart = { restarted = true }

        runner.equal(
            controller.footerTitles[3],
            "Stop Proxy…",
            "uncertain live state uses stop intent"
        )
        controller.activateFooterForTesting(3)
        controller.activateFooterForTesting(4)
        runner.equal(started, false, "does not start a possible duplicate")
        runner.equal(stopped, true, "stop remains actionable")
        runner.equal(restarted, false, "restart requires confirmed running identity")
    }
}

runner.test("ui: polling cannot re-enable lifecycle controls during an action") {
    let controller = PopoverViewController()
    _ = controller.view
    var stopped = false
    var restarted = false
    controller.onStop = { stopped = true }
    controller.onRestart = { restarted = true }
    controller.apply(makeSnapshot())
    controller.setLifecycleControlsEnabled(false)

    // A poll renders a fresh snapshot while the lifecycle helper is still running.
    controller.apply(makeSnapshot())
    controller.activateFooterForTesting(3)
    controller.activateFooterForTesting(4)
    runner.equal(stopped, false, "stop remains disabled")
    runner.equal(restarted, false, "restart remains disabled")

    controller.setLifecycleControlsEnabled(true)
    controller.activateFooterForTesting(3)
    runner.equal(stopped, true, "controls recover after the action completes")
}

runner.test("ui: exit actions expose clear labels, accessibility, and distinct shortcuts") {
    let controller = PopoverViewController()
    _ = controller.view
    controller.apply(makeSnapshot())

    let labels = controller.footerAccessibilityLabels
    runner.expect(
        labels[5]?.contains("leave the proxy running") == true,
        "safe quit explains proxy persistence"
    )
    runner.expect(
        labels[6]?.contains("Stop the OpenCodex proxy") == true,
        "destructive exit explains proxy stop"
    )

    let shortcuts = controller.footerKeyEquivalents
    runner.equal(shortcuts[5].0, "q", "safe quit key")
    runner.equal(shortcuts[5].1, [.command], "safe quit modifiers")
    runner.equal(shortcuts[6].0, "q", "destructive quit key")
    runner.equal(shortcuts[6].1, [.command, .option], "destructive quit modifiers")
    runner.equal(controller.footerEnabledStates[5], true, "safe quit enabled")
    runner.equal(controller.footerEnabledStates[6], true, "destructive exit enabled")
}

runner.test("ui: lifecycle confirmations default to Cancel and mark stop actions destructive") {
    let stop = LifecycleConfirmation.stopProxy.makeAlert()
    runner.equal(stop.messageText, "Stop the OpenCodex proxy?")
    runner.equal(
        stop.buttons.map(\.title),
        ["Stop Proxy", "Cancel"],
        "action-first add order renders Cancel on the leading edge"
    )
    runner.equal(stop.buttons[0].hasDestructiveAction, true)
    runner.equal(stop.buttons[1].hasDestructiveAction, false)
    let cancelCell = stop.buttons[1].cell as? NSButtonCell
    runner.expect(stop.window.defaultButtonCell === cancelCell, "Cancel is the default button")
    runner.expect(
        stop.window.initialFirstResponder === stop.buttons[1],
        "Cancel receives initial focus"
    )
    runner.equal(
        LifecycleConfirmation.stopProxy.confirmationResponse,
        .alertFirstButtonReturn
    )

    let restart = LifecycleConfirmation.restartProxy.makeAlert()
    runner.equal(restart.buttons.map(\.title), ["Restart Proxy", "Cancel"])
    runner.equal(restart.buttons[0].hasDestructiveAction, false)

    let stopAndQuit = LifecycleConfirmation.stopAndQuit.makeAlert()
    runner.equal(stopAndQuit.messageText, "Stop OpenCodex and quit?")
    runner.equal(stopAndQuit.buttons.map(\.title), ["Stop and Quit", "Cancel"])
    runner.equal(stopAndQuit.buttons[0].hasDestructiveAction, true)
    runner.expect(
        stopAndQuit.informativeText.contains("Codex will use native routing"),
        "confirmation explains post-stop routing"
    )
}

runner.test("ui: application menu keeps Command-Q safe and provides explicit destructive exit") {
    let target = ApplicationMenuTarget()
    let menu = ApplicationMenuFactory.make(
        target: target,
        quitAction: #selector(ApplicationMenuTarget.quitMenuBar(_:)),
        stopAndQuitAction: #selector(ApplicationMenuTarget.stopOpenCodexAndQuit(_:))
    )
    let items = menu.items.first?.submenu?.items.filter { !$0.isSeparatorItem } ?? []
    runner.equal(menu.items.map(\.title), ["OpenCodex", "Edit"])
    runner.equal(items.map(\.title), ["Stop OpenCodex and Quit…", "Quit Menu Bar"])
    runner.equal(items[0].keyEquivalent, "q")
    runner.equal(items[0].keyEquivalentModifierMask, [.command, .option])
    runner.equal(items[1].keyEquivalent, "q")
    runner.equal(items[1].keyEquivalentModifierMask, [.command])

    let editItems = menu.items[1].submenu?.items.filter { !$0.isSeparatorItem } ?? []
    runner.equal(editItems.map(\.title), ["Cut", "Copy", "Paste", "Select All"])
    runner.equal(editItems.map(\.keyEquivalent), ["x", "c", "v", "a"])
    runner.expect(editItems.allSatisfy { $0.target == nil }, "Edit commands use responder chain")
}

runner.test("ui: destructive menu availability follows proxy and in-flight state") {
    runner.equal(
        LifecycleActionAvailability.canStopAndQuit(
            state: .running(StartupHealth(status: "protected")),
            controlsAllowed: true
        ),
        true
    )
    runner.equal(
        LifecycleActionAvailability.canStopAndQuit(state: .unauthorized, controlsAllowed: true),
        true
    )
    runner.equal(
        LifecycleActionAvailability.canStopAndQuit(
            state: .degraded("Unconfirmed"),
            controlsAllowed: true
        ),
        true
    )
    runner.equal(
        LifecycleActionAvailability.canStopAndQuit(state: .unreachable, controlsAllowed: true),
        false
    )
    runner.equal(
        LifecycleActionAvailability.canStopAndQuit(state: .loading, controlsAllowed: true),
        false
    )
    runner.equal(
        LifecycleActionAvailability.canStopAndQuit(
            state: makeSnapshot().state,
            controlsAllowed: false
        ),
        false
    )
}

runner.test("ui: app menu starts with destructive exit disabled and safe quit enabled") {
    let delegate = AppDelegate()
    let menu = ApplicationMenuFactory.make(
        target: delegate,
        quitAction: NSSelectorFromString("quitMenuBar:"),
        stopAndQuitAction: NSSelectorFromString("stopOpenCodexAndQuit:")
    )
    let appMenu = menu.items[0].submenu
    appMenu?.update()
    let items = appMenu?.items.filter { !$0.isSeparatorItem } ?? []
    runner.equal(delegate.validateMenuItem(items[0]), false, "no confirmed live proxy")
    runner.equal(delegate.validateMenuItem(items[1]), true, "safe quit")
    runner.equal(items[0].isEnabled, false, "AppKit applies destructive validation")
    runner.equal(items[1].isEnabled, true, "AppKit keeps safe quit enabled")
}

runner.test("ui: stop-and-quit exits only after a confirmed stopped outcome") {
    runner.equal(StopAndQuitPolicy.shouldTerminate(after: .stopped), true)
    runner.equal(StopAndQuitPolicy.shouldTerminate(after: .running), false)
    runner.equal(
        StopAndQuitPolicy.shouldTerminate(after: .failed("still running")),
        false
    )
}

// MARK: - Resource honesty

runner.test("ui: provider icon loader returns real SVG-backed images for known providers") {
    _ = runner.notNil(ResourceAssets.providerIcon(for: "openai"), "openai icon")
    _ = runner.notNil(ResourceAssets.providerIcon(for: "kimi"), "kimi icon")
    _ = runner.notNil(ResourceAssets.providerIcon(for: "xai"), "grok icon")
    runner.isNil(ResourceAssets.providerIcon(for: "definitely-not-a-provider"), "unknown stays nil")
}

exit(runner.summarize())
