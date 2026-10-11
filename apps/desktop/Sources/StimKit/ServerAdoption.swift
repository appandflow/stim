import Foundation

/// How far Desktop trusts the stim-server it found running on its port. Before the login shell's environment
/// arrives, Desktop adopts a server provisionally with the Stim home that environment reported on the last launch,
/// so the sidebar can show the server's status feed. A provisional adoption allows reads only: no pairing, no saved
/// or deleted token, no `stim-server` command and no control request until the login environment confirms it.
public enum ServerAdoption: Equatable, Sendable {
  case none
  case provisional(home: String)
  case verified(home: String)

  /// The Stim home to decide a provisional adoption with: the launch environment's `STIM_HOME`, which overrides the
  /// login shell's, then the home the login shell reported on the last launch, then `~/.stim`.
  public static func provisionalHome(
    launch: [String: String], lastLoginHome: String?, home: String = NSHomeDirectory()
  ) -> String {
    if let path = launch["STIM_HOME"], path.hasPrefix("/") { return path }
    if let lastLoginHome, lastLoginHome.hasPrefix("/") { return lastLoginHome }
    return "\(home)/.stim"
  }

  /// The ready server `probe` reports, when Desktop may adopt it provisionally for `provisionalHome`. A server that is
  /// not ready or serves another home waits for the login environment instead of failing on a possibly stale home.
  public static func provisional(
    _ probe: ServerHealthProbe, provisionalHome: String, home: String = NSHomeDirectory()
  ) -> ServerHealth? {
    guard case .ready(let health) = probe,
      StimHome.adopts(serverHome: health.stimHome, resolved: provisionalHome, home: home)
    else { return nil }
    return health
  }

  /// The server to keep once the login environment resolves `loginHome`: the one `probe` now reports, when it is
  /// still ready on the same Stim home and version as the provisionally `adopted` one and the login home adopts it.
  /// Nil drops the provisional adoption.
  public static func confirmed(
    adopted: ServerHealth, probe: ServerHealthProbe?, loginHome: String, home: String = NSHomeDirectory()
  ) -> ServerHealth? {
    guard case .ready(let health) = probe, health.stimHome == adopted.stimHome, health.version == adopted.version,
      StimHome.adopts(serverHome: health.stimHome, resolved: loginHome, home: home)
    else { return nil }
    return health
  }
}

/// Holds Desktop's writes to the adopted stim-server until a provisional adoption is confirmed or dropped.
@MainActor public final class ServerAdoptionGate {
  public private(set) var adoption = ServerAdoption.none {
    didSet {
      guard !isProvisional else { return }
      let waiting = waiters
      waiters = []
      for waiter in waiting { waiter.resume() }
    }
  }
  private var waiters: [CheckedContinuation<Void, Never>] = []

  public init() {}

  public var isProvisional: Bool {
    if case .provisional = adoption { return true }
    return false
  }

  public func set(_ adoption: ServerAdoption) {
    if adoption != self.adoption { self.adoption = adoption }
  }

  /// Returns once no adoption is provisional.
  public func settled() async {
    guard isProvisional else { return }
    await withCheckedContinuation { waiters.append($0) }
  }

  /// Whether Desktop may pair with, save or delete a token for, run `stim-server` commands against, or send control
  /// requests to the server it adopted for `home`.
  public func allowsWrites(home: String) -> Bool {
    adoption == .verified(home: home)
  }
}
