import Foundation

/// A `stim-server setup` command another machine printed, pasted into Stim Desktop on the machine it asks to use.
public struct SetupRequest: Equatable, Sendable {
  public enum Problem: Error, Equatable, Sendable {
    case notASetupCommand
    case noTicket
    case badExpiry
    case noCapability
    /// An option Desktop does not apply; the command runs as printed only in a terminal.
    case unsupported(String)

    public var message: String {
      switch self {
      case .notASetupCommand: return "Paste the whole stim-server setup command the other machine shows."
      case .noTicket: return "The command has no setup ticket. Copy the whole command again, starting at STIM_SETUP_TICKET=."
      case .badExpiry: return "The command's --expires is not a time. Copy the whole command again."
      case .noCapability: return "The command asks for nothing: it needs --build or --device-host."
      case .unsupported(let option):
        return "Stim Desktop approves only --build and --device-host. Run this command in Terminal for \(option)."
      }
    }
  }

  public var ticket: SetupTicket
  /// `--expires` exactly as printed, which stim-server checks again.
  public var expires: String
  public var capabilities: [SetupCapability]

  /// Reads the command Stim Desktop's Build or Run Simulators There wizard, `stim remote add` or `stim doctor --fix`
  /// prints for a Mac: `STIM_SETUP_TICKET=<ticket>`, then `stim-server setup` with `--expires` and the capabilities,
  /// over one line or several joined by a trailing backslash.
  public static func parse(_ text: String) throws(Problem) -> SetupRequest {
    let tokens = text.replacingOccurrences(of: "\\\n", with: " ").split(whereSeparator: \.isWhitespace).map(String.init)
    guard let setup = tokens.indices.first(where: { $0 > 0 && tokens[$0] == "setup" && tokens[$0 - 1].hasSuffix("stim-server") })
    else { throw .notASetupCommand }
    let prefix = "STIM_SETUP_TICKET="
    guard let ticket = tokens[..<setup].first(where: { $0.hasPrefix(prefix) }).map({ String($0.dropFirst(prefix.count)) }),
      ticket.count == 43, ticket.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") })
    else { throw .noTicket }
    var expires: String?
    var capabilities: Set<SetupCapability> = []
    var index = setup + 1
    while index < tokens.count {
      let token = tokens[index]
      switch token {
      case "--expires" where index + 1 < tokens.count:
        expires = tokens[index + 1]
        index += 1
      case "--expires": throw .badExpiry
      case "--build": capabilities.insert(.build)
      case "--device-host": capabilities.insert(.deviceHost)
      default: throw .unsupported(token)
      }
      index += 1
    }
    guard let expires, let date = Self.date(expires) else { throw .badExpiry }
    guard !capabilities.isEmpty else { throw .noCapability }
    return SetupRequest(
      ticket: SetupTicket(value: ticket, expiresAt: date), expires: expires,
      capabilities: SetupCapability.allCases.filter(capabilities.contains))
  }

  private static func date(_ text: String) -> Date? {
    let formatter = ISO8601DateFormatter()
    if let date = formatter.date(from: text) { return date }
    formatter.formatOptions.insert(.withFractionalSeconds)
    return formatter.date(from: text)
  }
}

/// What `stim-server setup` reported when Desktop approved a request on this machine.
public struct SetupApprovalResult: Decodable, Equatable, Sendable {
  public struct Grant: Decodable, Equatable, Sendable {
    public struct Client: Decodable, Equatable, Sendable {
      public var name: String
      public init(name: String) { self.name = name }
    }
    public var capability: SetupCapability
    public var id: String
    public var client: Client

    public init(capability: SetupCapability, id: String, client: Client) {
      self.capability = capability
      self.id = id
      self.client = client
    }
  }

  public var granted: [Grant]
  public var warnings: [String]
  /// Setup's exit code: 0 ready, 1 refused or failed, 2 nothing approved before expiry, 3 approved with gaps.
  public var exitCode: Int = 0

  enum CodingKeys: String, CodingKey { case granted, warnings }

  public init(granted: [Grant], warnings: [String], exitCode: Int) {
    self.granted = granted
    self.warnings = warnings
    self.exitCode = exitCode
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    granted = try container.decodeIfPresent([Grant].self, forKey: .granted) ?? []
    warnings = try container.decodeIfPresent([String].self, forKey: .warnings) ?? []
  }
}

public enum SetupAnswer: String, Sendable {
  case approve, refuse, skip
}

