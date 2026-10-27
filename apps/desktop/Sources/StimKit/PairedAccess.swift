import Foundation

/// What a paired server lets this Mac do with its workspaces, from the `hello` of the open connection. The server
/// checks its own record again on every request; this decides only which actions Stim Desktop offers.
public struct PairedAccess: Equatable, Sendable {
  /// The `action` names Stim Desktop knows how to offer, in menu order.
  public static let known = ["reload", "stop"]

  /// The known actions the server advertised in `hello.actions`. A name Stim Desktop does not know is never offered.
  public let actions: [String]
  /// Why no action is offered; nil when the server advertised one.
  public let reason: String?
  public let canControl: Bool

  /// `server` is the pairing's name; `deviceID` is the record the server keeps for this Mac, from its `hello`.
  public init(state: ServerClient.State, server: String, deviceID: String?) {
    guard case .open(let hello) = state else {
      self.init(actions: [], reason: "Not connected to \(server).", canControl: false)
      return
    }
    let canControl = hello.capabilities.contains("control")
    guard canControl else {
      self.init(
        actions: [],
        reason:
          "\(server) lets this Mac view only. On \(server), run \(Self.grantCommand(deviceID: deviceID)), then Reconnect.",
        canControl: false)
      return
    }
    guard let advertised = hello.actions else {
      self.init(actions: [], reason: "Update stim-server on \(server) to run actions from Stim Desktop.", canControl: true)
      return
    }
    let actions = Self.known.filter(advertised.contains)
    self.init(
      actions: actions, reason: actions.isEmpty ? "\(server) offers no action this Stim Desktop knows." : nil,
      canControl: true)
  }

  private init(actions: [String], reason: String?, canControl: Bool) {
    self.actions = actions
    self.reason = reason
    self.canControl = canControl
  }

  /// The grant command Stim Desktop builds from the device id, or the device list when the id is not a plain one.
  static func grantCommand(deviceID: String?) -> String {
    guard let deviceID, !deviceID.isEmpty, deviceID.count <= 64,
      deviceID.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") })
    else { return "stim-server devices grant <id> --control" }
    return "stim-server devices grant \(deviceID) --control"
  }
}
