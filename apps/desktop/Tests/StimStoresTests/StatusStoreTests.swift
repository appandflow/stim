import Combine
import Foundation
import StimKit
import Testing

@testable import StimStores

private func payload(live: Int) -> StatusPayload {
  let json = #"{"environments":[],"capacity":{"liveCount":\#(live),"committedMb":0,"totalMemoryMb":0,"overCapacity":false}}"#
  return try! JSONDecoder().decode(StatusPayload.self, from: Data(json.utf8))
}

@MainActor
private func makeStore(_ fetches: Scripted<StatusPayload>) -> StatusStore {
  let cli = Task { StimCLI(environment: ["PATH": "/nonexistent"]) }
  return StatusStore(cli: cli, fetch: { try await fetches.call() })
}

@MainActor
struct StatusStoreTests {
  private func projectsPayload(_ rows: [[String: String]], live: Int = 0) throws -> StatusPayload {
    let data = try JSONSerialization.data(withJSONObject: [
      "environments": [], "unprovisionedWorktrees": rows,
      "capacity": ["liveCount": live, "committedMb": 0, "totalMemoryMb": 0, "overCapacity": false],
    ])
    return try JSONDecoder().decode(StatusPayload.self, from: data)
  }

  @Test func unchangedProjectsDoNotPublishAndNewReportedAndResolvedProjectsPublishTogether() async throws {
    let store = makeStore(Scripted<StatusPayload>())
    var publications: [[String: Project]] = []
    let subscription = store.$projects.sink { publications.append($0) }
    defer { subscription.cancel() }

    store.accept(.success(payload(live: 1)))
    #expect(await until { store.payload?.capacity?.liveCount == 1 })
    #expect(publications.count == 1)

    let known = ["path": "/known", "repository": "/one/app"]
    store.accept(.success(try projectsPayload([known, ["path": "/known", "repository": "/discarded"]], live: 2)))
    #expect(await until { store.payload?.capacity?.liveCount == 2 })
    #expect(publications.count == 2)
    #expect(store.projects["/known"]?.root == "/one/app")

    store.accept(.success(try projectsPayload([["path": "/known", "repository": "/changed"]], live: 3)))
    #expect(await until { store.payload?.capacity?.liveCount == 3 })
    #expect(publications.count == 2)
    #expect(store.projects["/known"]?.root == "/one/app")

    let unresolvedRoot = "/nonexistent-\(UUID().uuidString)"
    let unresolved = "\(unresolvedRoot)/.worktrees/new"
    store.accept(
      .success(
        try projectsPayload(
          [
            known, ["path": "/new", "repository": "/two/app"], ["path": unresolved],
          ], live: 4)))
    #expect(await until { store.payload?.capacity?.liveCount == 4 })
    #expect(publications.count == 3)
    #expect(publications.last?["/new"]?.root == "/two/app")
    #expect(publications.last?[unresolved] == Project(root: unresolvedRoot))
    #expect(store.title(of: Project(root: "/one/app")) == "app (one)")
    #expect(store.title(of: Project(root: "/two/app")) == "app (two)")
  }

  @Test func aStaleRefreshAddsNewProjectsWhileKeepingTheNewerPayloadAndProjectIdentity() async throws {
    let fetches = Scripted<StatusPayload>()
    let store = makeStore(fetches)
    store.refresh()
    #expect(await until { fetches.calls == 1 })
    store.accept(.success(try projectsPayload([["path": "/known", "repository": "/newer"]], live: 2)))
    #expect(await until { store.payload?.capacity?.liveCount == 2 })

    var publications: [[String: Project]] = []
    let subscription = store.$projects.sink { publications.append($0) }
    defer { subscription.cancel() }
    fetches.finish(
      0,
      .success(
        try projectsPayload(
          [
            ["path": "/known", "repository": "/older"], ["path": "/late", "repository": "/late-root"],
          ], live: 1)))
    #expect(await until { store.projects["/late"] != nil })
    #expect(publications.count == 2)
    #expect(store.projects["/known"]?.root == "/newer")
    #expect(store.projects["/late"]?.root == "/late-root")
    #expect(store.payload?.capacity?.liveCount == 2)
  }

  @Test func aRefreshThatFinishesAfterANewerWatchPayloadDoesNotReplaceIt() async {
    let fetches = Scripted<StatusPayload>()
    let store = makeStore(fetches)
    store.refresh()
    #expect(await until { fetches.calls == 1 })

    store.accept(.success(payload(live: 2)))
    #expect(await until { store.payload?.capacity?.liveCount == 2 })

    fetches.finish(0, .success(payload(live: 1)))
    await settle()
    #expect(store.payload?.capacity?.liveCount == 2)
  }

