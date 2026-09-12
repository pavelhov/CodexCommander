import MenuBarCore

/// State-machine regressions; real Sparkle replacement is a separate two-bundle proof.
enum UpdateSuite {
    static func run(_ t: TestRunner) {
        t.test("update: startup remains blocked until reconciliation") {
            var c = UpdateCoordinator()
            t.equal(c.mayRunOrdinaryStartup, false)
            t.equal(c.receiveOffer(target: "2", stage: .notDownloaded), false)
            c.reconcileStartup(installerDisarmed: false)
            t.equal(c.phase, .uncertain)
            t.equal(c.mayRunOrdinaryStartup, false)
        }
        t.test("update: prepared and durable armed transitions precede exactly one Install") {
            var c = fresh()
            t.expect(c.receiveOffer(target: "2", stage: .notDownloaded), "offer accepted")
            let token = c.beginPreparation()!
            t.equal(c.installationArmed(generation: token), false)
            t.equal(c.phase, .preparing)
            t.equal(c.preparationCompleted(generation: token, verified: true), true)
            t.equal(c.installationArmed(generation: token), true)
            t.equal(c.installationArmed(generation: token), false)
            t.equal(c.phase, .armed)
        }
        t.test("update: Later before preparation permits restoration only after prior disarm") {
            var c = fresh()
            c.receiveOffer(target: "2", stage: .notDownloaded)
            c.cancel()
            t.equal(c.mayRestoreAfterCancellation, true)
            t.equal(c.beginPreparation(), nil)
        }
        t.test("update: failed preparation never arms") {
            var c = fresh()
            c.receiveOffer(target: "2", stage: .notDownloaded)
            let token = c.beginPreparation()!
            t.equal(c.preparationCompleted(generation: token, verified: false), false)
            t.equal(c.installationArmed(generation: token), false)
            t.equal(c.mayRestoreAfterCancellation, true)
        }
        t.test("update: cancellation invalidates an in-flight preparation reply") {
            var c = fresh()
            c.receiveOffer(target: "2", stage: .notDownloaded)
            let token = c.beginPreparation()!
            c.cancel()
            t.equal(c.preparationCompleted(generation: token, verified: true), false)
            t.equal(c.installationArmed(generation: token), false)
        }
        t.test("update: dismissal during preparation invalidates later completion") {
            var c = fresh()
            c.receiveOffer(target: "2", stage: .notDownloaded)
            let token = c.beginPreparation()!
            c.installerSessionEnded()
            t.equal(c.preparationCompleted(generation: token, verified: true), false)
            t.equal(c.installationArmed(generation: token), false)
            t.equal(c.phase, .uncertain)
        }
        t.test("update: failed preparation cleanup remains visibly guarded") {
            var c = fresh()
            c.receiveOffer(target: "2", stage: .notDownloaded)
            let token = c.beginPreparation()!
            c.preparationCompleted(generation: token, verified: false)
            c.requireRecovery()
            t.equal(c.phase, .uncertain)
            t.equal(c.mayRestoreAfterCancellation, false)
        }
        t.test("update: preexisting installing offer cannot infer disarm from Later") {
            var c = fresh()
            c.receiveOffer(target: "2", stage: .installing)
            c.cancel()
            t.equal(c.phase, .uncertain)
            t.equal(c.mayRestoreAfterCancellation, false)
        }
        t.test("update: cancellation and nil session completion after forwarding stay uncertain") {
            var c = fresh()
            c.receiveOffer(target: "2", stage: .notDownloaded)
            let token = c.beginPreparation()!
            c.preparationCompleted(generation: token, verified: true)
            c.installationArmed(generation: token)
            c.cancel()
            c.installerSessionEnded()
            t.equal(c.phase, .uncertain)
            t.equal(c.mayRestoreAfterCancellation, false)
        }
        t.test("update: safe recovery reoffers while keeping ordinary startup blocked") {
            var c = UpdateCoordinator()
            c.reconcileStartup(installerDisarmed: false)
            t.equal(c.receiveOffer(target: "2", stage: .installing), true)
            t.equal(c.mayRunOrdinaryStartup, false)
            let token = c.beginPreparation()!
            c.preparationCompleted(generation: token, verified: true)
            t.equal(c.installationArmed(generation: token), true)
        }
    }

    private static func fresh() -> UpdateCoordinator {
        var c = UpdateCoordinator()
        c.reconcileStartup(installerDisarmed: true)
        return c
    }
}
