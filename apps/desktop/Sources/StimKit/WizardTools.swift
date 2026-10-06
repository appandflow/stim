import Foundation

public struct WizardTool: Equatable, Identifiable, Sendable {
  public enum State: Equatable, Sendable {
    case checking, ok
    case missing(String)
    case mismatch(String)
    case busy, notNeeded
    public var blocks: Bool {
      switch self {
      case .checking, .missing, .mismatch: return true
      default: return false
      }
    }
    public var fix: String? {
      switch self {
      case .missing(let fix), .mismatch(let fix): return fix
      default: return nil
      }
    }
  }
  public var id: String
  public var title: String
  public var detail: String?
  public var state: State
}

public func toolsReport(
  journal: SetupJournal?, status: BuildMachineStatus?, capabilities: Set<SetupCapability>, android: Bool = false
) -> [WizardTool] {
  let definitions: [(String, String, String)] =
    [
      ("xcode", "Xcode", "Xcode"), ("runtime", "iOS simulator runtime", "iOS runtime"),
      ("cocoapods", "CocoaPods / Bundler", "CocoaPods"), ("stim-build", "Stim build (matches this Mac)", "Stim build"),
      ("jdk", "Java (JDK)", "JDK"), ("android-sdk", "Android SDK", "Android SDK"),
    ]
    + (android
      ? [("ndk", "NDK", "NDK"), ("build-tools", "Build-tools", "Build-tools"), ("compile-sdk", "Compile SDK", "Compile SDK")]
      : [])
  let androidCodes: Set<String> = ["jdk", "android-sdk", "ndk", "build-tools", "compile-sdk"]
  var rows = definitions.map { code, title, journalTitle in
    let needed =
      androidCodes.contains(code)
      ? android && capabilities.contains(.build) : code != "cocoapods" || capabilities.contains(.build)
    let step = journal?.steps.first { $0.id == "tools.\(journalTitle)" }
    guard needed else {
      return WizardTool(
        id: code, title: title,
        detail: androidCodes.contains(code) ? "not needed (Android builds off)" : "not needed for hosted simulators",
        state: .notNeeded)
    }
    let codes: Set<String> =
      code == "xcode" ? ["xcode", "simulator-sdk", "macos-sdk"] : code == "cocoapods" ? ["cocoapods", "bundler"] : [code]
    let problems = status?.problems?.filter { codes.contains($0.code) } ?? []
    if !problems.isEmpty {
      let fixes = problems.map { step?.fix ?? toolFix(code: $0.code, reason: $0.reason, detail: step?.detail) }
      let missing = problems.contains {
        $0.reason.hasPrefix("no ") || $0.reason.contains("none") || $0.reason.contains("null") || $0.reason.contains("undefined")
      }
      let fix = fixes.enumerated().filter { fixes.firstIndex(of: $0.element) == $0.offset }.map(\.element)
      return WizardTool(
        id: code, title: title, detail: problems.map(\.reason).joined(separator: "\n"),
        state: missing ? .missing(fix.joined(separator: "\n")) : .mismatch(fix.joined(separator: "\n")))
    }
    if status?.state == .approved, status?.offloadable != nil {
      return WizardTool(id: code, title: title, detail: nil, state: .ok)
    }
    return WizardTool(
      id: code, title: title, detail: step?.detail, state: step?.state == .ok ? .ok : step?.fix.map { .missing($0) } ?? .checking)
  }
  for problem in status?.problems ?? []
  where capabilities.contains(.build) && ["arch", "checkout", "busy", "disk", "unreachable"].contains(problem.code) {
    rows.append(
      WizardTool(
        id: problem.code, title: problem.code == "busy" ? "Build Mac is busy" : "Build readiness", detail: problem.reason,
        state: problem.code == "busy" ? .busy : .missing(toolFix(code: problem.code, reason: problem.reason, detail: nil))))
  }
  if let status, capabilities.contains(.build), status.state != .approved {
    rows.append(
      WizardTool(
        id: "access", title: "Build Mac access", detail: status.detail,
        state: .missing("Check approval and stim-server on the build Mac")))
  }
  if capabilities.contains(.build), status?.offloadable == false, (status?.problems ?? []).isEmpty {
    rows.append(
      WizardTool(id: "unavailable", title: "Build readiness", detail: status?.reasons?.joined(separator: "\n"), state: .checking))
  }
  return rows
}

private func toolFix(code: String, reason: String, detail: String?) -> String {
  switch code {
  case "xcode", "simulator-sdk", "macos-sdk":
    let local = reason.components(separatedBy: " there, ").last?.replacingOccurrences(of: " here", with: "") ?? detail ?? ""
    let version = local.range(of: "[0-9]+\\.[0-9]+(?:\\.[0-9]+)?", options: .regularExpression).map { String(local[$0]) }
    return "Install Xcode\(version.map { " " + $0 } ?? "") from the App Store, then run `sudo xcodebuild -runFirstLaunch`"
  case "runtime": return "xcodebuild -downloadPlatform iOS"
  case "cocoapods": return "brew install cocoapods"
  case "bundler": return "gem install bundler"
  case "jdk": return "brew install --cask zulu@17"
  case "android-sdk": return "Install Android Studio, or set ANDROID_HOME"
  case "ndk", "build-tools", "compile-sdk": return "install it with sdkmanager there"
  case "stim-build": return "Install This Mac's Build"
  case "arch": return "Use a Mac with the same CPU"
  case "checkout": return "Run Stim from a git checkout"
  case "disk": return "Free disk space on the build Mac"
  default: return "Check stim-server on the build Mac"
  }
}
