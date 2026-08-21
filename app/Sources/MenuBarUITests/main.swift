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
    @objc func stopCodexCommanderAndQuit(_ sender: Any?) {}
}

final class RecordingLifecycleRunner: @unchecked Sendable, LifecycleCommandRunning {
    private let queue = DispatchQueue(label: "menu-bar-ui-tests.lifecycle-recorder")
    private var actions: [LifecycleAction] = []

    func run(_ action: LifecycleAction) async throws -> LifecycleCommandResult {
        queue.sync { actions.append(action) }
        return LifecycleCommandResult(
            action: action,
            ok: true,
            state: .running,
            changed: true,
            pid: 41,
            port: 10100,
            message: "running"
        )
    }

    var recordedActions: [LifecycleAction] {
        queue.sync { actions }
    }
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
    let quota = "{\"updatedAt\":1\(parts.isEmpty ? "" : "," + parts.joined(separator: ","))}"
    return "{\"provider\":\"\(provider)\",\"label\":\"\(label)\",\"source\":\"test\",\"quota\":\(quota),\"updatedAt\":1}"
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

func currentHealth(
    status: String = "protected",
    protection: String = "none",
    routingKind: String = "codexcommander-local",
    routingInjected: Bool = true,
    serviceInstalled: Bool = false,
    serviceEnabled: Bool = false,
    diagnosticStale: Bool = false,
    recommendedCommand: String? = nil
) -> StartupHealth {
    StartupHealth(
        status: status,
        protection: protection,
        platform: "darwin",
        routingKind: routingKind,
        routingInjected: routingInjected,
        localRoutingDependency: routingKind != "native" && routingKind != "custom-remote",
        autostartEnabled: serviceEnabled,
        serviceRunning: serviceEnabled,
        serviceInstalled: serviceInstalled,
        serviceViable: serviceEnabled,
        serviceEnabled: serviceEnabled,
        serviceStale: false,
        serviceConflict: false,
        serviceSupported: true,
        shimInstalled: false,
        shimHealthy: false,
        shimCoverage: "none",
        rebootSafe: serviceEnabled,
        diagnosticStale: diagnosticStale,
        recommendedCommand: recommendedCommand,
        commands: .init(
            installService: "ccx service install",
            repairService: "ccx service repair",
            installShim: "ccx codex-shim install",
            restoreNative: "ccx restore"
        )
    )
}

func activitySnapshot(
    activities: String,
    activeTurnCount: Int = 2,
    unattributed: Int = 0,
    truncated: Bool = false
) -> AgentActivitySnapshot {
    let json = """
    {
      "schemaVersion": 1,
      "generatedAt": 1,
      "proxyState": "running",
      "activeTurnCount": \(activeTurnCount),
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
    health: StartupHealth = currentHealth(),
    readiness: ProxyReadinessState = .unknown,
    recommendedCommand: String? = nil,
    providersLoaded: Bool = false,
    quotasLoaded: Bool = true,
    activityLoaded: Bool = true
) -> ProxySnapshot {
    ProxySnapshot(
        state: .running(health),
        readiness: readiness,
        endpoint: .default,
        quotas: quotas,
        quotaAvailability: quotaAvailability,
        activity: activity,
        providers: providers,
        lastUpdated: Date(),
        recommendedCommand: recommendedCommand,
        providersLoaded: providersLoaded,
        quotasLoaded: quotasLoaded,
        activityLoaded: activityLoaded
    )
}

func textFields(in view: NSView) -> [NSTextField] {
    let own = (view as? NSTextField).map { [$0] } ?? []
    return own + view.subviews.flatMap(textFields(in:))
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

runner.test("ui: running proxy keeps the terminal glyph regardless of service protection") {
    runner.equal(
        StatusIcon.symbolName(for: .running(currentHealth())),
        "terminal.fill",
        "protected running keeps the terminal glyph"
    )
    runner.equal(
        StatusIcon.symbolName(for: .running(currentHealth(status: "at-risk"))),
        "terminal.fill",
        "unprotected running must not degrade to a warning triangle"
    )
    runner.equal(
        StatusIcon.symbolName(for: .degraded("Unavailable")),
        "exclamationmark.triangle",
        "the warning triangle is reserved for an actually degraded state"
    )

    let states: [ProxyState] = [
        .loading,
        .running(currentHealth()),
        .unreachable,
        .unauthorized,
        .degraded("Unavailable"),
    ]
    let symbols = states.map(StatusIcon.symbolName(for:))
    runner.equal(Set(symbols).count, states.count, "every other operational state stays distinct")
}

runner.test("ui: footer exposes navigation, lifecycle, Codex routing, and both exits") {
    let controller = PopoverViewController()
    _ = controller.view
    let titles = controller.footerTitles
    runner.equal(
        titles,
        [
            "Dashboard", "Logs", "Refresh", "Start Proxy", "Restart Proxy…",
            "Restore Native Codex", "Route Codex Through Proxy",
            "Quit Menu Bar", "Stop CodexCommander and Quit…",
        ],
        "footer titles"
    )
}

runner.test("ui: catalog update presents manual ChatGPT restart outside the proxy footer") {
    let controller = PopoverViewController()
    _ = controller.view
    controller.apply(makeSnapshot())
    runner.equal(controller.catalogUpdateVisible, false, "hidden until stale workers are known")

    var applied = false
    controller.onApplyCodexCatalog = { applied = true }
    controller.showCatalogUpdate(staleWorkerCount: 2)
    runner.equal(controller.catalogUpdateVisible, true)
    runner.equal(controller.catalogUpdateButtonTitle, "Show restart steps…")
    runner.expect(
        controller.catalogUpdateDetail.contains("2 Codex background workers"),
        "card reports a count without exposing process identifiers"
    )
    runner.expect(
        controller.catalogUpdateDetail.contains("CodexCommander remains running"),
        "card distinguishes the catalog action from a proxy restart"
    )
    runner.expect(
        controller.catalogUpdateDetail.contains("Quit and reopen ChatGPT"),
        "card makes the reliable manual reload boundary primary"
    )
    runner.expect(
        controller.catalogUpdateAccessibilityLabel?.contains("ChatGPT restart required") == true,
        "catalog card has an accessible state label"
    )
    runner.expect(
        controller.catalogUpdateButtonAccessibilityLabel?.contains("check the saved agent catalog status") == true,
        "catalog action explains the manual restart and revalidation boundary"
    )
    controller.apply(makeSnapshot())
    runner.equal(
        controller.catalogUpdateVisible,
        true,
        "ordinary snapshot rendering preserves catalog readiness"
    )
    controller.activateCatalogUpdateForTesting()
    runner.equal(applied, true)

    controller.setCatalogApplyEnabled(false)
    runner.equal(controller.catalogUpdateButtonEnabled, false)
    controller.hideCatalogUpdate()
    runner.equal(controller.catalogUpdateVisible, false)
    runner.equal(controller.footerTitles.count, 9, "catalog action stays outside footer indexing")
}

runner.test("ui: startup control exposes desktop, headless, off, and approval states") {
    let controller = PopoverViewController()
    _ = controller.view

    controller.applyLaunchAtLogin(
        LaunchAtLoginPresentation(
            status: .enabled,
            desiredEnabled: true,
            isToggleEnabled: true
        )
    )
    controller.apply(makeSnapshot(health: currentHealth(
        protection: "service", serviceInstalled: true, serviceEnabled: true
    )))
    runner.equal(
        controller.startupModeView.modeText,
        "Desktop · Quit Menu Bar leaves proxy running"
    )
    runner.equal(controller.startupModeView.isLaunchAtLoginOn, true)

    controller.applyLaunchAtLogin(
        LaunchAtLoginPresentation(
            status: .disabled,
            desiredEnabled: false,
            isToggleEnabled: true
        )
    )
    runner.equal(
        controller.startupModeView.modeText,
        "Headless · proxy runs without the menu bar"
    )

    controller.apply(makeSnapshot(health: currentHealth(status: "at-risk")))
    runner.equal(
        controller.startupModeView.modeText,
        "Off · start CodexCommander manually"
    )

    controller.applyLaunchAtLogin(
        LaunchAtLoginPresentation(
            status: .requiresApproval,
            desiredEnabled: true,
            isToggleEnabled: false
        )
    )
    runner.equal(controller.startupModeView.isLaunchAtLoginToggleEnabled, false)
    runner.expect(
        controller.startupModeView.showsRemediationButton,
        "approval state should expose Login Items settings"
    )
}

runner.test("ui: startup switch uses AppKit target-action for a missing registration") {
    let controller = PopoverViewController()
    _ = controller.view
    var requested: Bool?
    controller.onLaunchAtLoginChange = { requested = $0 }
    controller.applyLaunchAtLogin(
        LaunchAtLoginPresentation(
            status: .notFound,
            desiredEnabled: false,
            isToggleEnabled: true
        )
    )

    runner.equal(controller.startupModeView.isLaunchAtLoginToggleEnabled, true)
    controller.startupModeView.activateLaunchAtLoginToggleForTesting()
    runner.equal(requested, true)
}

runner.test("ui: unavailable startup switch ignores AppKit clicks") {
    let controller = PopoverViewController()
    _ = controller.view
    var requested: Bool?
    controller.onLaunchAtLoginChange = { requested = $0 }
    controller.applyLaunchAtLogin(
        LaunchAtLoginPresentation(
            status: .unavailable,
            desiredEnabled: false,
            isToggleEnabled: false
        )
    )

    runner.equal(controller.startupModeView.isLaunchAtLoginToggleEnabled, false)
    controller.startupModeView.activateLaunchAtLoginToggleForTesting()
    runner.isNil(requested, "a disabled NSSwitch must not dispatch its action")
}

runner.test("ui: relocation guidance is neutral and opens Applications on explicit action") {
    let controller = PopoverViewController()
    _ = controller.view
    var remediation: LaunchAtLoginRemediation?
    controller.onLaunchAtLoginRemediation = { remediation = $0 }

    controller.applyLaunchAtLogin(
        LaunchAtLoginPresentation(
            status: .unavailable,
            desiredEnabled: true,
            isToggleEnabled: false,
            errorMessage: "comparison error"
        )
    )
    let errorColor = controller.startupModeView.modeTextColor

    controller.applyLaunchAtLogin(
        LaunchAtLoginPresentation(
            status: .unavailable,
            desiredEnabled: true,
            isToggleEnabled: false,
            relocationRequired: true
        )
    )

    runner.equal(
        controller.startupModeView.modeText,
        "Move CodexCommander to Applications to launch at login."
    )
    runner.expect(
        controller.startupModeView.modeTextColor != errorColor,
        "relocation detail must use the neutral faint tone, not the error tone"
    )
    runner.equal(controller.startupModeView.remediationButtonTitle, "Open Applications")
    runner.equal(
        controller.startupModeView.remediationButtonAccessibilityLabel,
        "Open Applications folder"
    )
    runner.equal(
        controller.startupModeView.remediationButtonToolTip,
        "Quit CodexCommander before moving the app, then reopen it from Applications."
    )
    controller.startupModeView.activateRemediationForTesting()
    runner.equal(remediation, .openApplications)
}

runner.test("ui: approval disables startup switch and forwards System Settings remediation") {
    let controller = PopoverViewController()
    _ = controller.view
    var remediation: LaunchAtLoginRemediation?
    controller.onLaunchAtLoginRemediation = { remediation = $0 }
    controller.applyLaunchAtLogin(
        LaunchAtLoginPresentation(
            status: .requiresApproval,
            desiredEnabled: true,
            isToggleEnabled: false
        )
    )

    runner.equal(controller.startupModeView.isLaunchAtLoginToggleEnabled, false)
    runner.equal(controller.startupModeView.showsRemediationButton, true)
    runner.equal(controller.startupModeView.remediationButtonTitle, "Open Settings")
    runner.equal(
        controller.startupModeView.remediationButtonAccessibilityLabel,
        "Open Login Items settings"
    )
    controller.startupModeView.activateRemediationForTesting()
    runner.equal(remediation, .openSystemSettings)
}

runner.test("ui: running snapshot with recommended guidance offers Startup options, not a raw command") {
    let controller = PopoverViewController()
    _ = controller.view

    controller.apply(makeSnapshot())
    runner.equal(controller.startupOptionsVisible, false, "no guidance without a recommendation")
    runner.isNil(controller.commandText, "no raw command when healthy")

    var opened = false
    controller.onOpenStartupOptions = { opened = true }
    controller.apply(makeSnapshot(recommendedCommand: "ccx service install"))
    runner.equal(controller.startupOptionsVisible, true, "recommendation surfaces an actionable control")
    runner.equal(controller.startupOptionsTitle, "Startup options…")
    runner.equal(controller.commandText, nil, "raw remediation command is not the primary UI")
    runner.expect(
        controller.guidanceText?.isEmpty == false,
        "guidance names the recommendation without printing the command"
    )
    runner.expect(
        controller.startupOptionsAccessibilityLabel?.contains("startup options") == true,
        "control names its dashboard destination"
    )
    controller.activateStartupOptionsForTesting()
    runner.equal(opened, true, "control invokes the startup handoff")

    controller.apply(makeSnapshot())
    runner.equal(controller.startupOptionsVisible, false, "control clears once guidance clears")
}

runner.test("ui: stopped proxy keeps the raw start command as guidance") {
    let controller = PopoverViewController()
    _ = controller.view
    var stopped = ProxySnapshot(state: .unreachable, endpoint: .default)
    stopped.lastKnownStartCommand = "ccx service start"
    controller.apply(stopped)
    runner.equal(controller.guidanceText, "Start it again with:")
    runner.equal(controller.commandText, "ccx service start", "raw command survives for the stopped case")
    runner.equal(controller.startupOptionsVisible, false, "startup options are not shown while stopped")
}

runner.test("ui: startup options handoff targets the dashboard startup page") {
    let delegate = AppDelegate()
    let url = delegate.startupOptionsURL()
    runner.equal(url.fragment, "startup", "dashboard hash")
    runner.expect(url.absoluteString.hasPrefix("http://127.0.0.1:"), "loopback")
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
      {"name":"openai","adapter":"openai-responses","authMode":"forward","hasApiKey":false,"disabled":false,"quotaCapable":true},
      {"name":"kimi","adapter":"kimi","authMode":"oauth","hasApiKey":false,"disabled":false,"quotaCapable":true},
      {"name":"xai","adapter":"openai-chat","authMode":"oauth","hasApiKey":false,"disabled":false,"quotaCapable":true}
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
    [{"name":"xai","adapter":"openai-chat","authMode":"oauth","hasApiKey":false,"disabled":false,"quotaCapable":true}]
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
      {"name":"xai","adapter":"openai-chat","authMode":"oauth","hasApiKey":false,"disabled":false,"quotaCapable":true},
      {"name":"anthropic","adapter":"anthropic","authMode":"oauth","hasApiKey":false,"disabled":true,"quotaCapable":true},
      {"name":"deepseek","adapter":"openai-chat","authMode":"key","hasApiKey":false,"disabled":false,"quotaCapable":false}
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

runner.test("ui: overflowing provider content fits the scroll viewport") {
    let quotas = decodeQuotas("""
    [
      \(quotaJSON(provider: "openai", label: "ChatGPT", fiveHour: 38, weekly: 22)),
      \(quotaJSON(provider: "kimi", label: "Kimi", fiveHour: 62, weekly: 38)),
      \(quotaJSON(provider: "xai", label: "Grok", monthly: 41))
    ]
    """)
    let controller = PopoverViewController()
    let window = NSWindow(
        contentRect: NSRect(x: 0, y: 0, width: 387, height: 468),
        styleMask: .borderless,
        backing: .buffered,
        defer: false
    )
    window.contentViewController = controller
    window.orderFront(nil)
    controller.apply(makeSnapshot(quotas: quotas))
    controller.showCodexRouteSaved(.codexCommander)
    controller.view.layoutSubtreeIfNeeded()

    runner.expect(controller.hasVerticalScroller, "fixture should overflow vertically")
    let expectedBodyWidth = controller.scrollContainerWidth - 18
    runner.expect(
        controller.scrollingBodyWidth <= expectedBodyWidth + 0.5,
        "document width \(controller.scrollingBodyWidth) must preserve 18-point scroller clearance from \(controller.scrollContainerWidth)"
    )
}

runner.test("ui: OpenCode Go renders published caps and honest local observation semantics") {
    let quotas = decodeQuotas("""
    [{"provider":"opencode-go","label":"OpenCode Go","source":"test","updatedAt":1,"quota":{"updatedAt":1,
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
        from: Data("{\"name\":\"deepseek\",\"adapter\":\"openai-chat\",\"authMode\":\"key\",\"hasApiKey\":false,\"disabled\":false,\"quotaCapable\":false}".utf8)
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
    runner.equal(controller.activityView.headingText, "Live proxy requests", "request heading")
    runner.equal(controller.activityView.emptyText, "Request activity unavailable", "unavailable copy")
    runner.expect(controller.activityView.accessibilityLabel()?.contains("unavailable") == true
        || controller.activityView.accessibilityLabel()?.contains("Activity") == true,
        "unavailable label present")

    let empty = activitySnapshot(activities: "", activeTurnCount: 0)
    controller.apply(makeSnapshot(activity: empty))
    runner.equal(controller.activityView.emptyText, "No requests in flight", "empty request copy")
    // Should not crash and should keep preferred width.
    runner.equal(controller.preferredContentSize.width, 387, "width stable")
}

runner.test("ui: header separates proxy requests from the Codex route") {
    let controller = PopoverViewController()
    _ = controller.view
    let activity = activitySnapshot(activities: "", activeTurnCount: 2)

    controller.apply(makeSnapshot(activity: activity))
    runner.equal(controller.headerView.statusText, "Proxy running", "proxy status")
    runner.equal(controller.headerView.requestCountText, "2 in flight", "request count")
    runner.equal(controller.headerView.readinessText, "Readiness · Checking", "initial readiness")
    runner.equal(
        controller.headerView.codexRouteText,
        "Codex route · CodexCommander",
        "managed Codex route"
    )

    controller.apply(makeSnapshot(
        activity: activity,
        health: currentHealth(
            status: "native",
            routingKind: "native",
            routingInjected: false
        )
    ))
    runner.equal(controller.headerView.codexRouteText, "Codex route · Native OpenAI", "native route")
    runner.expect(
        controller.headerView.accessibilityLabel()?.contains("2 requests in flight") == true,
        "request count is explicit to assistive technology"
    )

    controller.apply(makeSnapshot(
        activity: activity,
        health: currentHealth(diagnosticStale: true)
    ))
    runner.equal(controller.headerView.codexRouteText, "Codex route · Unknown", "stale route fails closed")
}

runner.test("ui: fresh route truth overrides stale startup diagnostics immediately") {
    let controller = PopoverViewController()
    _ = controller.view
    var snapshot = makeSnapshot(health: currentHealth(diagnosticStale: true))
    snapshot.codexRoute = .confirmed(CodexRouteStatus(routingKind: .native))
    controller.apply(snapshot)

    runner.equal(
        controller.headerView.codexRouteText,
        "Codex route · Native OpenAI",
        "focused route observation"
    )
    runner.equal(controller.footerEnabledStates[5], false, "native action follows fresh route")
    runner.equal(controller.footerEnabledStates[6], true, "proxy action follows fresh route")
}

runner.test("ui: unconfirmed route truth is explicit and leaves both choices available") {
    let controller = PopoverViewController()
    _ = controller.view
    var snapshot = makeSnapshot()
    snapshot.codexRoute = .confirmationUnavailable
    controller.apply(snapshot)

    runner.equal(controller.headerView.codexRouteText, "Codex route · Unconfirmed")
    runner.equal(controller.footerEnabledStates[5], true, "native recovery remains available")
    runner.equal(controller.footerEnabledStates[6], true, "proxy recovery remains available")
}

runner.test("ui: backend-confirmed unknown stays distinct from unavailable confirmation") {
    let controller = PopoverViewController()
    _ = controller.view
    var snapshot = makeSnapshot()
    snapshot.codexRoute = .confirmed(CodexRouteStatus(routingKind: .unknown))
    controller.apply(snapshot)

    runner.equal(controller.headerView.codexRouteText, "Codex route · Unknown")
    runner.equal(controller.footerEnabledStates[5], true)
    runner.equal(controller.footerEnabledStates[6], true)
}

runner.test("ui: route progress shows honest phases, elapsed time, and stays visible") {
    let controller = PopoverViewController()
    _ = controller.view
    controller.apply(makeSnapshot())

    controller.beginCodexRouteChange(to: .nativeOpenAI)
    let status = controller.operationStatusView
    runner.equal(status.isProgressVisible, true, "spinner visible")
    runner.equal(status.isDismissVisible, false, "progress cannot be dismissed")
    runner.equal(status.titleText, "Changing to the Native OpenAI route…")
    runner.equal(status.elapsedText, "0s")
    runner.expect(
        status.accessibilityStatusValue?.contains("Changing to the Native OpenAI route") == true,
        "accessible value names current phase"
    )

    status.advanceElapsedForTesting(by: 65)
    runner.equal(status.elapsedText, "1:05", "elapsed time")
    controller.updateCodexRoutePhase(.confirming)
    runner.equal(status.titleText, "Confirming the saved Codex route…")
    runner.equal(status.isProgressVisible, true, "ordinary updates do not hide progress")
}

runner.test("ui: saved route with unavailable confirmation stays a caution, not success") {
    let controller = PopoverViewController()
    _ = controller.view
    controller.beginCodexRouteChange(to: .nativeOpenAI)
    controller.updateCodexRoutePhase(.confirming)
    controller.showCodexRouteConfirmationPending()

    let status = controller.operationStatusView
    runner.equal(status.titleText, "Route was saved, but confirmation is unavailable")
    runner.equal(
        status.detailText,
        "Refresh to confirm the Codex route shown above before reopening ChatGPT."
    )
    runner.equal(status.stateToneName, "warning", "confirmation caution uses warning tone")
    runner.expect(
        status.detailText?.contains("start a new task") == false,
        "unconfirmed route must not show the success reload instruction"
    )
    runner.equal(status.isDismissVisible, true, "caution persists")
}

runner.test("ui: first-run guidance warns without disabling proxy route recovery") {
    let controller = PopoverViewController()
    _ = controller.view
    let snapshot = makeSnapshot(health: currentHealth(
        routingKind: "native",
        routingInjected: false
    ))
    controller.apply(snapshot)

    controller.showSetupRequired(.codexFirstRun)

    runner.equal(controller.operationStatusTitle, "Open Codex to finish setup")
    runner.equal(
        controller.operationStatusDetail,
        "CodexCommander is running. Open Codex once, then choose Route Codex Through Proxy."
    )
    runner.equal(controller.operationStatusTone, .warning)
    runner.expect(controller.routeThroughProxyEnabled, "route retry remains available")
    runner.equal(
        controller.operationStatusView.accessibilityLabel(),
        "Open Codex to finish setup",
        "setup warning has a concise accessible label"
    )
    runner.equal(
        controller.operationStatusView.accessibilityStatusValue,
        "Open Codex to finish setup. CodexCommander is running. Open Codex once, then choose Route Codex Through Proxy.",
        "setup warning exposes the complete recovery instruction"
    )
}

runner.test("ui: route success persists with explicit ChatGPT restart step until dismissed") {
    let controller = PopoverViewController()
    _ = controller.view
    controller.apply(makeSnapshot())
    controller.beginCodexRouteChange(to: .codexCommander)
    controller.showCodexRouteSaved(.codexCommander)

    let status = controller.operationStatusView
    runner.equal(status.isProgressVisible, false, "spinner stops")
    runner.equal(status.isDismissVisible, true, "dismiss action visible")
    runner.equal(status.titleText, "CodexCommander route saved")
    runner.equal(
        status.detailText,
        "Quit ChatGPT completely, reopen it, then start a new task to use this route.",
        "restart boundary"
    )

    // Rendering fresh health must not discard the user's terminal outcome.
    controller.apply(makeSnapshot())
    runner.equal(status.titleText, "CodexCommander route saved", "result persists through polling")
    status.activateDismissForTesting()
    runner.equal(status.isHidden, true, "explicit dismissal")
}

runner.test("ui: operation card reclaims hidden stack space after dismissal") {
    let controller = PopoverViewController()
    let window = NSWindow(
        contentRect: NSRect(x: 0, y: 0, width: 387, height: 468),
        styleMask: .borderless,
        backing: .buffered,
        defer: false
    )
    window.contentViewController = controller
    controller.apply(makeSnapshot())
    controller.view.layoutSubtreeIfNeeded()
    let originalPanelSize = controller.preferredContentSize

    controller.showCodexRouteSaved(.nativeOpenAI)
    controller.view.layoutSubtreeIfNeeded()
    runner.equal(controller.operationStatusView.isHidden, false, "card enters fixed stack")
    runner.equal(controller.preferredContentSize.width, originalPanelSize.width, "width remains stable")

    controller.operationStatusView.activateDismissForTesting()
    controller.view.layoutSubtreeIfNeeded()
    runner.equal(controller.operationStatusView.isHidden, true, "hidden card leaves fixed stack")
    runner.equal(controller.preferredContentSize, originalPanelSize, "baseline panel geometry restored")
    runner.expect(
        window.firstResponder === window.contentView,
        "dismiss returns focus to a safe panel container"
    )
}

runner.test("ui: routing recovery failure is humanized with secondary technical detail") {
    let controller = PopoverViewController()
    _ = controller.view
    controller.showCodexRouteFailure(
        "Codex routing recovery could not prove and retire the existing journal.",
        errorCode: "ROUTING_RECOVERY_REQUIRED"
    )

    let status = controller.operationStatusView
    runner.equal(status.titleText, "Codex route was not changed")
    runner.expect(
        status.detailText?.contains("previous recovery checkpoint") == true,
        "plain-language recovery explanation"
    )
    runner.expect(
        status.detailText?.contains("left unchanged") == true,
        "failure states safe outcome"
    )
    runner.expect(
        status.technicalDetailText?.contains("existing journal") == true,
        "raw diagnostic remains secondary"
    )
    runner.equal(status.isDismissVisible, true, "error persists until dismissed")
}

runner.test("ui: current Codex route disables only the redundant route action") {
    let controller = PopoverViewController()
    _ = controller.view

    controller.apply(makeSnapshot(health: currentHealth(
        status: "native",
        routingKind: "native",
        routingInjected: false
    )))
    runner.equal(controller.footerEnabledStates[5], false, "already-native restore disabled")
    runner.equal(controller.footerEnabledStates[6], true, "proxy route enabled")

    controller.apply(makeSnapshot())
    runner.equal(controller.footerEnabledStates[5], true, "native restore enabled")
    runner.equal(controller.footerEnabledStates[6], false, "already-proxied action disabled")

    controller.apply(makeSnapshot(health: currentHealth(
        routingKind: "custom-remote",
        routingInjected: false
    )))
    runner.equal(controller.footerEnabledStates[5], true, "custom route can restore native")
    runner.equal(controller.footerEnabledStates[6], true, "custom route can switch to proxy")

    controller.setLifecycleControlsEnabled(false)
    runner.equal(controller.footerEnabledStates[5], false, "native action disabled in flight")
    runner.equal(controller.footerEnabledStates[6], false, "proxy action disabled in flight")
}

runner.test("ui: header keeps readiness separate from liveness and routing") {
    let controller = PopoverViewController()
    _ = controller.view
    let states: [(ProxyReadinessState, String)] = [
        (.unknown, "Checking"),
        (.pending, "Starting"),
        (.ready, "Ready"),
        (.failed, "Startup failed"),
        (.unavailable, "Unavailable"),
    ]

    for (state, label) in states {
        controller.apply(makeSnapshot(readiness: state))
        runner.equal(controller.headerView.statusText, "Proxy running", "liveness stays running for \(label)")
        runner.equal(controller.headerView.readinessText, "Readiness · \(label)", "readiness \(label)")
        runner.equal(
            controller.headerView.codexRouteText,
            "Codex route · CodexCommander",
            "route stays independent for \(label)"
        )
    }
    runner.expect(
        controller.headerView.accessibilityLabel()?.contains("Readiness · Unavailable") == true,
        "readiness is explicit to assistive technology"
    )
}

runner.test("ui: activity rows render once and elapsed timers clear the scrollbar") {
    let now = Int64(Date().timeIntervalSince1970 * 1_000)
    let activity = activitySnapshot(
        activities: """
        {"id":"child-1","role":"subagent","provider":"kimi","model":"k3[1m]",
         "phase":"running","startedAt":\(now)}
        """,
        unattributed: 1
    )
    let controller = PopoverViewController()
    let window = NSWindow(
        contentRect: NSRect(x: 0, y: 0, width: 387, height: 468),
        styleMask: .borderless,
        backing: .buffered,
        defer: false
    )
    window.contentViewController = controller
    window.orderFront(nil)
    controller.apply(makeSnapshot(activity: activity))
    controller.view.layoutSubtreeIfNeeded()

    let fields = textFields(in: controller.activityView)
    runner.expect(fields.contains { $0.stringValue == "Subagent turn" }, "child row is a turn, not a durable agent")
    runner.expect(
        fields.allSatisfy { !$0.stringValue.localizedCaseInsensitiveContains("unattributed") },
        "already-rendered subagents should not be counted again in a footer"
    )

    let elapsed = runner.notNil(
        fields.first { $0.alignment == .right },
        "elapsed timer"
    )
    if let elapsed, let container = elapsed.superview {
        let frame = container.convert(elapsed.frame, to: controller.activityView)
        let clearance = controller.activityView.bounds.maxX - frame.maxX
        runner.expect(
            clearance >= 15,
            "elapsed timer should clear the overlay scrollbar (clearance: \(clearance))"
        )
    }
}

runner.test("ui: accessibility labels exist on header and accordion") {
    let controller = PopoverViewController()
    _ = controller.view
    let quotas = decodeQuotas("[\(quotaJSON(provider: "openai", label: "ChatGPT", fiveHour: 12))]")
    controller.apply(makeSnapshot(quotas: quotas))
    _ = runner.notNil(controller.headerView.accessibilityLabel(), "header a11y")
    _ = runner.notNil(controller.quotaAccordion.accessibilityLabel(), "quota a11y")
}

runner.test("ui: running footer invokes proxy, Codex route, and exit actions independently") {
    let controller = PopoverViewController()
    _ = controller.view
    controller.apply(makeSnapshot(health: currentHealth(
        routingKind: "custom-remote",
        routingInjected: false
    )))
    var calls: [String] = []
    controller.onDashboard = { calls.append("dashboard") }
    controller.onLogs = { calls.append("logs") }
    controller.onRefresh = { calls.append("refresh") }
    controller.onStop = { calls.append("stop") }
    controller.onRestart = { calls.append("restart") }
    controller.onRestoreNativeCodex = { calls.append("restore-native") }
    controller.onRouteCodexThroughProxy = { calls.append("restore-back") }
    controller.onQuitMenuBar = { calls.append("quit-menu") }
    controller.onStopAndQuit = { calls.append("stop-and-quit") }
    for index in 0..<9 { controller.activateFooterForTesting(index) }
    runner.equal(
        calls,
        [
            "dashboard", "logs", "refresh", "stop", "restart",
            "restore-native", "restore-back", "quit-menu", "stop-and-quit",
        ]
    )
}

runner.test("ui: stopped footer offers Start and safe Quit without destructive exit") {
    let controller = PopoverViewController()
    _ = controller.view
    controller.apply(ProxySnapshot(state: .unreachable, endpoint: .default))
    var started = false
    var restarted = false
    var restoredNative = false
    var routedThroughProxy = false
    var quitMenuBar = false
    var stoppedAndQuit = false
    controller.onStart = { started = true }
    controller.onRestart = { restarted = true }
    controller.onRestoreNativeCodex = { restoredNative = true }
    controller.onRouteCodexThroughProxy = { routedThroughProxy = true }
    controller.onQuitMenuBar = { quitMenuBar = true }
    controller.onStopAndQuit = { stoppedAndQuit = true }
    controller.activateFooterForTesting(3)
    controller.activateFooterForTesting(4)
    controller.activateFooterForTesting(5)
    controller.activateFooterForTesting(6)
    controller.activateFooterForTesting(7)
    controller.activateFooterForTesting(8)
    runner.equal(started, true)
    runner.equal(restarted, false)
    runner.equal(restoredNative, true)
    runner.equal(routedThroughProxy, false)
    runner.equal(quitMenuBar, true)
    runner.equal(stoppedAndQuit, false)
}

runner.test("ui: stopped proxy keeps native escape available but blocks proxy routing") {
    let controller = PopoverViewController()
    _ = controller.view
    controller.apply(ProxySnapshot(state: .unreachable, endpoint: .default))

    runner.equal(controller.footerEnabledStates[5], true, "native escape remains available")
    runner.equal(
        controller.footerEnabledStates[6],
        false,
        "proxy route requires an attested running proxy"
    )
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
    var restoredNative = false
    var routedThroughProxy = false
    controller.onStop = { stopped = true }
    controller.onRestart = { restarted = true }
    controller.onRestoreNativeCodex = { restoredNative = true }
    controller.onRouteCodexThroughProxy = { routedThroughProxy = true }
    controller.apply(makeSnapshot())
    controller.setLifecycleControlsEnabled(false)

    // A poll renders a fresh snapshot while the lifecycle helper is still running.
    controller.apply(makeSnapshot())
    controller.activateFooterForTesting(3)
    controller.activateFooterForTesting(4)
    controller.activateFooterForTesting(5)
    controller.activateFooterForTesting(6)
    runner.equal(stopped, false, "stop remains disabled")
    runner.equal(restarted, false, "restart remains disabled")
    runner.equal(restoredNative, false, "native restore remains disabled")
    runner.equal(routedThroughProxy, false, "proxy routing remains disabled")

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
        labels[5]?.contains("native OpenAI route") == true,
        "native restore names its destination"
    )
    runner.expect(
        labels[6]?.contains("CodexCommander proxy") == true,
        "proxy route names its destination"
    )
    runner.expect(
        labels[7]?.contains("leave the proxy running") == true,
        "safe quit explains proxy persistence"
    )
    runner.expect(
        labels[8]?.contains("Stop the CodexCommander proxy") == true,
        "destructive exit explains proxy stop"
    )

    let shortcuts = controller.footerKeyEquivalents
    runner.equal(shortcuts[7].0, "q", "safe quit key")
    runner.equal(shortcuts[7].1, [.command], "safe quit modifiers")
    runner.equal(shortcuts[8].0, "q", "destructive quit key")
    runner.equal(shortcuts[8].1, [.command, .option], "destructive quit modifiers")
    runner.equal(controller.footerEnabledStates[7], true, "safe quit enabled")
    runner.equal(controller.footerEnabledStates[8], true, "destructive exit enabled")
}

runner.test("ui: lifecycle confirmations default to Cancel and mark stop actions destructive") {
    let stop = LifecycleConfirmation.stopProxy.makeAlert()
    runner.equal(stop.messageText, "Stop the CodexCommander proxy?")
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
    runner.expect(
        stop.informativeText.contains("Fully quit ChatGPT and Codex before stopping"),
        "stop confirmation tells the user to quit endpoint-caching clients first"
    )
    runner.expect(
        stop.informativeText.contains("Reopen them afterward to use native routing"),
        "stop confirmation explains how to resume on native routing"
    )

    let restart = LifecycleConfirmation.restartProxy.makeAlert()
    runner.equal(restart.buttons.map(\.title), ["Restart Proxy", "Cancel"])
    runner.equal(restart.buttons[0].hasDestructiveAction, false)

    let stopAndQuit = LifecycleConfirmation.stopAndQuit.makeAlert()
    runner.equal(stopAndQuit.messageText, "Stop CodexCommander and quit?")
    runner.equal(stopAndQuit.buttons.map(\.title), ["Stop and Quit", "Cancel"])
    runner.equal(stopAndQuit.buttons[0].hasDestructiveAction, true)
    runner.expect(
        stopAndQuit.informativeText.contains("Fully quit ChatGPT and Codex before stopping"),
        "stop-and-quit confirmation tells the user to quit clients first"
    )
    runner.expect(
        stopAndQuit.informativeText.contains("Reopen them afterward to use native routing"),
        "stop-and-quit confirmation explains post-stop routing"
    )
    runner.equal(
        LifecycleResultMessage.proxyStopped,
        "Proxy stopped. Fully quit ChatGPT and Codex if still open, then reopen them to use native routing."
    )
}

runner.test("ui: setup requirements present actionable and forward-compatible guidance") {
    let firstRun = LifecycleResultMessage.setupRequired(.codexFirstRun)
    runner.equal(firstRun.title, "Open Codex to finish setup")
    runner.equal(
        firstRun.detail,
        "CodexCommander is running. Open Codex once, then choose Route Codex Through Proxy."
    )

    let future = LifecycleResultMessage.setupRequired(.unknown("future-setup"))
    runner.equal(future.title, "CodexCommander setup is required")
    runner.equal(
        future.detail,
        "The proxy is running. Update CodexCommander for setup instructions."
    )
}

runner.test("ui: catalog confirmation is activity-aware and defaults to Later") {
    let busy = CatalogUpdateConfirmation(activity: .active(2))
    let busyAlert = busy.makeAlert()
    runner.equal(busyAlert.messageText, "Apply the agent catalog update?")
    runner.equal(busyAlert.buttons.map(\.title), ["Apply Now", "Later"])
    runner.expect(
        busyAlert.informativeText.contains("2 active agent requests"),
        "busy confirmation names current activity"
    )
    runner.expect(
        busyAlert.informativeText.contains("CodexCommander remains running"),
        "confirmation keeps proxy restart separate"
    )
    runner.equal(busyAlert.buttons[0].hasDestructiveAction, true)
    let laterCell = busyAlert.buttons[1].cell as? NSButtonCell
    runner.expect(busyAlert.window.defaultButtonCell === laterCell, "Later is the default")
    runner.expect(
        busyAlert.window.initialFirstResponder === busyAlert.buttons[1],
        "Later receives initial focus"
    )
    runner.equal(busy.choice(for: .alertFirstButtonReturn), .applyNow)
    runner.equal(busy.choice(for: .alertSecondButtonReturn), .later)

    let zero = CatalogUpdateConfirmation(activity: .noActiveRequests).makeAlert()
    runner.expect(
        zero.informativeText.contains("no active agent requests"),
        "zero evidence is stated precisely"
    )
    runner.equal(
        zero.informativeText.lowercased().contains("idle"),
        false,
        "zero is never labelled idle"
    )
    runner.expect(
        zero.informativeText.contains("new request can still begin"),
        "zero copy explains the observation race"
    )
    runner.equal(zero.buttons[0].hasDestructiveAction, true)

    let unknown = CatalogUpdateConfirmation(activity: .unknown).makeAlert()
    runner.expect(
        unknown.informativeText.contains("could not verify"),
        "missing activity never becomes a false zero"
    )
    runner.equal(unknown.buttons[0].hasDestructiveAction, true)
}

runner.test("ui: application menu keeps Command-Q safe and provides explicit destructive exit") {
    let target = ApplicationMenuTarget()
    let menu = ApplicationMenuFactory.make(
        target: target,
        quitAction: #selector(ApplicationMenuTarget.quitMenuBar(_:)),
        stopAndQuitAction: #selector(ApplicationMenuTarget.stopCodexCommanderAndQuit(_:))
    )
    let items = menu.items.first?.submenu?.items.filter { !$0.isSeparatorItem } ?? []
    runner.equal(menu.items.map(\.title), ["CodexCommander", "Edit"])
    runner.equal(items.map(\.title), ["Stop CodexCommander and Quit…", "Quit Menu Bar"])
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
            state: .running(currentHealth()),
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

runner.test("ui: catalog apply requires readiness and a confirmed running proxy") {
    let running = makeSnapshot().state
    runner.equal(
        CatalogUpdateActionAvailability.canApply(
            updateReady: true,
            state: running,
            controlsAllowed: true
        ),
        true
    )
    for state in [
        ProxyState.unreachable,
        .degraded("Unconfirmed"),
        .unauthorized,
        .loading,
    ] {
        runner.equal(
            CatalogUpdateActionAvailability.canApply(
                updateReady: true,
                state: state,
                controlsAllowed: true
            ),
            false,
            "non-running state cannot apply"
        )
    }
    runner.equal(
        CatalogUpdateActionAvailability.canApply(
            updateReady: false,
            state: running,
            controlsAllowed: true
        ),
        false,
        "no update readiness"
    )
    runner.equal(
        CatalogUpdateActionAvailability.canApply(
            updateReady: true,
            state: running,
            controlsAllowed: false
        ),
        false,
        "another action is in flight"
    )
}

runner.test("ui: app menu starts with destructive exit disabled and safe quit enabled") {
    let delegate = AppDelegate()
    let menu = ApplicationMenuFactory.make(
        target: delegate,
        quitAction: NSSelectorFromString("quitMenuBar:"),
        stopAndQuitAction: NSSelectorFromString("stopCodexCommanderAndQuit:")
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
        StopAndQuitPolicy.shouldTerminate(after: .setupRequired(.codexFirstRun)),
        false,
        "first-run guidance never turns a failed stop into termination"
    )
    runner.equal(
        StopAndQuitPolicy.shouldTerminate(after: .failed("still running")),
        false
    )
}

runner.test("ui: translocated automatic launch shows move guidance without starting lifecycle") {
    let lifecycle = RecordingLifecycleRunner()
    let delegate = AppDelegate(
        appBundleLocation: .translocated,
        actions: ActionCoordinator(lifecycle: lifecycle)
    )

    delegate.startProxyOnLaunchForTesting()
    spinMainRunLoop(seconds: 0.05)

    runner.equal(lifecycle.recordedActions, [], "randomized bundle path must never reach Start")
    runner.equal(
        delegate.presentationControllerForTesting.operationStatusTitle,
        "Move CodexCommander to Applications"
    )
    runner.equal(
        delegate.presentationControllerForTesting.operationStatusDetail,
        "This temporary macOS launch location cannot safely run the background proxy. Move the app, then reopen it."
    )
}

runner.test("ui: translocated manual Start remains blocked") {
    let lifecycle = RecordingLifecycleRunner()
    let delegate = AppDelegate(
        appBundleLocation: .translocated,
        actions: ActionCoordinator(lifecycle: lifecycle)
    )

    delegate.startProxyForTesting()
    spinMainRunLoop(seconds: 0.05)

    runner.equal(lifecycle.recordedActions, [], "manual Start must not escape translocation blocking")
    runner.equal(delegate.presentationControllerForTesting.operationStatusTone, .warning)
}

runner.test("ui: relocatable automatic launch continues through Start for this session") {
    let lifecycle = RecordingLifecycleRunner()
    let delegate = AppDelegate(
        appBundleLocation: .relocatable,
        actions: ActionCoordinator(lifecycle: lifecycle)
    )

    delegate.startProxyOnLaunchForTesting()
    spinMainRunLoop(seconds: 0.10)

    runner.equal(lifecycle.recordedActions, [.start])
}

// MARK: - Resource honesty

runner.test("ui: provider icon loader returns real SVG-backed images for known providers") {
    _ = runner.notNil(ResourceAssets.providerIcon(for: "openai"), "openai icon")
    _ = runner.notNil(ResourceAssets.providerIcon(for: "kimi"), "kimi icon")
    _ = runner.notNil(ResourceAssets.providerIcon(for: "xai"), "grok icon")
    runner.isNil(ResourceAssets.providerIcon(for: "definitely-not-a-provider"), "unknown stays nil")
}

// MARK: - Companion heartbeat

final class HeartbeatRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var _statuses: [LaunchAtLoginStatus] = []

    var statuses: [LaunchAtLoginStatus] {
        lock.lock()
        defer { lock.unlock() }
        return _statuses
    }

    var count: Int {
        lock.lock()
        defer { lock.unlock() }
        return _statuses.count
    }

    func record(_ status: LaunchAtLoginStatus) {
        lock.lock()
        defer { lock.unlock() }
        _statuses.append(status)
    }
}

func spinMainRunLoop(seconds: TimeInterval) {
    let deadline = Date().addingTimeInterval(seconds)
    while Date() < deadline {
        RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.002))
    }
}

@MainActor
func runCompanionHeartbeatTests(_ runner: TestRunner) {
    // The first run-loop drain of this process does not service timers (verified
    // empirically: the first spin always reports zero fires, the second fires
    // normally). Drain once up front so the timer assertions are deterministic.
    spinMainRunLoop(seconds: 0.02)

    runner.test("ui: companion heartbeat runs a single timer and stops cleanly") {
        // The production cadence is 30s; a short injected interval keeps the single-timer
        // and stop() guarantees observable in-process without waiting half a minute.
        let recorder = HeartbeatRecorder()
        let heartbeat = CompanionHeartbeat(
            interval: 0.02,
            sample: { .enabled },
            send: { status in recorder.record(status) }
        )

        heartbeat.start()
        heartbeat.start()
        heartbeat.start()
        spinMainRunLoop(seconds: 0.12)
        let during = recorder.count
        runner.expect(during >= 1, "the repeating timer fires at least once (got \(during))")
        // One 20ms timer over 120ms fires ~6 times; stacked duplicates would fire ~18.
        runner.expect(during <= 9, "repeated start() must not duplicate the timer (got \(during))")
        runner.equal(recorder.statuses.first, .enabled, "the sampled status is what gets reported")

        heartbeat.stop()
        let stoppedCount = recorder.count
        spinMainRunLoop(seconds: 0.10)
        runner.equal(recorder.count, stoppedCount, "stop() cancels the timer")
    }

    runner.test("ui: companion heartbeat coalesces in-flight reports and reports again after") {
        let recorder = HeartbeatRecorder()
        let heartbeat = CompanionHeartbeat(
            interval: 60, // never fires during this test
            sample: { .requiresApproval },
            send: { status in
                try? await Task.sleep(nanoseconds: 30_000_000)
                recorder.record(status)
            }
        )

        heartbeat.reportNow()
        heartbeat.reportNow()
        spinMainRunLoop(seconds: 0.10)
        runner.equal(recorder.count, 1, "a report while one is in flight is coalesced away")

        heartbeat.reportNow()
        spinMainRunLoop(seconds: 0.10)
        runner.equal(recorder.count, 2, "a later reportNow fires after the previous completed")
        runner.equal(recorder.statuses[0], .requiresApproval, "the freshly sampled status is reported")
        heartbeat.stop()
    }
}

// Top-level code runs on the process main thread, so the MainActor hop is safe here.
MainActor.assumeIsolated {
    runCompanionHeartbeatTests(runner)
}

exit(runner.summarize())
