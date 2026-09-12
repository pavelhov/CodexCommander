import AppKit
import Darwin
import MenuBarCore
import MenuBarUI

guard let root = Bundle.main.object(forInfoDictionaryKey: "QualificationRoot") as? String,
      let bundleID = Bundle.main.bundleIdentifier, bundleID.hasPrefix("org.ccx.u6."),
      root.hasPrefix("/"), URL(fileURLWithPath: root).resolvingSymlinksInPath().path == root,
      Bundle.main.bundleURL.resolvingSymlinksInPath().path == root + "/installed/CodexCommander.app",
      let identity = try? String(contentsOfFile: Bundle.main.bundlePath + "/Contents/Resources/runtime/src/identity.mjs"),
      identity.contains("\"" + bundleID + ".proxy\""), !identity.contains("\"com.codexcommander.proxy\"")
else { fputs("Refusing non-isolated updater qualification fixture\n", stderr); exit(64) }
for (key, value) in ["HOME": root + "/home", "CODEX_HOME": root + "/codex", "CODEXCOMMANDER_HOME": root + "/state", "TMPDIR": root + "/tmp", "CCX_DISABLE_COMPANION": "1"] { setenv(key, value, 1) }
func trace(_ text: String) {
    let line = "\(Date().timeIntervalSince1970) pid=\(getpid()) build=\(Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion")!) \(text)\n"
    let url = URL(fileURLWithPath: root + "/driver.log")
    if !FileManager.default.fileExists(atPath: url.path) { FileManager.default.createFile(atPath: url.path, contents: nil) }
    if let h = try? FileHandle(forWritingTo: url) { h.seekToEndOfFile(); h.write(Data(line.utf8)); try? h.close() }
}
let appInstanceLock: MenuAppInstanceLock?
switch MenuAppInstanceLock.acquire(at: URL(fileURLWithPath: root + "/tmp/fixture.instance.lock")) { case .acquired(let lock): appInstanceLock = lock; case .contended: trace("lock-contended"); exit(2); case .unavailable: trace("lock-unavailable"); exit(3) }
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = MainActor.assumeIsolated { AppDelegate() }
app.delegate = delegate
func buttons(_ view: NSView) -> [NSButton] { (view as? NSButton).map { [$0] } ?? view.subviews.flatMap { buttons($0) } }
var lastSnapshot = ""
let timer = Timer(timeInterval: 0.25, repeats: true) { _ in
    MainActor.assumeIsolated {
        let all = app.windows.filter { $0.isVisible }.flatMap { $0.contentView.map { buttons($0) } ?? [] }
        let snapshot = app.windows.map { "\($0.title):" + ($0.contentView.map { buttons($0).map(\.title).joined(separator: ",") } ?? "") }.joined(separator: "|")
        if snapshot != lastSnapshot { trace("windows " + snapshot); lastSnapshot = snapshot }
        let path = root + "/command"
        guard let command = try? String(contentsOfFile: path).trimmingCharacters(in: .whitespacesAndNewlines), !command.isEmpty else { return }
        if command == "check" { try? FileManager.default.removeItem(atPath: path); trace("action check"); delegate.perform(NSSelectorFromString("checkForUpdates:"), with: nil) }
        else if command == "show" { try? FileManager.default.removeItem(atPath: path); trace("action show"); delegate.perform(NSSelectorFromString("togglePopover")) }
        else if command.hasPrefix("click:") {
            let name = String(command.dropFirst(6))
            if let button = all.first(where: { $0.title == name && $0.isEnabled }) {
                try? FileManager.default.removeItem(atPath: path); trace("action click " + name); button.performClick(nil)
            }
        }
    }
}
RunLoop.main.add(timer, forMode: .common)
#if arch(arm64)
trace("launch cpu=arm64")
#elseif arch(x86_64)
trace("launch cpu=x86_64")
#else
#error("Unsupported qualification architecture")
#endif
app.run()
