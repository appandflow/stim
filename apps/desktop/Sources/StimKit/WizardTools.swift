import Foundation

/// One row of the wizard's Tools step. A row blocks Next only when the chosen capability cannot work at all;
/// every other problem is a warning that names its consequence.
public struct WizardTool: Equatable, Identifiable, Sendable {
  public enum State: Equatable, Sendable {
    case checking, ok
    case missing(String)
    case mismatch(String)
    case busy, notNeeded
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
  public var onThisMac = false
  public var blocks = false
  public var consequence: String?
}

private let androidCodes: Set<String> = ["jdk", "android-sdk", "ndk", "build-tools", "compile-sdk"]

public func toolsReport(
  journal: SetupJournal?, status: BuildMachineStatus?, capabilities: Set<SetupCapability>, android: Bool = false,
  findings: [DoctorReport.Finding] = []
) -> [WizardTool] {
  let builds = capabilities.contains(.build)
  let hosts = capabilities.contains(.deviceHost)
  let machine = status?.machine ?? "the build Mac"
  func fix(code: String, reason: String, step: SetupJournal.Step? = nil) -> String {
    let finding = status.flatMap { status in
      findings.first { $0.code == "build-machine-\(code)" && $0.title.hasPrefix("Remote Mac \(status.machine) ") }
    }
    return step?.fix ?? finding?.fix
      ?? (isLocal(code, reason) ? "Check this problem on this Mac." : "Check this problem on the build Mac.")
  }
  func isLocal(_ code: String, _ reason: String) -> Bool {
    code == "checkout" || (code == "jdk" && reason.contains("none here"))
  }
  func isMissing(_ reason: String) -> Bool {
    reason.hasPrefix("no ") || reason.contains("none") || reason.contains("null") || reason.contains("undefined")
  }
  let definitions: [(String, String, String)] =
    [
      ("xcode", "Xcode", "Xcode"), ("runtime", "iOS simulator runtime", "iOS runtime"),
      ("cocoapods", "CocoaPods / Bundler", "CocoaPods"), ("stim-build", "Stim build (matches this Mac)", "Stim build"),
      ("jdk", "Java (JDK)", "JDK"), ("android-sdk", "Android SDK", "Android SDK"),
    ]
    + (android && builds
      ? [("ndk", "NDK", "NDK"), ("build-tools", "Build-tools", "Build-tools"), ("compile-sdk", "Compile SDK", "Compile SDK")]
      : [])
  var rows = definitions.map { code, title, journalTitle -> WizardTool in
    let isAndroid = androidCodes.contains(code)
    let needed = isAndroid || code == "cocoapods" ? builds : true
    let step = journal?.steps.first { $0.id == "tools.\(journalTitle)" }
    guard needed else {
      return WizardTool(id: code, title: title, detail: "Not needed for hosted simulators", state: .notNeeded)
    }
    let codes: Set<String> =
      code == "xcode" ? ["xcode", "simulator-sdk", "macos-sdk"] : code == "cocoapods" ? ["cocoapods", "bundler"] : [code]
    let problems = status?.problems?.filter { codes.contains($0.code) } ?? []
    if !problems.isEmpty {
      let missing = problems.contains { isMissing($0.reason) }
      var row = WizardTool(id: code, title: title, detail: problems.map(\.reason).joined(separator: "\n"), state: .ok)
      row.onThisMac = problems.contains { isLocal($0.code, $0.reason) }
      if code == "cocoapods", let pods = cocoapodsAdvice(problems: problems, machine: machine) {
        row.detail = pods.detail
        row.consequence = pods.consequence
        row.state = .mismatch(pods.fix)
        return row
      }
      let fixes = problems.map { fix(code: $0.code, reason: $0.reason, step: step) }
      let fix = fixes.enumerated().filter { fixes.firstIndex(of: $0.element) == $0.offset }.map(\.element)
        .joined(separator: "\n")
      row.state = missing ? .missing(fix) : .mismatch(fix)
      (row.blocks, row.consequence) = policy(code: code, missing: missing, builds: builds, hosts: hosts)
      return row
    }
    if isAndroid, let step {
      var row = WizardTool(id: code, title: title, detail: nil, state: .ok)
      if step.state != .ok {
        row.state = .missing(step.fix ?? "Install it on \(machine).")
        row.detail = "Needed only for Android builds"
        row.consequence = "Android builds stay on this Mac."
      }
      return row
    }
    if status?.state == .approved, status?.offloadable != nil {
      return WizardTool(id: code, title: title, detail: nil, state: .ok)
    }
    guard let step, step.state == .ok || step.fix != nil else {
      guard builds else {
        return WizardTool(
          id: code, title: title, detail: "Checked when a hosted simulator starts", state: .notNeeded)
      }
      return WizardTool(id: code, title: title, detail: nil, state: .checking, blocks: !isAndroid)
    }
    if step.state == .ok { return WizardTool(id: code, title: title, detail: nil, state: .ok) }
    var row = WizardTool(id: code, title: title, detail: nil, state: .missing(step.fix!))
    (row.blocks, row.consequence) = policy(code: code, missing: true, builds: builds, hosts: hosts)
    if isAndroid { row.detail = "Needed only for Android builds" }
    return row
  }
  for problem in status?.problems ?? []
  where builds && ["arch", "checkout", "busy", "disk", "unreachable"].contains(problem.code) {
    var row = WizardTool(
      id: problem.code, title: problem.code == "busy" ? "Build Mac is busy" : "Build readiness", detail: problem.reason,
      state: problem.code == "busy" ? .busy : .missing(fix(code: problem.code, reason: problem.reason)),
      onThisMac: isLocal(problem.code, problem.reason))
    if problem.code == "arch" || problem.code == "unreachable" {
      row.blocks = true
    } else if problem.code != "busy" {
      row.consequence = "Builds fall back to this Mac until this is fixed."
    }
    rows.append(row)
  }
  if let status, builds, status.state != .approved {
    rows.append(
      WizardTool(
        id: "access", title: "Build Mac access", detail: status.detail,
        state: .missing("Check approval and stim-server on the build Mac"), blocks: true))
  }
  if builds, status?.offloadable == false, (status?.problems ?? []).isEmpty {
    rows.append(
      WizardTool(
        id: "unavailable", title: "Build readiness", detail: status?.reasons?.joined(separator: "\n"), state: .checking))
  }
  return rows
}

/// Whether a tool problem stops the chosen capability from working at all, and otherwise what it costs.
private func policy(code: String, missing: Bool, builds: Bool, hosts: Bool) -> (blocks: Bool, consequence: String?) {
  switch code {
  case "stim-build":
    return builds ? (true, "The build Mac refuses builds until it runs this Mac's Stim build.") : (false, nil)
  case "xcode":
    return missing ? (true, nil) : (false, "Builds may differ, and the build cache is not shared between the two Macs.")
  case "runtime":
    if missing, hosts { return (true, nil) }
    return (false, missing ? "iOS builds stay on this Mac." : "Builds may differ from this Mac's.")
  case _ where androidCodes.contains(code):
    return (false, "Android builds stay on this Mac.")
  default:
    return (false, "Builds fall back to this Mac until this is fixed.")
  }
}

/// A different global CocoaPods only matters to projects that do not pin CocoaPods with Bundler: `stim doctor`
/// compares the global `pod --version` only for those, and checks for Bundler on the build Mac for the others.
private func cocoapodsAdvice(problems: [BuildMachineStatus.Problem], machine: String) -> (
  detail: String, consequence: String, fix: String
)? {
  if let bundler = problems.first(where: { $0.code == "bundler" }) {
    return (
      bundler.reason, "Projects that pin CocoaPods in their Gemfile build on this Mac until Bundler is installed there.",
      "On \(machine), on the PATH stim-server uses:\ngem install bundler"
    )
  }
  guard let reason = problems.first(where: { $0.code == "cocoapods" })?.reason,
    let match = reason.wholeMatch(of: /CocoaPods (\S+) there, (\S+) here/)
  else { return nil }
  let there = String(match.1)
  let here = String(match.2)
  guard there != "null", there != "undefined", here != "null", here != "undefined" else {
    return (
      "Global CocoaPods: \(there == "null" || there == "undefined" ? "none" : there) on \(machine), \(here == "null" || here == "undefined" ? "none" : here) here.",
      "Projects that pin CocoaPods in their Gemfile are not affected. Other projects build on this Mac.",
      "Pin it in the project:\nbundle add cocoapods\nbundle install"
    )
  }
  return (
    "Global CocoaPods differs: \(there) on \(machine), \(here) here.",
    "Projects that pin CocoaPods in their Gemfile use that version on both Macs. Other projects build on this Mac until the global versions match.",
    "Pin it in the project:\nbundle add cocoapods --version \(here)\nbundle install\nOr match the global version on \(machine), on the PATH stim-server uses:\ngem install cocoapods -v \(here)"
  )
}

public func wizardFixIsCommand(_ fix: String) -> Bool {
  let commands = [
    "sudo", "brew", "gem", "bundle", "xcodebuild", "xcode-select", "sdkmanager", "stim", "stim-server", "npx", "npm",
  ]
  return !fix.contains("\n") && !fix.contains("`") && !fix.contains("<")
    && commands.contains(String(fix.split(separator: " ").first ?? ""))
}
