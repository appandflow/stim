import Foundation

/// One access level a connection holds, in the words every connection row uses.
public enum ConnectionAccess: String, CaseIterable, Sendable {
  case view
  case control
  case build
  case runDevices = "run-devices"
  case test
  case shareLink = "share-link"

  public var title: String {
    switch self {
    case .view: return "View"
    case .control: return "Control"
    case .build: return "Build"
    case .runDevices: return "Run devices"
    case .test: return "Test"
    case .shareLink: return "Share link"
    }
  }

  /// Build, Run devices and Test run another machine's code, so they always show the warning tone.
  public var tone: Tone {
    switch self {
    case .build, .runDevices, .test: return .warning
    case .view, .control, .shareLink: return .neutral
    }
  }

  /// The level a stim-server capability grants: `read`, `control`, `build`, `device-host` or `test`.
  public init?(capability: String) {
    switch capability {
    case "read": self = .view
    case "control": self = .control
    case "build": self = .build
    case "device-host": self = .runDevices
    case "test": self = .test
    default: return nil
    }
  }

  static func ordered(_ levels: some Sequence<ConnectionAccess>) -> [ConnectionAccess] {
    let held = Set(levels)
    return allCases.filter(held.contains)
  }
}

/// A phone or machine that uses this machine: every `stim pairings` record that shares one client key.
public struct IncomingConnection: Identifiable, Equatable, Sendable {
  public enum Kind: Equatable, Sendable {
    /// A pairing from `stim pair`, which a phone and Stim Desktop on another machine both use.
    case device
    case machine
  }

  /// The client key's fingerprint.
  public var id: String
  public var name: String
  public var kind: Kind
  /// Newest pairing first.
  public var records: [PairedDevice]
  public var lastSeenAt: Date?
  public var access: [ConnectionAccess]

  /// The record whose access can change between View and Control; build and device-host approval change only on
  /// this machine with `stim setup`.
  public var pairing: PairedDevice? { records.first(where: \.isPhone) }

  public var kindTitle: String { kind == .machine ? "Machine" : "Device" }

  public var lastConnected: String {
    guard let lastSeenAt else { return "Never connected" }
    return "Last connected \(lastSeenAt.formatted(.relative(presentation: .named)))"
  }
}

/// A machine this machine uses: a `remote.machines` entry, a pairing with its stim-server, or both when they pinned
/// the same server key.
public struct OutgoingConnection: Identifiable, Equatable, Sendable {
  public var id: String { entry ?? pairing?.id ?? name }
  public var name: String
  /// The `remote.machines` entry, which builds and runs devices there.
  public var entry: String?
  /// The Keychain pairing that views or controls its work.
  public var pairing: PairedServers.Entry?
  public var access: [ConnectionAccess]
  /// What to run on that machine to revoke this machine's records there, which removing it here does not do.
  public var revokeCommands: [String]
}

/// `stim remote list --json`, which Desktop reads through its server's `remote` report.
public struct RemoteMachineListing: Decodable, Equatable, Sendable {
  public struct Machine: Decodable, Equatable, Sendable {
    public var machine: String
    public var build: BuildMachineStatus?
    public var deviceHost: BuildMachineStatus?
    /// The base64url SHA-256 of the server key this machine pinned for it, as a pairing's id is.
    public var serverKeyFingerprint: String?
    public var revoke: [String]
  }

  public var machines: [Machine]
}

public enum Connections {
  /// The records of `stim pairings --json`, one connection per client key in the order they arrive. Every record
  /// that can connect is listed, whatever the phone app flag says.
  public static func incoming(_ devices: [PairedDevice]) -> [IncomingConnection] {
    var order: [String] = []
    var groups: [String: [PairedDevice]] = [:]
    for device in devices {
      if groups[device.keyFingerprint] == nil { order.append(device.keyFingerprint) }
      groups[device.keyFingerprint, default: []].append(device)
    }
    return order.compactMap { key in
      let records = groups[key] ?? []
      let machine = records.contains { !$0.isPhone || $0.kind == "desktop" }
      guard let first = records.first else { return nil }
      return IncomingConnection(
        id: key, name: first.name, kind: machine ? .machine : .device, records: records,
        lastSeenAt: records.compactMap(\.lastSeenAt).max(),
        access: ConnectionAccess.ordered(records.flatMap(\.capabilities).compactMap(ConnectionAccess.init(capability:))))
    }
  }

