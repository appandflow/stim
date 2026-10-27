import Foundation

/// What Desktop tells a person about a pairing that did not work or stopped working: a headline, an explanation, and
/// a command to run on the machine when that fixes it.
public struct PairedServerNotice: Equatable, Sendable {
  public var tone: Tone
  public var title: String
  public var detail: String
  public var command: String?
}

public enum PairedServerWording {
  /// Where the error arose: pairing with a code, or a connection a pairing already made.
  public enum Context: Sendable {
    case pairing
    case connection
  }

  /// The local codes only `NoisePairing` and the paired-server list produce, beside `ServerProtocol.refusalCodes`.
  public static let localCodes = [
    "already-paired", "pairing-not-saved", "pairing-unconfirmed", "pairing-in-progress", "own-server", "key-unusable",
  ]

  /// `name` is the pairing's name, or empty when the person has not named it yet.
  public static func notice(for error: ServerError, context: Context, name: String) -> PairedServerNotice {
    let machine = name.isEmpty ? "the machine" : name
    switch error.code {
    case "unknown-secret":
      return PairedServerNotice(
        tone: .error, title: "This pairing code expired or was already used",
        detail: "A code works once and for 5 minutes. Run this on \(machine) for a new one, then paste its output.",
        command: "stim-server pair")
    case "unauthorized":
      switch context {
      case .pairing:
        return PairedServerNotice(
          tone: .error, title: "\(machine) did not accept this Mac",
          detail: "It refused to record this Mac, so nothing was saved. Run stim-server pair on it for a new code.",
          command: "stim-server pair")
      case .connection:
        return PairedServerNotice(
          tone: .error, title: "\(machine) no longer knows this Mac",
          detail: "Its record for this Mac was revoked. Forget this pairing, then pair again with a new code.",
          command: "stim-server pair")
      }
    case "server-key-mismatch":
      switch context {
      case .pairing:
        return PairedServerNotice(
          tone: .error, title: "That is not the machine the code came from",
          detail:
            "The server's key does not match the fingerprint in the pairing code, so Stim Desktop stopped before using the code. Nothing was saved. Check the endpoint, then try again.",
          command: nil)
      case .connection:
        return PairedServerNotice(
          tone: .error, title: "\(machine)'s server key changed",
          detail:
            "Stim Desktop will not connect to a server whose key differs from the one it paired with. If you reinstalled stim-server on it, forget this pairing and pair again. Otherwise something else is answering at this address.",
          command: nil)
      }
    case "server-outdated":
      return PairedServerNotice(
        tone: .warning, title: "Update stim-server on \(machine)",
        detail: "It runs a stim-server that speaks an older protocol than Stim Desktop does.", command: nil)
    case "protocol-unsupported":
      return PairedServerNotice(
        tone: .warning, title: "Update Stim Desktop",
        detail: "\(machine.capitalizedFirst) speaks a newer protocol than this version of Stim Desktop.", command: nil)
    case "other-server":
      return PairedServerNotice(
        tone: .error, title: "That is a different server",
        detail: "The server that answered is not the one Stim Desktop expected at this address.", command: nil)
    case "already-paired":
      return PairedServerNotice(
        tone: .warning, title: "This Mac is already paired with \(machine)",
        detail:
          "Stim Desktop stopped before using the code, so it is still valid. To pair again, forget the existing pairing first.",
        command: nil)
    case "pairing-in-progress":
      return PairedServerNotice(
        tone: .warning, title: "Already pairing with this machine",
        detail: "Wait for the pairing in progress to finish, or cancel it.", command: nil)
    case "pairing-not-saved":
      return PairedServerNotice(
        tone: .error, title: "Stim Desktop could not save the pairing",
        detail: "\(error.message) The code was not used, so you can try it again.", command: nil)
    case "pairing-unconfirmed":
      return PairedServerNotice(
        tone: .warning, title: "\(machine.capitalizedFirst) did not confirm the pairing",
        detail:
          "The code may be used up, and \(machine) may have recorded this Mac. Stim Desktop kept the pairing, and it finishes when \(machine) answers. To undo it instead, forget it here and revoke this Mac on \(machine). \(error.message)",
        command: "stim-server devices")
    case "own-server":
      return PairedServerNotice(
        tone: .warning, title: "That is this Mac's own server",
        detail:
          "Stim Desktop already shows it, so the pairing was removed. Revoke the record it left in this Mac's Paired Devices, or with this command on this Mac.",
        command: error.message)
    case "key-unusable":
      return PairedServerNotice(
        tone: .error, title: "Stim Desktop cannot use this pairing's key",
        detail: "The key stored for it is damaged. Forget this pairing and pair again.", command: nil)
    case "timeout", "unreachable":
      let unresolved = error.message.contains("NoSuchRecord")
      return PairedServerNotice(
        tone: .error, title: "Can't reach \(machine)",
        detail: unresolved
          ? "This Mac could not resolve its name. Check that Tailscale is on and that its DNS settings let this Mac resolve names on that tailnet. \(error.message.sentence)"
          : "\(error.message.sentence) Check that Tailscale is on, that \(machine) is on the tailnet and that stim-server is running there.",
        command: nil)
    default:
      return PairedServerNotice(tone: .error, title: "The pairing did not work", detail: error.message, command: nil)
    }
  }

