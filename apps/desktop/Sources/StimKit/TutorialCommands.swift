import Foundation

public func tutorialCommands(
  _ lines: [String], tourPath: String?, repository: String?, stateDir: String?, machine: String?, udid: String? = nil
) -> String {
  let base = repository ?? "~/stim-tutorial"
  return fillTutorial(
    lines.joined(separator: "\n"),
    [
      "base": base, "tour": tourPath ?? "\(base)-tour",
      "stateDir": stateDir ?? "<agentDevice.stateDir>", "machine": machine ?? "<approved machine>",
      "udid": udid ?? "<ios.udid>",
    ], shellDoubleQuotedValue)
}

public func tutorialAsk(_ template: String, tourPath: String?, repository: String?, machine: String?) -> String {
  let base = repository ?? "~/stim-tutorial"
  return fillTutorial(
    template,
    ["base": base, "tour": tourPath ?? "\(base)-tour", "machine": machine ?? "my approved Mac"],
    { $0 })
}

private func fillTutorial(_ source: String, _ values: [String: String], _ format: (String) -> String) -> String {
  let pattern = try! NSRegularExpression(pattern: #"\{(base|tour|stateDir|machine|udid)\}"#)
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
