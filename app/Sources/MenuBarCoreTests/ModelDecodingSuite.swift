import Foundation
import MenuBarCore

/// Fixtures are verbatim captures from the live proxy on 2026-07-25, recorded in
/// devlog/_plan/260725_macos_menubar_app/002_api_surface.md. Hand-written fixtures would
/// only prove the models decode themselves.
enum ModelDecodingSuite {
    private static func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    private struct Envelope: Decodable { let reports: [QuotaReport]? }

    private static let liveHealth = """
    {"routingKind":"opencodex-local","autostartEnabled":false,"serviceInstalled":true,
     "serviceViable":true,"serviceEnabled":true,"serviceRunning":true,"serviceStale":false,
     "serviceConflict":false,"serviceSupported":true,"shimInstalled":false,
     "shimHealthy":false,"platform":"darwin","diagnosticStale":true,"routingInjected":true,
     "localRoutingDependency":true,"status":"at-risk","rebootSafe":false,"protection":"none",
     "shimCoverage":"none","recommendedCommand":"ocx service install",
     "commands":{"installService":"ocx service install","installShim":"ocx codex-shim install",
     "restoreNative":"ocx restore"}}
    """

    private static let liveQuotas = """
    {"generatedAt":1784915336899,"reports":[
      {"provider":"openai","label":"OpenAI (Codex login)","source":"chatgpt:wham",
       "quota":{"updatedAt":1784915090763,"weeklyPercent":44,"weeklyResetAt":1785258443,
                "resetCredits":3}},
      {"provider":"anthropic","label":"Anthropic Claude","source":"anthropic:oauth-usage",
       "quota":{"weeklyPercent":58,"weeklyResetAt":1785265199718,
                "customWindows":[{"label":"5h","percent":1,"resetAt":1784928599718}]}},
      {"provider":"xai","label":"xAI Grok","source":"xai:grok-billing",
       "quota":{"monthlyPercent":86.82666666666667,"monthlyResetAt":1785542400000}}]}
    """

