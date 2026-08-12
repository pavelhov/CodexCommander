import Foundation
import MenuBarCore

/// Fixtures track the live CodexCommander payload shape and command guidance.
enum ModelDecodingSuite {
    private static func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    private static func rejects<T: Decodable>(_ type: T.Type, _ json: String) -> Bool {
        (try? decode(type, json)) == nil
    }

    private static func report(provider: String, label: String, source: String = "test", quota: String) -> String {
        "{\"provider\":\"\(provider)\",\"label\":\"\(label)\",\"source\":\"\(source)\",\"quota\":\(quota),\"updatedAt\":1784915090763}"
    }

    private static let liveHealth = """
    {"routingKind":"codexcommander-local","autostartEnabled":false,"serviceInstalled":true,
     "serviceViable":true,"serviceEnabled":true,"serviceRunning":true,"serviceStale":false,
     "serviceConflict":false,"serviceSupported":true,"shimInstalled":false,
     "shimHealthy":false,"platform":"darwin","diagnosticStale":true,"routingInjected":true,
     "localRoutingDependency":true,"status":"at-risk","rebootSafe":false,"protection":"none",
     "shimCoverage":"none","recommendedCommand":"ccx service install",
     "commands":{"installService":"ccx service install","repairService":"ccx service repair","installShim":"ccx codex-shim install",
     "restoreNative":"ccx restore"}}
    """

    private static let liveReadiness =
        #"{"service":"codexcommander","version":"0.1.0","uptime":12.5,"pid":42,"port":10100,"status":"ready"}"#

    private static let liveQuotas = """
    {"generatedAt":1784915336899,"reports":[
      {"provider":"openai","label":"OpenAI (Codex login)","source":"chatgpt:wham",
       "quota":{"updatedAt":1784915090763,"weeklyPercent":44,"weeklyResetAt":1785258443},"updatedAt":1784915090763},
      {"provider":"anthropic","label":"Anthropic Claude","source":"anthropic:oauth-usage",
       "quota":{"updatedAt":1784915090763,"weeklyPercent":58,"weeklyResetAt":1785265199718,
                "customWindows":[{"label":"5h","percent":1,"resetAt":1784928599718}]},"updatedAt":1784915090763},
      {"provider":"xai","label":"xAI Grok","source":"xai:grok-billing",
       "quota":{"updatedAt":1784915090763,"monthlyPercent":86.82666666666667,"monthlyResetAt":1785542400000},"updatedAt":1784915090763}],"availability":[]}
    """

