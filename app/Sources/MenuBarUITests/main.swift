import AppKit
import MenuBarCore
import MenuBarUI

// UI-layer tests for the approved menu-bar panel: hierarchy, accordion behaviour,
// deep-link encoding, accessibility, and panel sizing.

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)

let runner = TestRunner()

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
    activity: AgentActivitySnapshot? = nil,
    quotasLoaded: Bool = true,
    activityLoaded: Bool = true
) -> ProxySnapshot {
    ProxySnapshot(
        state: .running(StartupHealth(status: "protected")),
        endpoint: .default,
        quotas: quotas,
        activity: activity,
        lastUpdated: Date(),
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

runner.test("ui: footer exposes Dashboard Logs Refresh Restart") {
    let controller = PopoverViewController()
    _ = controller.view
    let titles = controller.footerTitles
    runner.equal(titles, ["Dashboard", "Logs", "Refresh", "Restart…"], "footer titles")
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

runner.test("ui: footer buttons invoke all four production actions") {
    let controller = PopoverViewController()
    _ = controller.view
    var calls: [String] = []
    controller.onDashboard = { calls.append("dashboard") }
    controller.onLogs = { calls.append("logs") }
    controller.onRefresh = { calls.append("refresh") }
    controller.onRestart = { calls.append("restart") }
    for index in 0..<4 { controller.activateFooterForTesting(index) }
    runner.equal(calls, ["dashboard", "logs", "refresh", "restart"])
}

// MARK: - Resource honesty

runner.test("ui: provider icon loader returns real SVG-backed images for known providers") {
    _ = runner.notNil(ResourceAssets.providerIcon(for: "openai"), "openai icon")
    _ = runner.notNil(ResourceAssets.providerIcon(for: "kimi"), "kimi icon")
    _ = runner.notNil(ResourceAssets.providerIcon(for: "xai"), "grok icon")
    runner.isNil(ResourceAssets.providerIcon(for: "definitely-not-a-provider"), "unknown stays nil")
}

exit(runner.summarize())
