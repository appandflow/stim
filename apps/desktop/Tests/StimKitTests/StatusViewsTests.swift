import Foundation
import Testing

@testable import StimKit

private func json(_ text: String) -> JSONValue {
  (try? JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))) ?? .null
}

private func fields(_ text: String) -> [String: JSONValue] {
  guard case .object(let fields) = json(text) else { return [:] }
  return fields
}

private func workspace(_ path: String, errors: Int = 0) -> String {
  """
  {"path":"\(path)","live":false,"warnings":[],"issues":[],"memoryMb":0,"logs":{"errorsSinceMarker":\(errors)}}
  """
}

private func decoded(_ views: StatusViews) throws -> StatusPayload {
  try JSONDecoder().decode(StatusPayload.self, from: JSONEncoder().encode(views.payload()))
}

@Test func `a snapshot and the deltas after it rebuild the workspace list in server order`() throws {
  var views = StatusViews()
  let snapshot = """
    {"seq":0,"snapshot":{"workspaces":[\(workspace("/w/a")),\(workspace("/w/b"))],
    "worktrees":[{"path":"/w/loose","branch":"loose"}],"archived":{"count":0,"bytes":0,"newest":[]}}}
    """
  #expect(views.applyWorkspaces(fields(snapshot)) == .changed)
  #expect(
    views.applyWorkspaces(
      fields(#"{"seq":1,"workspaces":{"upsert":["# + workspace("/w/a", errors: 2) + "," + workspace("/w/c")
        + #"],"remove":["/w/b"]}}"#)) == .changed)
  #expect(views.applyWorkspaces(fields(#"{"seq":2,"worktrees":{"upsert":[],"remove":["/w/loose"]}}"#)) == .changed)

  let payload = try decoded(views)
  #expect(payload.environments.map(\.path) == ["/w/a", "/w/c"])
  #expect(payload.environments.first?.logs?.errorsSinceMarker == 2)
  #expect(payload.unprovisionedWorktrees == [])
}

@Test func `a missing event is reported as a gap and leaves the list as it was`() throws {
  var views = StatusViews()
  _ = views.applyWorkspaces(
    fields(#"{"seq":0,"snapshot":{"workspaces":["# + workspace("/w/a") + #"],"worktrees":[],"archived":{}}}"#))
  #expect(views.applyWorkspaces(fields(#"{"seq":2,"workspaces":{"upsert":[],"remove":["/w/a"]}}"#)) == .gap)
  #expect(try decoded(views).environments.map(\.path) == ["/w/a"])
  #expect(
    views.applyWorkspaces(
      fields(#"{"seq":0,"snapshot":{"workspaces":[],"worktrees":[],"archived":{}}}"#)) == .changed)
  #expect(try decoded(views).environments.isEmpty)
}

@Test func `a followed workspace shows its full environment until it is no longer followed`() throws {
  var views = StatusViews()
  _ = views.applyWorkspaces(
    fields(#"{"seq":0,"snapshot":{"workspaces":["# + workspace("/w/a") + #"],"worktrees":[],"archived":{}}}"#))
  let full = json(workspace("/w/a", errors: 7))
  #expect(views.setDetail(full, for: "/w/a") == .changed)
  #expect(views.setDetail(full, for: "/w/a") == .unchanged)
  #expect(try decoded(views).environments.first?.logs?.errorsSinceMarker == 7)
  #expect(views.setDetail(nil, for: "/w/a") == .changed)
  #expect(try decoded(views).environments.first?.logs?.errorsSinceMarker == 0)
}

@Test func `the machine view and the archives fill the rest of the payload`() throws {
  var views = StatusViews()
  _ = views.applyWorkspaces(
    fields(#"{"seq":0,"snapshot":{"workspaces":[],"worktrees":[],"archived":{"count":1,"bytes":1,"newest":[]}}}"#))
  let machine = """
    {"seq":0,"machine":{"capacity":{"liveCount":1,"committedMb":10,"totalMemoryMb":100,"overCapacity":false},
    "machine":null,"deviceLeases":[],"simctlAvailable":true,"maintenance":null}}
    """
  #expect(views.applyMachine(fields(machine)) == .changed)
  let archive = """
    {"id":"a","projectRoot":"/w/a","project":"a","workspace":"a--0","worktree":{},"removedAt":"2026-10-01T00:00:00Z",
    "removedBy":"gc","builds":{"count":0,"last":null,"lastErrorCount":0},"agents":[],
    "bytes":{"logs":0,"recordings":0,"agentActions":0,"record":1,"total":1},"expires":{},"version":1}
    """
  views.setArchives(
    [json(archive)],
    usage: json(#"{"count":1,"bytes":1,"byKind":{"logs":0,"recordings":0,"agentActions":0,"record":1}}"#))

  let payload = try decoded(views)
  #expect(payload.capacity?.liveCount == 1)
  #expect(payload.archived?.map(\.id) == ["a"])
  #expect(payload.archivedUsage?.count == 1)
}
