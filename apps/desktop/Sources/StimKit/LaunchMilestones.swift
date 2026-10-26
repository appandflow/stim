import Foundation

/// Logs the first time the app reaches each launch milestone, with the time since the process started.
@MainActor public enum LaunchMilestones {
  private static var reached: Set<String> = []

  public static func reach(_ name: String, _ detail: @autoclosure () -> String = "") {
    guard reached.insert(name).inserted else { return }
    let elapsed = Int(Date().timeIntervalSince(processStart) * 1000)
    let extra = detail()
    DebugLog.info(.app, "launch milestone \(name) +\(elapsed)ms\(extra.isEmpty ? "" : " \(extra)")")
  }

  private static let processStart: Date = {
    var info = kinfo_proc()
    var size = MemoryLayout<kinfo_proc>.stride
    var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
    guard sysctl(&mib, u_int(mib.count), &info, &size, nil, 0) == 0 else { return Date() }
    let start = info.kp_proc.p_un.__p_starttime
    return Date(timeIntervalSince1970: Double(start.tv_sec) + Double(start.tv_usec) / 1_000_000)
  }()
}
