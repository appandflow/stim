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
private func makeStore() -> StatusStore {
  let cli = Task { StimCLI(environment: ["PATH": "/nonexistent"]) }
  return StatusStore(cli: cli)
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

  private func doctorWorkspace() throws -> URL {
    let directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
      .appendingPathComponent(".doctor-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    return directory
  }

  private func doctorPayload(_ directory: URL) throws -> StatusPayload {
    let data = try JSONSerialization.data(withJSONObject: [
      "environments": [["path": directory.path, "repository": directory.path, "live": false, "warnings": []]]
    ])
    return try JSONDecoder().decode(StatusPayload.self, from: data)
  }

  @Test func doctorReadsTheMatchingServerWithoutCLIAndKeepsLastGoodOnFailure() async throws {
    let directory = try doctorWorkspace()
    defer { try? FileManager.default.removeItem(at: directory) }
    let cli = Task { StimCLI(environment: ["PATH": "/nonexistent", "STIM_HOME": directory.path]) }
    let store = StatusStore(cli: cli, stimHome: directory.path)
    var socket: IdentityTransport!
    let client = ServerClient(
      endpoint: URL(fileURLWithPath: "/tmp/doctor-test.sock"), clientName: "test", clientVersion: "1",
      transport: { _, onEvent in
        let transport = IdentityTransport(home: "test-home", onEvent: onEvent, features: ["desktop-reports"])
        socket = transport
        return transport
      })
    defer { client.stop() }
    client.start()
    #expect(await until { client.isOpen })
    store.useServer((client, directory.appendingPathComponent("other").path))
    store.accept(.success(try doctorPayload(directory)))
    #expect(await until { store.payload != nil })
    await settle()
    #expect(socket.doctorRequests.isEmpty)

    store.useServer((client, directory.path))
    store.accept(.success(try doctorPayload(directory)))
    #expect(await until { socket.doctorRequests.count == 1 })
    socket.answerDoctor(0, title: "First report")
    #expect(await until { store.doctor[directory.path]?.value?.findings.first?.title == "First report" })
    store.accept(.success(try doctorPayload(directory)))
    await settle()
    #expect(socket.doctorRequests.count == 1)

    store.doctorChanged(in: directory.path)
    #expect(await until { socket.doctorRequests.count == 2 })
    socket.answerDoctor(1, error: "Probe failed")
    #expect(await until { store.doctor[directory.path]?.error == "Probe failed" })
    #expect(store.doctor[directory.path]?.value?.findings.first?.title == "First report")
    store.doctorChanged(in: directory.path)
    #expect(await until { socket.doctorRequests.count == 3 })
    socket.answerDoctor(2, title: "Recovered report")
    #expect(await until { store.doctor[directory.path]?.value?.findings.first?.title == "Recovered report" })
    #expect(store.doctor[directory.path]?.error == nil)
  }

  @Test func anActionDuringDoctorDiscardsTheEarlierReplyAndRefreshesAgain() async throws {
    let directory = try doctorWorkspace()
    defer { try? FileManager.default.removeItem(at: directory) }
    let cli = Task { StimCLI(environment: ["PATH": "/nonexistent", "STIM_HOME": directory.path]) }
    let store = StatusStore(cli: cli, stimHome: directory.path)
    var socket: IdentityTransport!
    let client = ServerClient(
      endpoint: URL(fileURLWithPath: "/tmp/doctor-test.sock"), clientName: "test", clientVersion: "1",
      transport: { _, onEvent in
        let transport = IdentityTransport(home: "test-home", onEvent: onEvent, features: ["desktop-reports"])
        socket = transport
        return transport
      })
    defer { client.stop() }
    client.start()
    #expect(await until { client.isOpen })
    store.useServer((client, directory.path))
    store.accept(.success(try doctorPayload(directory)))
    #expect(await until { socket.doctorRequests.count == 1 })
    store.doctorChanged(in: directory.path)
    #expect(await until { socket.doctorRequests.count == 2 })
    socket.answerDoctor(0, title: "Before action")
    await settle()
    #expect(store.doctor[directory.path]?.value == nil)
    socket.answerDoctor(1, title: "After action")
    #expect(await until { store.doctor[directory.path]?.value?.findings.first?.title == "After action" })
    store.accept(.success(try doctorPayload(directory)))
    await settle()
    #expect(socket.doctorRequests.count == 2)
  }

  @Test func unchangedProjectsDoNotPublishAndNewReportedAndResolvedProjectsPublishTogether() async throws {
    let store = makeStore()
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

  @Test func aWorkspacesProjectFollowsItsFolderAppearingAndDisappearing() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("refresh-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: root) }
    let app = root.appendingPathComponent("apps/mobile").path
    let store = makeStore()
    func show(_ live: Int) async throws {
      let data = try JSONSerialization.data(withJSONObject: [
        "environments": [["path": app, "live": false, "warnings": [], "memoryMb": 0]],
        "capacity": ["liveCount": live, "committedMb": 0, "totalMemoryMb": 0, "overCapacity": false],
      ])
      store.accept(.success(try JSONDecoder().decode(StatusPayload.self, from: data)))
      #expect(await until { store.payload?.capacity?.liveCount == live })
    }

    try await show(1)
    #expect(store.projects[app] == Project(fallbackFor: app))

    try FileManager.default.createDirectory(atPath: app, withIntermediateDirectories: true)
    let git = Process()
    git.executableURL = URL(fileURLWithPath: "/usr/bin/git")
    git.arguments = ["init", "-q", root.path]
    try git.run()
    git.waitUntilExit()
    try await show(2)
    #expect(await until { store.projects[app]?.root == (root.path as NSString).resolvingSymlinksInPath })

    try FileManager.default.removeItem(at: root)
    try await show(3)
    #expect(await until { store.projects[app] == Project(fallbackFor: app) })
  }

  @Test func aFailedServerReadKeepsThePayloadUntilTheNextSuccess() async {
    let store = makeStore()
    store.accept(.success(payload(live: 1)))
    #expect(await until { store.payload != nil })
    store.accept(.failure(Failed()))
    #expect(store.error == "scripted failure")
    #expect(store.payload?.capacity?.liveCount == 1)
    store.accept(.success(payload(live: 2)))
    #expect(await until { store.payload?.capacity?.liveCount == 2 })
    #expect(store.error == nil)
  }

  @Test func aFailureIsNotClearedByAnEarlierPayloadStillResolvingProjects() async {
    let store = makeStore()
    store.accept(.success(payload(live: 1)))
    store.accept(.failure(Failed()))
    await settle()
    #expect(store.error == "scripted failure")
    #expect(store.payload == nil)
  }

  @Test func theSidebarFollowsEachNewPayloadAndOptionsChange() async {
    func worktrees(_ paths: [String]) -> StatusPayload {
      let rows = paths.map { #"{"path":"\#($0)","repository":"/repo"}"# }.joined(separator: ",")
      let json = #"{"environments":[],"unprovisionedWorktrees":[\#(rows)]}"#
      return try! JSONDecoder().decode(StatusPayload.self, from: Data(json.utf8))
    }
    let store = makeStore()
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
    let store = StatusStore(cli: Task { cli }, stimHome: "/home-a")
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

  @Test(arguments: [false, true]) func socketPathRefusalsShowTheRemedyOnlyForTheMatchingHome(matchingHome: Bool) async {
    let home = "/tmp/stim-status-test"
    let cli = Task { StimCLI(environment: ["PATH": "/nonexistent", "STIM_HOME": home]) }
    let store = StatusStore(cli: cli, stimHome: home)
    let client = ServerClient(
      endpoint: URL(fileURLWithPath: "/" + String(repeating: "x", count: 103)), clientName: "test", clientVersion: "1")
    defer { client.stop() }
    client.start()
    store.accept(.success(payload(live: 7)))
    #expect(await until { store.payload != nil })
    store.useServer((client, matchingHome ? home : home + "-other"))
    store.start()
    guard case .refused(let refusal) = client.state else {
      Issue.record("Expected the socket path to refuse the connection")
      return
    }
    #expect(store.error != nil)
    #expect((store.error == refusal.localizedDescription) == matchingHome)
    let shownError = store.error
    store.refresh()
    #expect(store.error == shownError)
    #expect(store.payload?.capacity?.liveCount == 7)
    #expect(!store.watching)
  }

  @Test func unavailableStatusNeverStartsACommandAndKeepsTheLastPayload() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("watch-\(UUID().uuidString)")
    let cli = try watchingCLI(in: directory)
    let store = StatusStore(cli: Task { cli })
    defer {
      store.serverDelivering(true)
      for pid in watcherPIDs(in: directory) { kill(pid, SIGKILL) }
      try? FileManager.default.removeItem(at: directory)
    }
    store.accept(.success(payload(live: 7)))
    #expect(await until { store.payload != nil })
    store.start()
    store.refresh()
    #expect(await until { store.error != nil })
    #expect(!store.watching)
    #expect(watcherPIDs(in: directory).isEmpty)
    #expect(store.payload?.capacity?.liveCount == 7)
  }

  private func pairedClient(_ host: String, memoryMb: Int, path: String, udid: String) -> ServerClient {
    ServerClient(
      endpoint: URL(string: "ws://\(host):7787")!, clientName: "test", clientVersion: "1",
      transport: { _, onEvent in
        PairedStatusTransport(
          workspace: .object([
            "path": .string(path), "live": .bool(true), "warnings": .array([]), "issues": .array([]),
            "memoryMb": .number(Double(memoryMb)),
            "ios": .object([
              "name": .string("stim-app (iPhone 17 26.0)"), "udid": .string(udid), "owned": .bool(true),
              "state": .string("Booted"),
            ]),
          ]), onEvent: onEvent)
      })
  }

  @Test func twoPairedServersAndThisMacReportingTheSamePathAndUDIDStayApart() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("owners-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: root) }
    let checkout = root.appendingPathComponent(".worktrees/app").path
    let git = Process()
    git.executableURL = URL(fileURLWithPath: "/usr/bin/git")
    git.arguments = ["init", "-q", checkout]
    try git.run()
    git.waitUntilExit()
    let store = makeStore()
    let local = try JSONDecoder().decode(
      StatusPayload.self,
      from: Data(
        #"{"environments":[{"path":"\#(checkout)","live":true,"warnings":[],"memoryMb":1,"ios":{"name":"stim-app (iPhone 17 26.0)","udid":"1A2B","owned":true,"state":"Booted"}}]}"#
          .utf8))
    store.accept(.success(local))
    #expect(await until { store.payload != nil })
    let floco = pairedClient("100.64.0.2", memoryMb: 2, path: checkout, udid: "1A2B")
    let mini = pairedClient("100.64.0.3", memoryMb: 3, path: checkout, udid: "1A2B")
    let socket = ServerClient(
      endpoint: URL(fileURLWithPath: "/tmp/stim/server/local.sock"), clientName: "test", clientVersion: "1",
      transport: { _, onEvent in IdentityTransport(home: "home", onEvent: onEvent) })
    for client in [floco, mini, socket] { client.start() }
    defer { for client in [floco, mini, socket] { client.stop() } }

    let clients = ["floco": floco, "mini": mini, "socket": socket]
    #expect(await until { floco.isOpen && mini.isOpen && socket.isOpen })
    store.usePairedServers(clients)
    #expect(await until { store.paired["floco"]?.delivering == true && store.paired["mini"]?.delivering == true })
    #expect(store.paired["socket"] == nil)

    let owned = store.ownedEnvironments
    #expect(owned.map(\.owner) == [.local, .paired("floco"), .paired("mini")])
    #expect(Set(owned.map(\.id)).count == 3)
    #expect(Set(owned.flatMap(\.devices).map(\.id)).count == 3)
    #expect(owned.flatMap(\.devices).map(\.localSimulatorUDID) == ["1A2B", nil, nil])
    for (owner, memory) in [(ServerOwner.local, 1), (.paired("floco"), 2), (.paired("mini"), 3)] {
      #expect(store.workspace(WorkspaceKey(owner: owner, path: checkout))?.workspace.memoryMb == memory)
    }
    #expect(store.paired["floco"]?.payload?.environments.first?.project == Project(root: root.path))
    #expect(await until { store.projects[checkout] != nil })
    #expect(store.projects[checkout] != Project(root: root.path))

    floco.stop()
    store.usePairedServers(clients)
    #expect(store.paired["floco"]?.delivering == false)
    #expect(store.workspace(WorkspaceKey(owner: .paired("floco"), path: checkout))?.workspace.memoryMb == 2)
    floco.start()
    #expect(await until { floco.isOpen })
    store.usePairedServers(clients)
    #expect(await until { store.paired["floco"]?.delivering == true })

    let replacement = pairedClient("100.64.0.2", memoryMb: 4, path: checkout, udid: "1A2B")
    defer { replacement.stop() }
    store.usePairedServers(["floco": replacement, "mini": mini])
    #expect(store.paired["floco"]?.delivering == false)
    #expect(store.workspace(WorkspaceKey(owner: .paired("floco"), path: checkout))?.workspace.memoryMb == 2)
    replacement.start()
    #expect(await until { replacement.isOpen })
    store.usePairedServers(["floco": replacement, "mini": mini])
    #expect(await until { store.workspace(WorkspaceKey(owner: .paired("floco"), path: checkout))?.workspace.memoryMb == 4 })

    store.usePairedServers(["mini": mini])
    #expect(store.paired["floco"] == nil)
    #expect(store.ownedEnvironments.map(\.owner) == [.local, .paired("mini")])
  }

}

@MainActor private final class IdentityTransport: ServerTransport {
  let home: String
  let features: [String]
  var doctorRequests: [(id: JSONValue, cwd: String)] = []
  let onEvent: @MainActor (ServerTransportEvent) -> Void

  init(home: String, onEvent: @escaping @MainActor (ServerTransportEvent) -> Void, features: [String] = []) {
    self.features = features
    self.home = home
    self.onEvent = onEvent
  }

  func close() {}

  func send(_ text: String) {
    guard case .object(let request)? = try? JSONDecoder().decode(JSONValue.self, from: Data(text.utf8)),
      let id = request["id"]
    else { return }
    if request["method"] == .string("desktop.reports.invalidate") {
      reply(id, .object([:]))
      return
    }
    if request["method"] == .string("desktop.reports.get"),
      case .object(let params) = request["params"], case .string(let cwd) = params["cwd"]
    {
      doctorRequests.append((id, cwd))
      return
    }
    guard request["method"] == .string("hello") else { return }
    let result: JSONValue = .object([
      "protocol": .number(1),
      "server": .object([
        "id": .string(home), "name": .string("Mac"), "version": .string("1"), "stim": .string("1"),
      ]),
      "capabilities": .array([.string("read")]),
      "features": .array(features.map(JSONValue.string)),
    ])
    reply(id, result)
  }

  func answerDoctor(_ index: Int, title: String = "", error: String? = nil) {
    let request = doctorRequests[index]
    let snapshot: [String: JSONValue] = [
      "pending": .bool(false),
      "value": .object([
        "project": .string(request.cwd),
        "findings": .array([.object(["level": .string("note"), "title": .string(title), "detail": .string("")])]),
      ]),
    ]
    if let error {
      let response: JSONValue = .object([
        "id": request.id, "error": .object(["code": .string("stim-failed"), "message": .string(error)]),
      ])
      guard let data = try? JSONEncoder().encode(response) else { return }
      onEvent(.text(String(decoding: data, as: UTF8.self)))
    } else {
      reply(request.id, .object(snapshot))
    }
  }

  private func reply(_ id: JSONValue, _ result: JSONValue) {
    guard let data = try? JSONEncoder().encode(JSONValue.object(["id": id, "result": result])) else { return }
    onEvent(.text(String(decoding: data, as: UTF8.self)))
  }
}

/// A paired server that reports one workspace and an idle machine.
@MainActor private final class PairedStatusTransport: ServerTransport {
  let workspace: JSONValue
  let onEvent: @MainActor (ServerTransportEvent) -> Void

  init(workspace: JSONValue, onEvent: @escaping @MainActor (ServerTransportEvent) -> Void) {
    self.workspace = workspace
    self.onEvent = onEvent
  }

  func close() {}

  func send(_ text: String) {
    guard case .object(let request)? = try? JSONDecoder().decode(JSONValue.self, from: Data(text.utf8)),
      let id = request["id"], case .string(let method)? = request["method"]
    else { return }
    switch method {
    case "hello":
      reply([
        "id": id,
        "result": .object([
          "protocol": .number(2),
          "server": .object(["name": .string("Mac"), "version": .string("1"), "stim": .string("1")]),
          "capabilities": .array([.string("read")]),
        ]),
      ])
    case "workspaces.subscribe":
      reply(["id": id, "result": .object(["subscription": .string("s1")])])
      event([
        "event": .string("workspaces"), "subscription": .string("s1"), "seq": .number(0),
        "snapshot": .object([
          "workspaces": .array([workspace]), "worktrees": .array([]),
          "archived": .object(["count": .number(0), "bytes": .number(0), "newest": .array([])]),
        ]),
      ])
    case "machine.subscribe":
      reply(["id": id, "result": .object(["subscription": .string("s2")])])
      event([
        "event": .string("machine"), "subscription": .string("s2"), "seq": .number(0),
        "machine": .object([
          "capacity": .object([
            "liveCount": .number(1), "committedMb": .number(0), "totalMemoryMb": .number(0),
            "overCapacity": .bool(false),
          ]),
          "machine": .null, "deviceLeases": .array([]), "simctlAvailable": .bool(true), "maintenance": .null,
        ]),
      ])
    default: break
    }
  }

  private func reply(_ message: [String: JSONValue]) {
    let text = String(decoding: try! JSONEncoder().encode(JSONValue.object(message)), as: UTF8.self)
    Task { @MainActor in self.onEvent(.text(text)) }
  }

  /// Sends a subscription's event once the client has read the reply that names the subscription.
  private func event(_ message: [String: JSONValue]) {
    let text = String(decoding: try! JSONEncoder().encode(JSONValue.object(message)), as: UTF8.self)
    Task { @MainActor in
      try? await Task.sleep(for: .milliseconds(50))
      self.onEvent(.text(text))
    }
  }
}
