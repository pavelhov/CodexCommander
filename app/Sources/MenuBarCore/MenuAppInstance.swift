import Foundation
import Darwin

public enum MenuAppInstancePolicy {
    public static func existingProcess(
        currentPID: Int32,
        runningPIDs: [Int32]
    ) -> Int32? {
        runningPIDs.first { $0 > 0 && $0 != currentPID }
    }
}

public enum MenuAppInstanceLockResult {
    case acquired(MenuAppInstanceLock)
    case contended
    case unavailable
}

/// Atomic process-wide guard held for the menu app lifetime.
///
/// LaunchServices normally reuses one app instance, but login and a manual open can
/// arrive together. A nonblocking advisory lock in the protected per-user temp
/// directory closes that race before either process touches login or proxy state.
public final class MenuAppInstanceLock {
    private var descriptor: Int32

    private init(descriptor: Int32) { self.descriptor = descriptor }

    deinit { release() }

    public static func acquire(
        at url: URL = FileManager.default.temporaryDirectory
            .appendingPathComponent("com.codexcommander.menubar.instance.lock")
    ) -> MenuAppInstanceLockResult {
        let descriptor = open(
            url.path,
            O_CREAT | O_RDWR | O_CLOEXEC | O_NOFOLLOW,
            S_IRUSR | S_IWUSR
        )
        guard descriptor >= 0 else { return .unavailable }
        _ = fchmod(descriptor, S_IRUSR | S_IWUSR)
        guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
            let code = errno
            close(descriptor)
            return code == EWOULDBLOCK ? .contended : .unavailable
        }
        return .acquired(MenuAppInstanceLock(descriptor: descriptor))
    }

    public func release() {
        guard descriptor >= 0 else { return }
        _ = flock(descriptor, LOCK_UN)
        close(descriptor)
        descriptor = -1
    }
}
