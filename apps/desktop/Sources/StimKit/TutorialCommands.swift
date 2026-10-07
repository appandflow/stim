import Foundation

public func tutorialCommands(
  _ lines: [String], tourPath: String?, repository: String?, stateDir: String?, machine: String?
) -> String {
  let base = repository ?? "~/stim-tutorial"
  let values = [
    "base": base, "tour": tourPath ?? "\(base)-tour",
    "stateDir": stateDir ?? "<agentDevice.stateDir>", "machine": machine ?? "<approved machine>",
  ]
  let pattern = try! NSRegularExpression(pattern: #"\{(base|tour|stateDir|machine)\}"#)
  let source = lines.joined(separator: "\n")
  var result = source
  for match in pattern.matches(in: source, range: NSRange(source.startIndex..., in: source)).reversed() {
    let key = String(source[Range(match.range(at: 1), in: source)!])
    let range = Range(match.range, in: result)!
    result.replaceSubrange(range, with: shellDoubleQuotedValue(values[key]!))
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