    static func run(_ t: TestRunner) {
        t.test("build provenance: formats only stamped git revisions") {
            t.equal(
                BuildProvenance.shortRevision(
                    "d986bada3d4c7986b8d127b2d60eabfc81713d25"
                ),
                "d986bada"
            )
            t.equal(
                BuildProvenance.shortRevision(
                    "d986bada3d4c7986b8d127b2d60eabfc81713d25-dirty"
                ),
                "d986bada-dirty"
            )
            t.isNil(BuildProvenance.shortRevision("1.2.3"), "release version is not provenance")
            t.isNil(BuildProvenance.shortRevision("unknown"), "unknown source")
        }

        t.test("health: decodes the live startup-health payload") {
            let health = try decode(StartupHealth.self, liveHealth)
            t.equal(health.status, "at-risk")
            t.equal(health.platform, "darwin")
            t.equal(health.recommendedCommand, "ccx service install")
            t.equal(health.isDiagnosticStale, true)
            t.equal(health.isProtected, false)
            t.equal(health.isServiceManaged, true)
            t.equal(health.manualStartCommand, "ccx service start")
        }

        t.test("health: an unknown status string remains forward compatible") {
            let health = try decode(StartupHealth.self, liveHealth.replacingOccurrences(of: "at-risk", with: "some-future-state"))
            t.equal(health.status, "some-future-state")
            t.equal(health.isDiagnosticStale, true)
            t.equal(health.isProtected, false)
        }

        t.test("health: rejects a stale partial startup-health payload") {
            t.expect(rejects(StartupHealth.self, #"{"status":"protected"}"#), "partial health must be rejected")
        }

        t.test("readiness: decodes only the exact public contract and closed statuses") {
            let ready = try decode(ProxyReadinessObservation.self, liveReadiness)
            t.equal(ready.status, .ready)
            t.equal(ready.service, "codexcommander")
            t.equal(ready.version, "0.1.0")
            t.equal(ready.uptime, 12.5)
            t.equal(ready.pid, 42)
            t.equal(ready.port, 10100)

            let pending = try decode(
                ProxyReadinessObservation.self,
                liveReadiness.replacingOccurrences(of: "ready", with: "pending")
            )
            t.equal(pending.status, .pending)
            let failed = try decode(
                ProxyReadinessObservation.self,
                liveReadiness.replacingOccurrences(of: "ready", with: "failed")
            )
            t.equal(failed.status, .failed)

            t.expect(
                rejects(
                    ProxyReadinessObservation.self,
                    #"{"service":"codexcommander","version":"0.1.0","uptime":1,"pid":42,"port":10100,"status":"warming"}"#
                ),
                "unknown readiness status must be rejected"
            )
            t.expect(
                rejects(
                    ProxyReadinessObservation.self,
                    #"{"service":"codexcommander","version":"0.1.0","uptime":1,"pid":42,"port":10100,"status":"ready","detail":"extra"}"#
                ),
                "extra readiness keys must be rejected"
            )
            t.expect(
                rejects(
                    ProxyReadinessObservation.self,
                    #"{"service":"codexcommander","version":"0.1.0","pid":42,"port":10100,"status":"ready"}"#
                ),
                "missing readiness keys must be rejected"
            )
        }

        t.test("route status: requires the exact v1 contract and consistent ownership") {
            let native = try decode(
                CodexRouteStatus.self,
                #"{"schemaVersion":1,"routingKind":"native","routingInjected":false}"#
            )
            t.equal(native.routingKind, .native)
            t.equal(native.routingInjected, false)
            let routed = try decode(
                CodexRouteStatus.self,
                #"{"schemaVersion":1,"routingKind":"codexcommander-local","routingInjected":true}"#
            )
            t.equal(routed.routingKind, .codexCommanderLocal)
            t.equal(routed.routingInjected, true)

            for invalid in [
                #"{"routingKind":"native","routingInjected":false}"#,
                #"{"schemaVersion":2,"routingKind":"native","routingInjected":false}"#,
                #"{"schemaVersion":1,"routingKind":"native","routingInjected":true}"#,
                #"{"schemaVersion":1,"routingKind":"codexcommander-local","routingInjected":false}"#,
                #"{"schemaVersion":1,"routingKind":"future","routingInjected":false}"#,
                #"{"schemaVersion":1,"routingKind":"native","routingInjected":false,"extra":true}"#,
            ] {
                t.expect(rejects(CodexRouteStatus.self, invalid), "invalid route DTO must be rejected")
            }
        }

        t.test("restart: rejects a partial accepted response") {
            t.expect(
                rejects(RestartAccepted.self, #"{"success":true,"activeTurnCount":0,"drainTimeoutMs":1000,"alreadyDraining":false}"#),
                "restart message must be present"
            )
            let accepted = try decode(
                RestartAccepted.self,
                #"{"success":true,"message":"Draining in-flight requests, then restarting.","activeTurnCount":0,"drainTimeoutMs":1000,"alreadyDraining":false}"#
            )
            t.equal(accepted.drainTimeoutMs, 1000)
        }

        // The decisive trap: openai sends weeklyResetAt in SECONDS (1785258443) while
        // anthropic sends MILLISECONDS (1785265199718) in the same array.
        t.test("quotas: mixed second and millisecond timestamps both resolve to 2026") {
            let reports = try decode(ProviderQuotaEnvelope.self, liveQuotas).reports
            t.equal(reports.count, 3)
            let calendar = Calendar(identifier: .gregorian)
            for report in reports {
                let normalized = report.normalized()
                guard let date = t.notNil(normalized.resetAt, "\(report.provider) resetAt") else { continue }
                t.equal(calendar.component(.year, from: date), 2026, "\(report.provider) year")
            }
        }

        t.test("quotas: normalization picks the right window per provider") {
            let reports = try decode(ProviderQuotaEnvelope.self, liveQuotas).reports
            let byProvider = Dictionary(uniqueKeysWithValues: reports.map { ($0.provider, $0.normalized()) })
            t.equal(byProvider["openai"]?.windowLabel, "week")
            t.equal(byProvider["openai"]?.percent, 44)
            t.equal(byProvider["anthropic"]?.windowLabel, "week")
            t.equal(byProvider["xai"]?.windowLabel, "month")
            t.equal(byProvider["xai"]?.providerLabel, "xAI Grok")
        }

        t.test("quotas: availability reasons are actionable and forward compatible") {
            let envelope = try decode(ProviderQuotaEnvelope.self, """
            {"generatedAt":1784915336899,"reports":[],"availability":[
              {"provider":"xai","status":"unavailable",
               "reason":"local_cli_refresh_required","checkedAt":1784915336899},
              {"provider":"future","status":"future-state",
               "reason":"future-reason","checkedAt":1784915336899}]}
            """)
            t.equal(envelope.availability.count, 2)
            t.equal(envelope.availability.first?.status, .unavailable)
            t.equal(envelope.availability.first?.reason, .localCLIRefreshRequired)
            t.equal(envelope.availability.last?.status, .unknown)
            t.equal(envelope.availability.last?.reason, .unknown)
            t.expect(rejects(ProviderQuotaEnvelope.self, #"{"generatedAt":1,"reports":[]}"#), "partial quota envelope must be rejected")
        }

        t.test("providers: quota presentation eligibility mirrors supported probes") {
            let providers = try decode([ProviderSummary].self, """
            [
              {"name":"openai","adapter":"openai-responses","authMode":"forward","hasApiKey":false,"disabled":false,"quotaCapable":true},
              {"name":"xai","adapter":"openai-chat","authMode":"oauth","hasApiKey":true,"disabled":false,"quotaCapable":true},
              {"name":"kimi","adapter":"kimi","authMode":"key","hasApiKey":true,"disabled":false,"quotaCapable":true},
              {"name":"team-a6","adapter":"openai-chat","authMode":"key","hasApiKey":true,"disabled":false,"quotaCapable":true},
              {"name":"opencode-go","adapter":"opencode-go","authMode":"key","hasApiKey":true,"disabled":false,"quotaCapable":true},
              {"name":"deepseek","adapter":"openai-chat","authMode":"key","hasApiKey":true,"disabled":false,"quotaCapable":false},
              {"name":"xai-no-quota","adapter":"openai-chat","authMode":"oauth","hasApiKey":true,"disabled":false,"quotaCapable":false},
              {"name":"anthropic","adapter":"anthropic","authMode":"oauth","hasApiKey":false,"disabled":true,"quotaCapable":true}
            ]
            """)
            let byName = Dictionary(uniqueKeysWithValues: providers.map { ($0.name, $0) })
            for name in ["openai", "xai", "kimi", "team-a6", "opencode-go"] {
                t.equal(byName[name]?.supportsQuotaReporting, true, "\(name) supported")
            }
            t.equal(byName["deepseek"]?.supportsQuotaReporting, false)
            t.equal(byName["xai-no-quota"]?.supportsQuotaReporting, false, "capability disabled")
            t.equal(byName["anthropic"]?.supportsQuotaReporting, false, "disabled provider")

            let reports = try decode([QuotaReport].self, """
            [
              {"provider":"xai","label":"Grok","source":"test","quota":{"updatedAt":1,"monthlyPercent":41},"updatedAt":1},
              {"provider":"anthropic","label":"Anthropic","source":"test","quota":{"updatedAt":1,"weeklyPercent":12},"updatedAt":1},
              {"provider":"removed","label":"Removed","source":"test","quota":{"updatedAt":1,"monthlyPercent":9},"updatedAt":1}
            ]
            """)
            let snapshot = ProxySnapshot(
                state: .running(try decode(StartupHealth.self, liveHealth.replacingOccurrences(of: "at-risk", with: "protected"))),
                endpoint: .default,
                quotas: reports,
                quotaAvailability: try decode([ProviderQuotaAvailability].self, """
                [{"provider":"openai","status":"unavailable",
                  "reason":"reauth_required","checkedAt":1}]
                """),
                providers: providers,
                providersLoaded: true,
                quotasLoaded: true
            )
            let rows = snapshot.providerQuotaRows
            t.equal(rows.map(\.provider), ["openai", "xai", "kimi", "team-a6", "opencode-go"])
            t.equal(rows.filter { $0.provider == "xai" }.count, 1, "actual report wins")
            t.equal(rows.first { $0.provider == "xai" }?.isUnavailable, false)
            t.equal(rows.first { $0.provider == "openai" }?.isUnavailable, true)
            t.equal(
                rows.first { $0.provider == "openai" }?.availability?.reason,
                .reauthRequired
            )
        }

        t.test("quotas: quota measurement timestamp is authoritative") {
            let nested = try decode(
                QuotaReport.self,
                #"{"provider":"openai","label":"OpenAI","source":"test","updatedAt":1000,"quota":{"updatedAt":1784915090763}}"#
            )
            t.equal(nested.freshnessDate, QuotaReport.date(from: 1784915090763))
        }

        t.test("quotas: a custom-window-only quota uses its own label") {
            let json = report(provider: "p", label: "P", quota: #"{"updatedAt":1,"customWindows":[{"label":"5h","percent":12,"resetAt":1784928599718}]}"#)
            let normalized = try decode(QuotaReport.self, json).normalized()
            t.equal(normalized.windowLabel, "5h")
            t.equal(normalized.percent, 12)
        }

        // Live kimi reports weeklyPercent AND fiveHourPercent; live cursor and
        // google-antigravity each carry two customWindows. Returning one window would
        // hide real quota pressure.
        t.test("quotas: kimi exposes both its five-hour and weekly windows") {
            let json = report(provider: "kimi", label: "Kimi", quota: #"{"updatedAt":1,"fiveHourPercent":22,"fiveHourResetAt":1784928599718,"weeklyPercent":61,"weeklyResetAt":1785265199718}"#)
            let report = try decode(QuotaReport.self, json)
            let windows = report.normalizedWindows()
            t.equal(windows.count, 2)
            t.equal(windows.map(\.windowLabel), ["5h", "week"])
            // The compact row prefers the longer horizon.
            t.equal(report.normalized().windowLabel, "week")
            t.equal(report.normalized().percent, 61)
        }

        t.test("quotas: multiple custom windows are all retained") {
            let json = report(provider: "cursor", label: "Cursor", quota: #"{"updatedAt":1,"monthlyPercent":10,"monthlyResetAt":1785256304000,"customWindows":[{"label":"First-party models","percent":4,"resetAt":1785256304000},{"label":"API usage","percent":1,"resetAt":1785256304000}]}"#)
            let report = try decode(QuotaReport.self, json)
            let windows = report.normalizedWindows()
            t.equal(windows.count, 3)
            t.equal(windows.map(\.windowLabel), ["month", "First-party models", "API usage"])
            t.equal(report.normalized().windowLabel, "month")
        }

        t.test("quotas: a provider with only custom windows still normalizes") {
            let json = report(provider: "google-antigravity", label: "Google", quota: #"{"updatedAt":1,"customWindows":[{"label":"Gem","percent":30,"resetAt":1785256304000},{"label":"Cla","percent":12,"resetAt":1785256304000}]}"#)
            let report = try decode(QuotaReport.self, json)
            t.equal(report.normalizedWindows().count, 2)
            t.equal(report.normalized().windowLabel, "Gem")
            t.equal(report.normalized().percent, 30)
        }

        // Every window can stop work. A provider at 99% of a five-hour limit is blocked
        // right now even if its monthly usage is 10%; picking the longer horizon would
        // paint that row green while the user cannot make a request.
        t.test("quotas: the compact row shows the window under the most pressure") {
            let json = report(provider: "kimi", label: "Kimi", quota: #"{"updatedAt":1,"fiveHourPercent":99,"fiveHourResetAt":1784928599718,"monthlyPercent":10,"monthlyResetAt":1785542400000}"#)
            let report = try decode(QuotaReport.self, json)
            t.equal(report.normalized().windowLabel, "5h")
            t.equal(report.normalized().percent, 99)
            t.equal(report.normalizedWindows().count, 2)
        }

        t.test("quotas: equal pressure breaks toward the longer horizon") {
            let json = report(provider: "p", label: "P", quota: #"{"updatedAt":1,"fiveHourPercent":50,"fiveHourResetAt":1784928599718,"weeklyPercent":50,"weeklyResetAt":1785265199718}"#)
            t.equal(try decode(QuotaReport.self, json).normalized().windowLabel, "week")
        }

        t.test("quotas: a less-pressured custom window does not outrank a measured one") {
            let json = report(provider: "p", label: "P", quota: #"{"updatedAt":1,"weeklyPercent":12,"weeklyResetAt":1785265199718,"customWindows":[{"label":"custom","percent":6,"resetAt":1785265199718}]}"#)
            let report = try decode(QuotaReport.self, json)
            t.equal(report.normalized().windowLabel, "week")
            t.equal(report.normalized().percent, 12)
        }

        t.test("quotas: a current empty quota normalizes to a nil percent") {
            let normalized = try decode(QuotaReport.self, report(provider: "p", label: "P", quota: #"{"updatedAt":1}"#)).normalized()
            t.isNil(normalized.percent, "percent")
            t.equal(normalized.hasPercent, false)
            t.isNil(normalized.resetAt, "resetAt")
        }

        t.test("quotas: OpenCode Go reference caps decode without inventing a percentage") {
            let json = """
            {"provider":"opencode-go","label":"OpenCode Go","updatedAt":1784915090763,
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
            {"provider":"opencode-go","label":"OpenCode Go","source":"test","updatedAt":1,"quota":{"updatedAt":1,"referenceWindows":[{
              "id":"five_hour","label":"5-hour","windowSeconds":18000,"publishedLimitUsd":12,"observedSpendUsd":0.3,
              "observedTokens":100,"observedRequests":2,"pricedRequests":1,
              "unpricedRequests":1,"unmeasuredRequests":0,"coverage":"complete"}]}}
            """
            let report = try decode(QuotaReport.self, json)
            t.equal(report.referenceWindows.first?.observationQuality, .partial)
        }

        t.test("providers: decodes the live list") {
            let json = """
            [{"name":"openai","adapter":"openai-responses","hasApiKey":false,
              "authMode":"forward","disabled":false,"quotaCapable":true,"codexAccountMode":"pool"},
             {"name":"anthropic","adapter":"anthropic","hasApiKey":false,
              "authMode":"oauth","disabled":true,"quotaCapable":true}]
            """
            let providers = try decode([ProviderSummary].self, json)
            t.equal(providers.count, 2)
            t.equal(providers[0].name, "openai")
            t.equal(providers[0].isEnabled, true)
            t.equal(providers[1].isEnabled, false)
        }

        t.test("providers: rejects partial summaries but keeps authMode optional") {
            let current = #"{"name":"custom","adapter":"openai-chat","hasApiKey":false,"disabled":false,"quotaCapable":false}"#
            t.equal(try decode(ProviderSummary.self, current).isEnabled, true)
            let requiredFragments = [
                ("adapter", ",\"adapter\":\"openai-chat\""),
                ("hasApiKey", ",\"hasApiKey\":false"),
                ("disabled", ",\"disabled\":false"),
                ("quotaCapable", ",\"quotaCapable\":false"),
            ]
            for (field, fragment) in requiredFragments {
                let partial = current.replacingOccurrences(of: fragment, with: "")
                t.expect(rejects(ProviderSummary.self, partial), "missing \(field) must be rejected")
            }
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
