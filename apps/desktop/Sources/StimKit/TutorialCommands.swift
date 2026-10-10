import Foundation

public func tutorialCommands(
  _ lines: [String], tourPath: String?, repository: String?, stateDir: String?, udid: String? = nil,
  second: String? = nil
) -> String {
  let base = repository ?? "~/stim-tutorial"
  return fillTutorial(
    lines.joined(separator: "\n"),
    [
      "base": base, "tour": tourPath ?? "<first worktree>",
      "stateDir": stateDir ?? "<agentDevice.stateDir>",
      "udid": udid ?? "<ios.udid>", "second": second ?? "<second worktree>",
    ], shellDoubleQuotedValue)
}

public func tutorialAsk(
  _ template: String, tourPath: String?, repository: String?, second: String? = nil,
  existing: Set<String>? = nil
) -> String {
  let base = repository ?? "~/stim-tutorial"
  let worktrees = [tourPath, second].compactMap { $0 }.filter { existing?.contains($0) ?? true }
    .joined(separator: " and ")
  return fillTutorial(
    template,
    [
      "base": base, "tour": tourPath ?? "the first worktree",
      "worktrees": worktrees.isEmpty ? "(there are none, so there is nothing to remove)" : worktrees,
    ], { $0 })
}

private func fillTutorial(_ source: String, _ values: [String: String], _ format: (String) -> String) -> String {
  let pattern = try! NSRegularExpression(pattern: #"\{(base|tour|second|worktrees|stateDir|udid)\}"#)
  var result = source
  for match in pattern.matches(in: source, range: NSRange(source.startIndex..., in: source)).reversed() {
    let key = String(source[Range(match.range(at: 1), in: source)!])
    guard let value = values[key] else { continue }
    result.replaceSubrange(Range(match.range, in: result)!, with: format(value))
  }
  return result
}

private func shellDoubleQuotedValue(_ value: String) -> String {
  let literal = value.hasPrefix("~/") ? String(value.dropFirst(2)) : value
  let escaped = literal.replacingOccurrences(of: "\\", with: "\\\\")
    .replacingOccurrences(of: "\"", with: "\\\"")
    .replacingOccurrences(of: "$", with: "\\$")
    .replacingOccurrences(of: "`", with: "\\`")
  return value.hasPrefix("~/") ? "$HOME/" + escaped : escaped
}
