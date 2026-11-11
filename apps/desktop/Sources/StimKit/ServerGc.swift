import Foundation

/// The GC JSON report or refusal, exit status and human summary from the private server.
public struct ServerGcResult: Sendable {
  public let exitStatus: Int32
  public let stdout: Data
  public let message: String
}

/// Runs GC through the same-home bundled server. Cancellation awaits cleanup acknowledgement;
/// reconnect never repeats a mutation whose dispatch may already have happened.
@MainActor public func runServerGc(
  _ command: StimCommand, stimHome: String, connection: (client: ServerClient, home: String)?,
  onLine: @escaping @MainActor (OutputLine) -> Void = { _ in }
) async throws -> ServerGcResult {
  try Task.checkCancellation()
  let client = try desktopActionServer(connection, stimHome: stimHome, action: "clean up this Stim home")
  guard case .open(let hello) = client.state, hello.desktopApi == ServerProtocol.desktopApi else {
    throw ServerError(code: "unsupported", message: "Update stim-server to run cleanup from Desktop.")
  }
  guard command.program == "stim", command.arguments.first == "gc" else {
    throw ServerError(code: "bad-request", message: "Unsupported Desktop cleanup command.")
  }
  var json = false
  var params: [String: JSONValue] = ["cwd": .string(command.cwd)]
  let method: String
  if let item = GcItem(arguments: command.arguments) {
    json = true
    method = "desktop.gc.item.subscribe"
    params["item"] = item.params
  } else {
    method = "desktop.gc.subscribe"
    var dryRun = false
    var seen: Set<String> = []
    var index = 1
    while index < command.arguments.count {
      let option = command.arguments[index]
      guard seen.insert(option).inserted else {
        throw ServerError(code: "bad-request", message: "Repeated Desktop cleanup option.")
      }
      switch option {
      case "--json": json = true
      case "--dry-run": dryRun = true
      case "--pressure":
        index += 1
        guard index < command.arguments.count, ["normal", "high", "critical"].contains(command.arguments[index]) else {
          throw ServerError(code: "bad-request", message: "Pressure must be normal, high or critical.")
        }
        params["pressure"] = .string(command.arguments[index])
      default: throw ServerError(code: "bad-request", message: "Unsupported Desktop cleanup option.")
      }
      index += 1
    }
    params["dryRun"] = .bool(dryRun)
  }
  let (events, continuation) = AsyncThrowingStream<ServerEvent, Error>.makeStream()
  var terminal: ServerEvent?
  let unsubscribe = try client.subscribeAction(
    method, params: params,
    onCancellationEvent: { event in
      if event.name == "desktop-gc-ended" { terminal = event }
    },
    onEvent: { event in
      if event.name == "desktop-gc-ended" { terminal = event }
      continuation.yield(event)
    })
  func result(_ event: ServerEvent) throws -> ServerGcResult {
    guard let exit = event.fields["exitCode"]?.number, exit == 0 || exit == 1,
      let stdout = event.fields["stdout"]?.string, let message = event.fields["message"]?.string
    else { throw ServerError(code: "bad-response", message: "Invalid cleanup result from stim-server.") }
    let data = Data(stdout.utf8)
    if exit == 0 {
      guard let payload = try? JSONDecoder().decode(JSONValue.self, from: data), case .object(let fields) = payload,
        let mode = fields["mode"]?.string, ["dry-run", "delete"].contains(mode)
      else { throw ServerError(code: "bad-response", message: "Invalid cleanup report from stim-server.") }
      if fields["mode"]?.string == "dry-run" {
        guard case .object? = fields["sections"] else {
          throw ServerError(code: "bad-response", message: "Invalid cleanup report from stim-server.")
        }
      }
    }
    if json, !stdout.isEmpty { onLine(OutputLine(.stdout, stdout.trimmingCharacters(in: .newlines))) }
    if !message.isEmpty, !json || exit != 0 { onLine(OutputLine(exit == 0 ? .stdout : .stderr, message)) }
    return ServerGcResult(exitStatus: Int32(exit), stdout: data, message: message)
  }
  defer { Task { try? await unsubscribe() } }
  do {
    return try await withTaskCancellationHandler {
      for try await event in events {
        try Task.checkCancellation()
        switch event.name {
        case "desktop-gc-progress":
          guard let message = event.fields["message"]?.string,
            let stream = event.fields["stream"]?.string, stream == "stdout" || stream == "stderr"
          else { throw ServerError(code: "bad-response", message: "Invalid cleanup progress from stim-server.") }
          let channel: OutputChannel = stream == "stdout" && !json ? .stdout : .stderr
          for line in message.split(separator: "\n", omittingEmptySubsequences: true) {
            onLine(OutputLine(channel, String(line)))
          }
        case "desktop-gc-ended": return try result(event)
        case "error":
          if case .object(let error)? = event.fields["error"] {
            throw ServerError(code: error["code"]?.string ?? "unknown", message: error["message"]?.string ?? "Cleanup failed.")
          }
          throw ServerError(code: "bad-response", message: "The cleanup stream failed without an error.")
        default: continue
        }
      }
      throw CancellationError()
    } onCancel: {
      continuation.finish(throwing: CancellationError())
    }
  } catch {
    try await unsubscribe()
    if error is CancellationError, let terminal, terminal.fields["exitCode"]?.number == 1 { return try result(terminal) }
    throw error
  }
}