/// Runs `stim-server setup` for `request` in this machine's own server, which asks each grant through `onProgress`
/// instead of a terminal, until setup ends. Only the connection of the Stim Desktop that started the server may.
/// Cancelling withdraws the request: setup drops the ticket unless the requesting machine already spent it.
@MainActor public func runSetupApproval(
  _ request: SetupRequest, client: ServerClient?,
  onProgress: @escaping @MainActor (SetupJournal, SetupCapability?) -> Void
) async throws -> SetupApprovalResult {
  try Task.checkCancellation()
  guard let client, client.hasDesktopAuthority, case .open(let hello) = client.state else {
    throw ServerError(code: "not-connected", message: "Stim Desktop's stim-server is not ready. Try again.")
  }
  guard hello.features?.contains("desktop-setup") == true else {
    throw ServerError(code: "unsupported", message: "Update Stim Desktop to approve other machines here.")
  }
  let (events, continuation) = AsyncThrowingStream<ServerEvent, Error>.makeStream()
  let unsubscribe = try client.subscribeAction(
    "desktop.setup.subscribe",
    params: [
      "ticket": .string(request.ticket.value), "expires": .string(request.expires),
      "capabilities": .array(request.capabilities.map { .string($0.rawValue) }),
    ]
  ) { continuation.yield($0) }
  defer { Task { try? await unsubscribe() } }
  return try await withTaskCancellationHandler {
    for try await event in events {
      try Task.checkCancellation()
      switch event.name {
      case "desktop-setup-progress":
        guard let value = event.fields["journal"] else { continue }
        let journal = try decodeReporting(SetupJournal.self, from: value, source: .server)
        onProgress(journal, event.fields["asking"]?.string.flatMap(SetupCapability.init(rawValue:)))
      case "desktop-setup-ended":
        guard let exit = event.fields["exitCode"]?.number.flatMap(ServerProtocol.exactInteger) else {
          throw ServerError(code: "bad-response", message: "Invalid setup result from stim-server.")
        }
        var result =
          (try? decodeReporting(SetupApprovalResult.self, from: event.fields["output"] ?? .null, source: .server))
          ?? SetupApprovalResult(granted: [], warnings: [], exitCode: exit)
        result.exitCode = exit
        return result
      case "error":
        if case .object(let error)? = event.fields["error"] {
          throw ServerError(code: error["code"]?.string ?? "unknown", message: error["message"]?.string ?? "Setup failed.")
        }
        throw ServerError(code: "bad-response", message: "The setup stream failed without an error.")
      default: continue
      }
    }
    throw CancellationError()
  } onCancel: {
    continuation.finish(throwing: CancellationError())
  }
}

/// What every Add path ends on: who the connection is with, which way it goes, what it allows and how to end it.
public struct ConnectionConfirmation: Equatable, Sendable {
  public enum Direction: Equatable, Sendable {
    case usingThisMachine, thisMachineUses

    public var title: String { self == .usingThisMachine ? "Using this machine" : "This machine uses" }
  }

  public var name: String
  public var direction: Direction
  public var access: [ConnectionAccess]
  /// Where to revoke it, in words.
  public var revoke: String
  /// The commands that revoke it, run on the machine `revoke` names.
  public var revokeCommands: [String]

  /// A phone or machine this machine now lets in, with the record ids `stim-server devices revoke` takes here.
  public static func incoming(name: String, access: [ConnectionAccess], ids: [String]) -> ConnectionConfirmation {
    ConnectionConfirmation(
      name: name, direction: .usingThisMachine, access: ConnectionAccess.ordered(access),
      revoke: "Revoke it in Settings > Connections > Using this machine, or run on this machine:",
      revokeCommands: ids.map { "stim-server devices revoke \($0)" })
  }

  /// A machine this machine now uses. Removing it here never revokes it there, so the commands run on that machine.
  public static func outgoing(name: String, access: [ConnectionAccess], ids: [String]) -> ConnectionConfirmation {
    ConnectionConfirmation(
      name: name, direction: .thisMachineUses, access: ConnectionAccess.ordered(access),
      revoke:
        "Remove it in Settings > Connections > This machine uses. That forgets it here only; to revoke it on \(name) too, run there:",
      revokeCommands: ids.map { "stim-server devices revoke \($0)" })
  }
}

extension ConnectionConfirmation {
  /// A phone or machine that just paired with this machine's server.
  public static func pairing(_ device: PairedDevice) -> ConnectionConfirmation {
    .incoming(
      name: device.name, access: device.capabilities.compactMap(ConnectionAccess.init(capability:)), ids: [device.id])
  }

  /// Another machine's server this machine just paired with to view or control its work.
  public static func paired(_ server: PairedServer) -> ConnectionConfirmation {
    .outgoing(
      name: server.name.isEmpty ? "the machine" : server.name,
      access: server.capabilities.compactMap(ConnectionAccess.init(capability:)),
      ids: PairedServerWording.plainDeviceID(server.deviceID).map { [$0] } ?? [])
  }
}
