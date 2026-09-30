import Foundation

/// A Claude Code or Codex session associated with a workspace, from `stim status --json` `agents` while it runs, or
/// `endedAgents` after it stopped, which alone carries `endedAt`. `openUrl` opens it in the tool's desktop app; status
/// sets it only when that app is installed on this Mac.
public struct AgentSession: Decodable, Hashable, Sendable, Identifiable {
  public var tool: String
  public var sessionId: String
  public var title: String?
  public var cwd: String
  public var startedAt: String?
  public var lastActiveAt: String?
  public var pid: Int?
  public var openUrl: String?
  public var webUrl: String?
  public var endedAt: String?

  public var id: String { "\(tool):\(sessionId)" }

  public var toolName: String {
    switch tool {
    case "claude-code": "Claude Code"
    case "codex": "Codex"
    default: tool
    }
  }

  /// "Claude Code \u{00B7} Fix the login bug": the tool and the title when there is one.
  public var label: String {
    [toolName, title].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " \u{00B7} ")
  }

  /// A workspace's sessions, running or ended, earliest started first, so the first is the session that created or
  /// first worked in the workspace and stays first as processes start and stop. Sessions without `startedAt` follow, in
  /// `tool:sessionId` order. `apps/mobile/src/lib/agents.ts` holds the same rule; both replay
  /// `Tests/StimKitTests/Fixtures/agent-sessions-vectors.json`.
  public static func associated(agents: [AgentSession]?, endedAgents: [AgentSession]?) -> [AgentSession] {
    ((agents ?? []) + (endedAgents ?? [])).sorted { a, b in
      let (aStart, bStart) = (a.startedAt.flatMap(date), b.startedAt.flatMap(date))
      if aStart != bStart {
        guard let aStart else { return false }
        guard let bStart else { return true }
        return aStart < bStart
      }
      return a.id < b.id
    }
  }

  /// `openUrl` when it is a Claude desktop or Codex app link; any other scheme is ignored.
  public var openURL: URL? {
    guard let text = openUrl, let url = URL(string: text), ["claude", "codex"].contains(url.scheme) else { return nil }
    return url
  }

  public var openHelp: String { "Open this session in \(tool == "codex" ? "Codex" : "Claude")" }

  private static func date(_ text: String) -> Date? {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.date(from: text) ?? ISO8601DateFormatter().date(from: text)
  }
}