  public static func notice(for problem: PairingPayload.Problem) -> PairedServerNotice {
    PairedServerNotice(
      tone: problem == .serverOutdated || problem == .desktopOutdated ? .warning : .error,
      title: "Stim Desktop can't use this pairing code", detail: problem.errorDescription ?? "", command: nil)
  }

  /// What a pairing may do, from the capabilities its server reported.
  public static func access(_ capabilities: [String]) -> String {
    if capabilities.contains("control") { return "View and control" }
    if capabilities.contains("read") { return "View only" }
    return "Not confirmed"
  }

  /// The command that removes this Mac's record on the server, which Forget does not do.
  public static func revokeCommand(deviceID: String?) -> String {
    guard let deviceID else { return "stim-server devices" }
    return "stim-server devices revoke \(deviceID)"
  }
}

extension String {
  fileprivate var sentence: String { hasSuffix(".") ? self : self + "." }
  fileprivate var capitalizedFirst: String { prefix(1).uppercased() + dropFirst() }
}

/// One line for a pairing's row: how the connection is, with the notice that explains a refusal.
public struct PairedServerStatus: Equatable, Sendable {
  public var tone: Tone
  public var title: String
  public var detail: String?
  public var command: String?
}

extension PairedServers.Entry {
  public var status: PairedServerStatus {
    guard let pairing else {
      return PairedServerStatus(
        tone: .error, title: "Unreadable pairing",
        detail: "Stim Desktop cannot read this item in the Keychain. Forget it to remove it.", command: nil)
    }
    let unconfirmed = pairing.isConfirmed ? nil : "This Mac has not been confirmed by the machine yet."
    switch connection {
    case .idle:
      return PairedServerStatus(tone: .tertiary, title: "Not connected", detail: unconfirmed, command: nil)
    case .connecting:
      return PairedServerStatus(tone: .tertiary, title: "Connecting", detail: unconfirmed, command: nil)
    case .open:
      return PairedServerStatus(tone: .success, title: "Connected", detail: nil, command: nil)
    case .offline(let reason, let retryIn, let hadOpened):
      let name = pairing.name.isEmpty ? "the machine" : pairing.name
      let seconds = Int(retryIn.rounded(.up))
      return PairedServerStatus(
        tone: .warning,
        title: hadOpened ? "Offline \u{00B7} retrying in \(seconds) s" : "Can't reach \(name) \u{00B7} retrying in \(seconds) s",
        detail: [reason, unconfirmed].compactMap { $0 }.joined(separator: " "), command: nil)
    case .refused(let error):
      let notice = PairedServerWording.notice(for: error, context: .connection, name: pairing.name)
      return PairedServerStatus(tone: notice.tone, title: notice.title, detail: notice.detail, command: notice.command)
    case .unusable:
      let notice = PairedServerWording.notice(
        for: ServerError(code: "key-unusable", message: ""), context: .connection, name: pairing.name)
      return PairedServerStatus(tone: notice.tone, title: notice.title, detail: notice.detail, command: nil)
    }
  }
}