  @Test func aFailureOlderThanTheShownPayloadIsNotReported() async {
    let fetches = Scripted<StatusPayload>()
    let store = makeStore(fetches)
    store.refresh()
    #expect(await until { fetches.calls == 1 })
    store.accept(.success(payload(live: 2)))
    #expect(await until { store.payload != nil })

    fetches.finish(0, .failure(Failed()))
    await settle()
    #expect(store.error == nil)
    #expect(store.payload?.capacity?.liveCount == 2)
  }

  @Test func requestsDuringARefreshRunOneMoreAfterItAndNoMore() async {
    let fetches = Scripted<StatusPayload>()
    let store = makeStore(fetches)
    store.refresh()
    #expect(await until { fetches.calls == 1 })
    store.refresh()
    store.refresh()
    await settle()
    #expect(fetches.calls == 1)

    fetches.finish(0, .success(payload(live: 1)))
    #expect(await until { fetches.calls == 2 })
    fetches.finish(1, .success(payload(live: 5)))
    #expect(await until { store.payload?.capacity?.liveCount == 5 })
    await settle()
    #expect(fetches.calls == 2)

    store.refresh()
    #expect(await until { fetches.calls == 3 })
  }

  @Test func aFailedRefreshKeepsThePayloadAndReportsTheErrorUntilTheNextSuccess() async {
    let fetches = Scripted<StatusPayload>()
    let store = makeStore(fetches)
    store.refresh()
    #expect(await until { fetches.calls == 1 })
    fetches.finish(0, .success(payload(live: 1)))
    #expect(await until { store.payload != nil })

    store.refresh()
    #expect(await until { fetches.calls == 2 })
    fetches.finish(1, .failure(Failed()))
    #expect(await until { store.error == "scripted failure" })
    #expect(store.payload?.capacity?.liveCount == 1)

    store.refresh()
    #expect(await until { fetches.calls == 3 })
    fetches.finish(2, .success(payload(live: 2)))
    #expect(await until { store.payload?.capacity?.liveCount == 2 })
    #expect(store.error == nil)
  }

  @Test func theSidebarFollowsEachNewPayloadAndOptionsChange() async {
    func worktrees(_ paths: [String]) -> StatusPayload {
      let rows = paths.map { #"{"path":"\#($0)","repository":"/repo"}"# }.joined(separator: ",")
      let json = #"{"environments":[],"unprovisionedWorktrees":[\#(rows)]}"#
      return try! JSONDecoder().decode(StatusPayload.self, from: Data(json.utf8))
    }
    let store = makeStore(Scripted<StatusPayload>())
    var options = SidebarOptions()
    options.statuses = [.notSetUp]

    store.accept(.success(worktrees(["/repo-a"])))
    #expect(await until { store.payload != nil })
    #expect(store.sidebarList(options).map(\.path) == ["/repo-a"])

    store.accept(.success(worktrees(["/repo-a", "/repo-b"])))
    #expect(await until { store.payload?.unprovisionedWorktrees?.count == 2 })
    #expect(store.sidebarList(options).map(\.path) == ["/repo-a", "/repo-b"])
    #expect(store.sidebarTrees(options).flatMap(\.entries).map(\.path) == ["/repo-a", "/repo-b"])
    #expect(store.sidebarStatusCounts(options)[.notSetUp] == 2)

    options.statuses = [.live]
    #expect(store.sidebarList(options).isEmpty)
    #expect(store.sidebarStatusCounts(options)[.notSetUp] == 2)
  }

  @Test func sharedLinksRequireTheCurrentServerSnapshotAndLocalHome() async throws {
    let home = "871c7262-f6bc-469a-b822-15da928350ee"
    let workspace = "0123456789abcdef"
    let link = try #require(
      sharedWorkspaceRequest(
        from: URL(
          string:
            "https://stim.appandflow.com/open?v=1&machine=\(home)&workspace=\(workspace)")!))
    let cli = StimCLI(environment: ["PATH": "/nonexistent", "STIM_HOME": "/home-a"])
    let store = StatusStore(cli: Task { cli }, stimHome: "/home-a", fetch: { throw Failed() })
    let client = ServerClient(
      endpoint: URL(fileURLWithPath: "/tmp/stim/server/local.sock"), clientName: "test", clientVersion: "1",
      transport: { _, onEvent in IdentityTransport(home: home, onEvent: onEvent) })
    defer { client.stop() }
    client.start()
    #expect(await until { client.isOpen && store.stimHome == "/home-a" })
    let json =
      #"{"environments":[{"path":"/workspace","workspaceId":"\#(workspace)","live":false,"warnings":[],"issues":[],"memoryMb":0}]}"#
    let status = try JSONDecoder().decode(StatusPayload.self, from: Data(json.utf8))
    store.accept(.success(status), source: (client, client.generation))
    #expect(await until { store.target(for: link, connection: (client, "/home-a"))?.workspace.path == "/workspace" })
    #expect(store.target(for: link, connection: (client, "/home-b")) == nil)

    client.stop()
    client.start()
    #expect(await until { client.isOpen })
    #expect(store.payload?.environments.first?.path == "/workspace")
    #expect(store.target(for: link, connection: (client, "/home-a")) == nil)
    store.accept(.success(payload(live: 0)), source: (client, client.generation))
    #expect(await until { store.payload?.environments.isEmpty == true })
    #expect(store.target(for: link, connection: (client, "/home-a")) == nil)
    store.accept(.success(status), source: (client, client.generation))
    #expect(await until { store.target(for: link, connection: (client, "/home-a"))?.workspace.path == "/workspace" })
    store.accept(.success(payload(live: 1)))
    #expect(await until { store.payload?.capacity?.liveCount == 1 })
    #expect(store.target(for: link, connection: (client, "/home-a")) == nil)
  }