  /// The `remote.machines` entries in placement order, each with the pairing that pinned the same server key, then
  /// the pairings no entry shares. `statuses` and `hosts` are doctor's, which win over the listing's states.
  public static func outgoing(
    entries: [String], statuses: [BuildMachineStatus]?, hosts: [BuildMachineStatus]?,
    listing: RemoteMachineListing?, paired: [PairedServers.Entry]
  ) -> [OutgoingConnection] {
    var unmatched = paired
    var rows: [OutgoingConnection] = entries.map { entry in
      let listed = listing?.machines.first { $0.machine == entry }
      var pairing: PairedServers.Entry?
      if let key = listed?.serverKeyFingerprint, let index = unmatched.firstIndex(where: { $0.id == key }) {
        pairing = unmatched.remove(at: index)
      }
      let build = statuses?.first { $0.machine == entry } ?? listed?.build
      let host =
        hosts?.first { OffloadMachines.name($0.machine) == OffloadMachines.name(entry) } ?? listed?.deviceHost
      var access = pairing.map(pairingAccess) ?? []
      if build?.state == .approved { access.append(.build) }
      if host?.state == .approved { access.append(.runDevices) }
      var commands = listed?.revoke ?? []
      for id in [build?.deviceId, host?.deviceId].compactMap({ $0 }) {
        let command = "stim pairings revoke \(id)"
        if !commands.contains(command) { commands.append(command) }
      }
      if let command = pairing.flatMap(revokeCommand), !commands.contains(command) { commands.append(command) }
      return OutgoingConnection(
        name: entry, entry: entry, pairing: pairing, access: ConnectionAccess.ordered(access), revokeCommands: commands)
    }
    rows += unmatched.map { entry in
      let name = entry.pairing.map { $0.name.isEmpty ? "Machine" : $0.name } ?? "Unreadable pairing"
      return OutgoingConnection(
        name: name, entry: nil, pairing: entry, access: pairingAccess(entry),
        revokeCommands: revokeCommand(entry).map { [$0] } ?? [])
    }
    return rows
  }

  private static func revokeCommand(_ entry: PairedServers.Entry) -> String? {
    PairedServerWording.plainDeviceID(entry.pairing?.deviceID).map { "stim pairings revoke \($0)" }
  }

  private static func pairingAccess(_ entry: PairedServers.Entry) -> [ConnectionAccess] {
    ConnectionAccess.ordered((entry.pairing?.capabilities ?? []).compactMap(ConnectionAccess.init(capability:)))
  }
}

/// Reads `stim remote list --json` from the matching local server, without a CLI fallback.
@MainActor public func readRemoteMachines(
  stimHome: String, diagnostics: Diagnostics = .shared, connection: (client: ServerClient, home: String)?
) async throws -> RemoteMachineListing {
  try Task.checkCancellation()
  guard let client = readCapableServer(connection, stimHome: stimHome) else {
    throw ServerError(code: "not-connected", message: "The local stim-server is not ready to list remote machines.")
  }
  guard case .open(let hello) = client.state, hello.desktopApi == ServerProtocol.desktopApi else {
    throw ServerError(code: "unsupported", message: "Update the local stim-server to list remote machines.")
  }
  let result = try await client.report(["report": .string("remote")])
  guard case .object(let snapshot) = result, snapshot["pending"] == .bool(false), let value = snapshot["value"] else {
    throw ServerError(code: "bad-response", message: "The local stim-server did not return the remote machines.")
  }
  return try decodeReporting(RemoteMachineListing.self, from: value, source: .server, diagnostics: diagnostics)
}