/// One cleanup a single Storage or Processes row runs through `desktop.gc.item.subscribe`. Desktop carries it as
/// the internal `gc --json --item <kind> ...` argument list; no CLI runs that form.
public enum GcItem: Hashable, Sendable {
  case cache(dir: String)
  case workspaceOutputs
  case archive(id: String, part: RetainedKind?)
  case watchman
  case gradleDaemons

  public var arguments: [String] {
    let tail: [String]
    switch self {
    case .cache(let dir): tail = ["cache", dir]
    case .workspaceOutputs: tail = ["workspace-outputs"]
    case .archive(let id, let part): tail = ["archive", id] + (part.map { [$0.rawValue] } ?? [])
    case .watchman: tail = ["watchman"]
    case .gradleDaemons: tail = ["gradle-daemons"]
    }
    return ["gc", "--json", "--item"] + tail
  }

  public func command(cwd: String) -> StimCommand { StimCommand(arguments, cwd: cwd) }

  public init?(arguments: [String]) {
    guard arguments.count >= 4, Array(arguments.prefix(3)) == ["gc", "--json", "--item"] else { return nil }
    let rest = Array(arguments.dropFirst(4))
    switch (arguments[3], rest.count) {
    case ("cache", 1) where !rest[0].isEmpty: self = .cache(dir: rest[0])
    case ("workspace-outputs", 0): self = .workspaceOutputs
    case ("archive", 1) where !rest[0].isEmpty: self = .archive(id: rest[0], part: nil)
    case ("archive", 2) where !rest[0].isEmpty:
      guard let part = RetainedKind(rawValue: rest[1]) else { return nil }
      self = .archive(id: rest[0], part: part)
    case ("watchman", 0): self = .watchman
    case ("gradle-daemons", 0): self = .gradleDaemons
    default: return nil
    }
  }

  var params: JSONValue {
    switch self {
    case .cache(let dir): return .object(["kind": .string("cache"), "dir": .string(dir)])
    case .workspaceOutputs: return .object(["kind": .string("workspace-outputs")])
    case .archive(let id, let part):
      var item: [String: JSONValue] = ["kind": .string("archive"), "id": .string(id)]
      if let part { item["part"] = .string(part.rawValue) }
      return .object(item)
    case .watchman: return .object(["kind": .string("watchman")])
    case .gradleDaemons: return .object(["kind": .string("gradle-daemons")])
    }
  }
}