  private func watchingCLI(in directory: URL) throws -> StimCLI {
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let executable = directory.appendingPathComponent("stim")
    let script = """
      #!/bin/sh
      [ "$1" = status ] || exit 0
      echo $$ >> "$STIM_HOME/watchers"
      echo '{"environments":[]}'
      exec sleep 60
      """
    try Data(script.utf8).write(to: executable)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: executable.path)
    return StimCLI(environment: ["PATH": "/usr/bin:/bin", "STIM_HOME": directory.path], override: executable.path)
  }

  private func watcherPIDs(in directory: URL) -> [Int32] {
    let text = (try? String(contentsOf: directory.appendingPathComponent("watchers"), encoding: .utf8)) ?? ""
    return text.split(separator: "\n").compactMap { Int32($0) }
  }

  @Test func theStoreRunsNoWatcherOfItsOwnWhileTheServerDeliversStatusAndRunsOneAgainWhenItStops() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("watch-\(UUID().uuidString)")
    let cli = try watchingCLI(in: directory)
    let store = StatusStore(cli: Task { cli }, fetch: { throw Failed() })
    defer {
      store.serverDelivering(true)
      for pid in watcherPIDs(in: directory) { kill(pid, SIGKILL) }
      try? FileManager.default.removeItem(at: directory)
    }
    store.start()
    #expect(await until { watcherPIDs(in: directory).count == 1 && store.watching })
    let first = try #require(watcherPIDs(in: directory).first)

    store.serverDelivering(true)
    #expect(store.watching)
    #expect(await until { kill(first, 0) != 0 })
    try await Task.sleep(nanoseconds: 1_500_000_000)
    #expect(watcherPIDs(in: directory).count == 1)
    #expect(store.watching && store.error == nil)

    store.serverDelivering(false)
    #expect(await until { watcherPIDs(in: directory).count == 2 && store.watching })
  }
}

@MainActor private final class IdentityTransport: ServerTransport {
  let home: String
  let onEvent: @MainActor (ServerTransportEvent) -> Void

  init(home: String, onEvent: @escaping @MainActor (ServerTransportEvent) -> Void) {
    self.home = home
    self.onEvent = onEvent
  }

  func close() {}

  func send(_ text: String) {
    guard case .object(let request)? = try? JSONDecoder().decode(JSONValue.self, from: Data(text.utf8)),
      request["method"] == .string("hello"), let id = request["id"]
    else { return }
    let result: JSONValue = .object([
      "protocol": .number(1),
      "server": .object([
        "id": .string(home), "name": .string("Mac"), "version": .string("1"), "stim": .string("1"),
      ]),
      "capabilities": .array([.string("read")]),
    ])
    guard let data = try? JSONEncoder().encode(JSONValue.object(["id": id, "result": result])) else { return }
    onEvent(.text(String(decoding: data, as: UTF8.self)))
  }
}
