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
      fields(
        #"{"seq":1,"workspaces":{"upsert":["# + workspace("/w/a", errors: 2) + "," + workspace("/w/c")
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

@Test func `the live views the server derives from a captured status decode as a status payload`() throws {
  let url = try #require(Bundle.module.url(forResource: "live-views", withExtension: "json", subdirectory: "Fixtures"))
  guard case .object(let events) = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url)),
    case .object(let list)? = events["workspaces"], case .object(let machine)? = events["machine"],
    case .object(let detail)? = events["workspace"], case .object(let environment)? = detail["environment"],
    let path = environment["path"]?.string
  else { throw CocoaError(.coderReadCorrupt) }
  var views = StatusViews()
  #expect(views.applyWorkspaces(list) == .changed)
  #expect(views.applyMachine(machine) == .changed)
  let summaries = try decoded(views)
  #expect(!summaries.environments.isEmpty)
  #expect(summaries.capacity != nil)
  #expect(summaries.oversight?.environments.count == summaries.environments.count)
  _ = views.setDetail(.object(environment), for: path)
  #expect(try decoded(views).environments.contains { $0.path == path && $0.logs?.dir != nil })
}

@Test func upsertsPastTheEntityLimitDropTheWorkspacesWhileRemovalsMakeRoom() throws {
  var views = StatusViews(limits: .init(entities: 3, bytes: 1_000_000))
  _ = views.applyWorkspaces(
    fields(
      #"{"seq":0,"snapshot":{"workspaces":["# + workspace("/w/a") + "," + workspace("/w/b") + #"],"worktrees":[],"archived":{}}}"#
    ))
  #expect(
    views.applyWorkspaces(
      fields(#"{"seq":1,"workspaces":{"upsert":["# + workspace("/w/c") + #"],"remove":["/w/a"]}}"#)) == .changed)
  #expect(
    views.applyWorkspaces(
      fields(#"{"seq":2,"worktrees":{"upsert":[{"path":"/w/x"},{"path":"/w/y"}],"remove":[]}}"#)) == .overflow)
  #expect(!views.hasWorkspaces)
  #expect(try decoded(views).environments.isEmpty)
  #expect(try decoded(views).unprovisionedWorktrees?.isEmpty == true)
}

@Test func aSnapshotPastTheByteLimitIsDroppedAndOneUnderItIsKept() throws {
  var views = StatusViews(limits: .init(entities: 100, bytes: 600))
  let padded = String(repeating: "x", count: 300)
  let snapshot = { (count: Int) in
    fields(
      #"{"seq":0,"snapshot":{"workspaces":["#
        + (0..<count).map { #"{"path":"/w/\#($0)","pad":"\#(padded)"}"# }.joined(separator: ",")
        + #"],"worktrees":[],"archived":{}}}"#)
  }
  #expect(views.applyWorkspaces(snapshot(1)) == .changed)
  #expect(views.applyWorkspaces(snapshot(2)) == .overflow)
  #expect(!views.hasWorkspaces)
}

@Test func viewsWithoutLimitsKeepEveryEntity() throws {
  var views = StatusViews()
  let paths = (0..<20_000).map { #"{"path":"/w/\#($0)"}"# }.joined(separator: ",")
  #expect(
    views.applyWorkspaces(fields(#"{"seq":0,"snapshot":{"workspaces":["# + paths + #"],"worktrees":[],"archived":{}}}"#))
      == .changed)
  #expect(views.hasWorkspaces)
}
