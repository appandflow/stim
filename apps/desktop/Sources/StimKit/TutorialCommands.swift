import Foundation

public func tutorialAsk(
  _ template: String, tourPath: String?, repository: String?, second: String? = nil,
  existing: Set<String>? = nil
) -> String {
  let base = repository ?? "~/stim-tutorial"
  let worktrees = [tourPath, second].compactMap { $0 }.filter { existing?.contains($0) ?? true }
    .joined(separator: " and ")
  let values = [
    "base": base, "tour": tourPath ?? "the first worktree",
    "worktrees": worktrees.isEmpty ? "(there are none, so there is nothing to remove)" : worktrees,
  ]
  let pattern = try! NSRegularExpression(pattern: #"\{(base|tour|worktrees)\}"#)
  var result = template
  for match in pattern.matches(in: template, range: NSRange(template.startIndex..., in: template)).reversed() {
    let key = String(template[Range(match.range(at: 1), in: template)!])
    guard let value = values[key] else { continue }
    result.replaceSubrange(Range(match.range, in: result)!, with: value)
  }
  return result
}