    static func run(_ t: TestRunner) {
        t.test("health: decodes the live startup-health payload") {
            let health = try decode(StartupHealth.self, liveHealth)
            t.equal(health.status, "at-risk")
            t.equal(health.platform, "darwin")
            t.equal(health.recommendedCommand, "ocx service install")
            t.equal(health.isDiagnosticStale, true)
            t.equal(health.isProtected, false)
            t.equal(health.isServiceManaged, true)
            t.equal(health.manualStartCommand, "ocx service start")
        }

        t.test("health: an unknown status string decodes without throwing") {
            let health = try decode(StartupHealth.self, #"{"status":"some-future-state"}"#)
            t.equal(health.status, "some-future-state")
            t.equal(health.isDiagnosticStale, false)
            t.equal(health.isProtected, false)
        }

        t.test("health: without service fields it is not service-managed") {
            let health = try decode(StartupHealth.self, #"{"status":"protected"}"#)
            t.equal(health.isProtected, true)
            t.equal(health.isServiceManaged, false)
            t.equal(health.manualStartCommand, "ocx start")
        }

        // The decisive trap: openai sends weeklyResetAt in SECONDS (1785258443) while
        // anthropic sends MILLISECONDS (1785265199718) in the same array.
        t.test("quotas: mixed second and millisecond timestamps both resolve to 2026") {
            let reports = try decode(Envelope.self, liveQuotas).reports ?? []
            t.equal(reports.count, 3)
            let calendar = Calendar(identifier: .gregorian)
            for report in reports {
                let normalized = report.normalized()
                guard let date = t.notNil(normalized.resetAt, "\(report.provider) resetAt") else { continue }
                t.equal(calendar.component(.year, from: date), 2026, "\(report.provider) year")
            }
        }

        t.test("quotas: normalization picks the right window per provider") {
            let reports = try decode(Envelope.self, liveQuotas).reports ?? []
            let byProvider = Dictionary(uniqueKeysWithValues: reports.map { ($0.provider, $0.normalized()) })
            t.equal(byProvider["openai"]?.windowLabel, "week")
            t.equal(byProvider["openai"]?.percent, 44)
            t.equal(byProvider["anthropic"]?.windowLabel, "week")
            t.equal(byProvider["xai"]?.windowLabel, "month")
            t.equal(byProvider["xai"]?.providerLabel, "xAI Grok")
        }

        t.test("providers: quota presentation eligibility mirrors supported probes") {
            let providers = try decode([ProviderSummary].self, """
            [
              {"name":"openai","authMode":"forward","quotaCapable":true},
              {"name":"xai","authMode":"oauth","quotaCapable":true},
              {"name":"kimi","authMode":"key","quotaCapable":true},
              {"name":"team-a6","authMode":"key","quotaCapable":true},
              {"name":"opencode-go","authMode":"key","quotaCapable":true},
              {"name":"deepseek","authMode":"key","quotaCapable":false},
              {"name":"legacy-xai","authMode":"oauth"},
              {"name":"anthropic","authMode":"oauth","quotaCapable":true,"disabled":true}
            ]
            """)
            let byName = Dictionary(uniqueKeysWithValues: providers.map { ($0.name, $0) })
            for name in ["openai", "xai", "kimi", "team-a6", "opencode-go"] {
                t.equal(byName[name]?.supportsQuotaReporting, true, "\(name) supported")
            }
            t.equal(byName["deepseek"]?.supportsQuotaReporting, false)
            t.equal(byName["legacy-xai"]?.supportsQuotaReporting, false, "old proxy omits capability")
            t.equal(byName["anthropic"]?.supportsQuotaReporting, false, "disabled provider")

            let reports = try decode([QuotaReport].self, """
            [
              {"provider":"xai","label":"Grok","quota":{"monthlyPercent":41}},
              {"provider":"anthropic","label":"Anthropic","quota":{"weeklyPercent":12}},
              {"provider":"removed","label":"Removed","quota":{"monthlyPercent":9}}
            ]
            """)
            let snapshot = ProxySnapshot(
                state: .running(StartupHealth(status: "protected")),
                endpoint: .default,
                quotas: reports,
                providers: providers,
                providersLoaded: true,
                quotasLoaded: true
            )
            let rows = snapshot.providerQuotaRows
            t.equal(rows.map(\.provider), ["openai", "xai", "kimi", "team-a6", "opencode-go"])
            t.equal(rows.filter { $0.provider == "xai" }.count, 1, "actual report wins")
            t.equal(rows.first { $0.provider == "xai" }?.isUnavailable, false)
            t.equal(rows.first { $0.provider == "openai" }?.isUnavailable, true)
        }

        t.test("quotas: nested freshness wins and report freshness fills the gap") {
            let nested = try decode(
                QuotaReport.self,
                #"{"provider":"openai","updatedAt":1000,"quota":{"updatedAt":1784915090763}}"#
            )
            t.equal(nested.freshnessDate, QuotaReport.date(from: 1784915090763))

            let report = try decode(
                QuotaReport.self,
                #"{"provider":"xai","updatedAt":1784915090763,"quota":{}}"#
            )
            t.equal(report.freshnessDate, QuotaReport.date(from: 1784915090763))
        }

        t.test("quotas: a custom-window-only quota uses its own label") {
            let json = """
            {"provider":"p","quota":{"customWindows":[{"label":"5h","percent":12,"resetAt":1784928599718}]}}
            """
            let normalized = try decode(QuotaReport.self, json).normalized()
            t.equal(normalized.windowLabel, "5h")
            t.equal(normalized.percent, 12)
        }

        // Live kimi reports weeklyPercent AND fiveHourPercent; live cursor and
        // google-antigravity each carry two customWindows. Returning one window would
        // hide real quota pressure.
        t.test("quotas: kimi exposes both its five-hour and weekly windows") {
            let json = """
            {"provider":"kimi","label":"Kimi","quota":{"fiveHourPercent":22,
             "fiveHourResetAt":1784928599718,"weeklyPercent":61,"weeklyResetAt":1785265199718}}
            """
            let report = try decode(QuotaReport.self, json)
            let windows = report.normalizedWindows()
            t.equal(windows.count, 2)
            t.equal(windows.map(\.windowLabel), ["5h", "week"])
            // The compact row prefers the longer horizon.
            t.equal(report.normalized().windowLabel, "week")
            t.equal(report.normalized().percent, 61)
        }

        t.test("quotas: multiple custom windows are all retained") {
            let json = """
            {"provider":"cursor","label":"Cursor","quota":{"monthlyPercent":10,
             "monthlyResetAt":1785256304000,
             "customWindows":[{"label":"First-party models","percent":4,"resetAt":1785256304000},
                              {"label":"API usage","percent":1,"resetAt":1785256304000}]}}
            """
            let report = try decode(QuotaReport.self, json)
            let windows = report.normalizedWindows()
            t.equal(windows.count, 3)
            t.equal(windows.map(\.windowLabel), ["month", "First-party models", "API usage"])
            t.equal(report.normalized().windowLabel, "month")
        }

        t.test("quotas: a provider with only custom windows still normalizes") {
            let json = """
            {"provider":"google-antigravity","label":"Google","quota":{
             "customWindows":[{"label":"Gem","percent":30,"resetAt":1785256304000},
                              {"label":"Cla","percent":12,"resetAt":1785256304000}]}}
            """
            let report = try decode(QuotaReport.self, json)
            t.equal(report.normalizedWindows().count, 2)
            t.equal(report.normalized().windowLabel, "Gem")
            t.equal(report.normalized().percent, 30)
        }

        // Every window can stop work. A provider at 99% of a five-hour limit is blocked
        // right now even if its monthly usage is 10%; picking the longer horizon would
        // paint that row green while the user cannot make a request.
        t.test("quotas: the compact row shows the window under the most pressure") {
            let json = """
            {"provider":"kimi","label":"Kimi","quota":{"fiveHourPercent":99,
             "fiveHourResetAt":1784928599718,"monthlyPercent":10,"monthlyResetAt":1785542400000}}
            """
            let report = try decode(QuotaReport.self, json)
            t.equal(report.normalized().windowLabel, "5h")
            t.equal(report.normalized().percent, 99)
            t.equal(report.normalizedWindows().count, 2)
        }

        t.test("quotas: equal pressure breaks toward the longer horizon") {
            let json = """
            {"provider":"p","quota":{"fiveHourPercent":50,"fiveHourResetAt":1784928599718,
             "weeklyPercent":50,"weeklyResetAt":1785265199718}}
            """
            t.equal(try decode(QuotaReport.self, json).normalized().windowLabel, "week")
        }

        t.test("quotas: a window reporting only a reset time does not outrank a measured one") {
            let json = """
            {"provider":"p","quota":{"weeklyPercent":12,"weeklyResetAt":1785265199718,
             "customWindows":[{"label":"unmeasured","resetAt":1785265199718}]}}
            """
            let report = try decode(QuotaReport.self, json)
            t.equal(report.normalized().windowLabel, "week")
            t.equal(report.normalized().percent, 12)
        }

        t.test("quotas: an absent quota normalizes to a nil percent") {
            let normalized = try decode(QuotaReport.self, #"{"provider":"p","label":"P"}"#).normalized()
            t.isNil(normalized.percent, "percent")
            t.equal(normalized.hasPercent, false)
            t.isNil(normalized.resetAt, "resetAt")
        }

        t.test("quotas: OpenCode Go reference caps decode without inventing a percentage") {
            let json = """
            {"provider":"opencode-go","label":"OpenCode Go",
             "source":"opencode-go:published-caps+local-estimate","quota":{
               "updatedAt":1784915090763,
               "referenceWindows":[
                 {"id":"five_hour","label":"5-hour","windowSeconds":18000,
                  "publishedLimitUsd":12,"observedSpendUsd":0.3,
                  "observedTokens":1000120,"observedRequests":3,"pricedRequests":3,
                  "unpricedRequests":0,"unmeasuredRequests":0,"coverage":"complete"},
                 {"id":"weekly","label":"7-day","windowSeconds":604800,
                  "publishedLimitUsd":30,"observedSpendUsd":1.1,
                  "observedTokens":2400000,"observedRequests":4,"pricedRequests":2,
                  "unpricedRequests":1,"unmeasuredRequests":1,"coverage":"partial"},
                 {"id":"monthly","label":"30-day","windowSeconds":2592000,
                  "publishedLimitUsd":60,"observedTokens":0,"observedRequests":0,
                  "pricedRequests":0,"unpricedRequests":0,"unmeasuredRequests":0,
                  "coverage":"none"}],
               "observedLimitEvent":{"limitName":"weekly","observedAt":1784915090763,
                                     "resetAt":1784918690763}}}
            """
            let report = try decode(QuotaReport.self, json)
            t.equal(report.referenceWindows.count, 3)
            t.equal(report.referenceWindows.map(\.publishedLimitUsd), [12, 30, 60])
            t.equal(report.referenceWindows.map(\.observationQuality), [.estimate, .partial, .none])
            t.equal(report.observedLimitEvent?.limitName, "weekly")

            // Reference spend is local evidence, not provider usage or remaining quota.
            t.equal(report.normalizedWindows().count, 0)
            t.isNil(report.normalized().percent, "reference percent")
        }

        t.test("quotas: inconsistent complete coverage degrades to Partial") {
            let json = """
            {"provider":"opencode-go","quota":{"referenceWindows":[{
              "id":"five_hour","publishedLimitUsd":12,"observedSpendUsd":0.3,
              "observedTokens":100,"observedRequests":2,"pricedRequests":1,
              "unpricedRequests":1,"unmeasuredRequests":0,"coverage":"complete"}]}}
            """
            let report = try decode(QuotaReport.self, json)
            t.equal(report.referenceWindows.first?.observationQuality, .partial)
        }

        t.test("providers: decodes the live list") {
            let json = """
            [{"name":"openai","adapter":"openai-responses","hasApiKey":false,
              "authMode":"forward","disabled":false,"codexAccountMode":"pool"},
             {"name":"anthropic","adapter":"anthropic","hasApiKey":false,
              "authMode":"oauth","disabled":true}]
            """
            let providers = try decode([ProviderSummary].self, json)
            t.equal(providers.count, 2)
            t.equal(providers[0].name, "openai")
            t.equal(providers[0].isEnabled, true)
            t.equal(providers[1].isEnabled, false)
        }

        t.test("providers: a provider without a disabled field is enabled") {
            t.equal(try decode(ProviderSummary.self, #"{"name":"custom"}"#).isEnabled, true)
        }

        t.test("activity: schema v1 decodes truthful active-only phases") {
            let json = """
            {"schemaVersion":1,"generatedAt":1784915336899,"proxyState":"active",
             "activeTurnCount":2,"displayedActivityCount":2,"unattributedActiveCount":0,
             "truncated":false,"activities":[
               {"id":"opaque-parent","role":"primary","provider":"openai",
                "model":"gpt-5.6-sol","phase":"running","startedAt":1784915336000,
                "firstOutputAt":1784915336500},
               {"id":"opaque-child","parentId":"opaque-parent","role":"subagent",
                "provider":"kimi","model":"k3","phase":"starting","startedAt":1784915336700}]}
            """
            let snapshot = try decode(AgentActivitySnapshot.self, json)
            t.equal(snapshot.isSupported, true)
            t.equal(snapshot.activities.map(\.phase), [.running, .starting])
            t.equal(snapshot.activities[1].parentId, "opaque-parent")
            t.equal(snapshot.activities[0].displayName, "gpt-5.6-sol")
        }
    }
}
