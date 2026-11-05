import Foundation

public enum TutorialIssues {
  /// The workspace issues a step shows. Info issues never block a step. Finish and Delete stop the workspaces, so
  /// a warning there is an expected side effect of stopping; only an error, which can refuse the stop or removal,
  /// shows. Get the Test App and Watch on Your Phone do not use the tutorial workspace.
  public static func shown(_ issues: [StatusIssue], step: String?) -> [StatusIssue] {
    switch step {
    case "begin", "phone", nil: return []
    case "finish", "delete": return issues.filter { $0.severity == "error" }
    default: return issues.filter { $0.severity != "info" }
    }
  }

  /// `stim status` messages are lowercase fragments; the panel shows them as sentences.
  public static func sentence(_ message: String) -> String {
    let trimmed = message.trimmingCharacters(in: .whitespaces)
    guard let first = trimmed.first else { return trimmed }
    let capitalized = first.uppercased() + trimmed.dropFirst()
    return [".", "!", "?"].contains(capitalized.last) ? capitalized : capitalized + "."
  }
}
