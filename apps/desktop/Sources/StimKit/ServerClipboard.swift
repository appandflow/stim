import Foundation

/// The Mac clipboard text is larger than `input.clipboard.set` takes.
public struct ClipboardTooLarge: Error, Equatable, LocalizedError, Sendable {
  public var bytes: Int

  public init(bytes: Int) { self.bytes = bytes }

  public var errorDescription: String? {
    let size = bytes < 1024 ? "\(bytes) bytes" : "\((bytes + 1023) / 1024) KiB"
    return "The text is \(size), and a device Stim Desktop reaches through stim-server takes at most "
      + "\(PhysicalStream.maxClipboardBytes / 1024) KiB."
  }
}

/// A viewed device's clipboard through stim-server. The screen that streams the device attaches its stream and
/// reports what the clipboard section may offer; the device tile reads and writes through it.
@MainActor public final class ServerClipboard: ObservableObject {
  public enum Access: Equatable, Sendable {
    /// Not offered: this device has no clipboard to reach, or Desktop does not drive it.
    case none
    /// The server cannot move text to or from the device, with why.
    case unsupported(String)
    /// Text moves through the control session `session`.
    case ready(session: String)

    /// `link` is the connection to the server that owns the device. Only iOS simulators and Android devices have a
    /// clipboard to reach: a physical iPhone, a macOS app and a web page refuse it.
    /// `server` names the paired machine that owns the device, or is nil for this Mac's server.
    public init(platform: String, physical: Bool, link: ServerLink, control: PhysicalStream.Control, server: String?) {
      guard platform == "android" || (platform == "ios" && !physical), case .open(let features, _) = link else {
        self = .none
        return
      }
      guard features?.contains("device-clipboard") == true else {
        self = .unsupported(
          "Update stim-server\(server.map { " on \($0)" } ?? "") to copy text to and from this device.")
        return
      }
      if case .on(let session) = control { self = .ready(session: session) } else { self = .none }
    }
  }

  @Published public var access = Access.none
  public weak var stream: PhysicalStream?

  public init() {}

  /// Returns true when an iOS simulator typed the pasted text instead of pasting it.
  @discardableResult
  public func set(_ text: String, paste: Bool) async throws -> Bool {
    guard let stream else { throw ServerError(code: "not-connected", message: "The device is not connected.") }
    return try await stream.setClipboard(text, paste: paste)
  }

  public func text() async throws -> String {
    guard let stream else { throw ServerError(code: "not-connected", message: "The device is not connected.") }
    return try await stream.clipboard()
  }
}
