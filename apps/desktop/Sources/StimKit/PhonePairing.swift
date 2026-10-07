import Foundation

/// Tailscale on this Mac, as the Pair a Phone wizard reads it from `tailscale status --json`. An installed app or
/// CLI that does not answer reads as stopped, not missing.
public enum MacTailscale: Equatable, Sendable {
  case checking
  case missing
  case stopped(hasApp: Bool)
  case running(dnsName: String?)

  public init(statusJSON: Data?, hasApp: Bool, hasCLI: Bool) {
    guard let statusJSON, let status = try? JSONSerialization.jsonObject(with: statusJSON) as? [String: Any] else {
      self = hasApp || hasCLI ? .stopped(hasApp: hasApp) : .missing
      return
    }
    guard status["BackendState"] as? String == "Running" else {
      self = .stopped(hasApp: hasApp)
      return
    }
    let dns = ((status["Self"] as? [String: Any])?["DNSName"] as? String)?
      .trimmingCharacters(in: CharacterSet(charactersIn: ".")).lowercased()
    self = .running(dnsName: dns?.isEmpty == false ? dns : nil)
  }

  public var isRunning: Bool {
    if case .running = self { return true }
    return false
  }
}

/// What the wizard needs from Desktop's stim-server: whether it runs, whether it is on the tailnet, and the state of
/// its `tailscale serve` route (`routed`, `missing`, `funneled` or `unknown`; nil when the server reports none).
public enum PhoneServer: Equatable, Sendable {
  case off
  case starting
  case running(tailscale: Bool, route: String?, servesOtherHome: Bool)
  case degraded(String)
  case failed(String)

  public var isReady: Bool {
    if case .running(true, "routed", _) = self { return true }
    return false
  }
}

/// The Pair a Phone wizard: get the apps, Tailscale on both devices, serving with a private tailnet route, a pairing
/// code, and the paired phone. Pure decisions; the sheet's model runs the effects and feeds back what it observes.
public struct PhonePairing: Sendable {
  public enum Step: Int, CaseIterable, Comparable, Sendable {
    case app, tailscale, serve, pair, done

    public var title: String {
      switch self {
      case .app: return "Get the app"
      case .tailscale: return "Tailscale"
      case .serve: return "Turn on serving"
      case .pair: return "Pair"
      case .done: return "Done"
      }
    }

    public static func < (lhs: Step, rhs: Step) -> Bool { lhs.rawValue < rhs.rawValue }
  }

  public enum Check: Equatable, Sendable {
    case waiting, working, ok, problem
  }

  public enum Event: Sendable {
    case next, back
    case tailscale(MacTailscale)
    case server(PhoneServer)
    case routeFinished(error: String?)
    case retry
    case access(control: Bool)
    case codeIssued(expiresAt: Date, control: Bool)
    case codeFailed(String)
    case newCode
    case devices([PairedDevice])
    case cancel
    case tick
  }

  public enum Effect: Equatable, Sendable {
    case startServing, stopServing, setUpRoute
    case requestCode(control: Bool)
  }

  /// How many times an expired code is replaced without asking, about 20 minutes of a code on screen.
  public static let automaticRenewals = 3

  public private(set) var step: Step = .app
  public private(set) var tailscale: MacTailscale = .checking
  public private(set) var server: PhoneServer
  public private(set) var control = true
  public private(set) var settingUpRoute = false
  public private(set) var routeError: String?
  public private(set) var codeExpiresAt: Date?
  public private(set) var requestingCode = false
  public private(set) var codeError: String?
  public private(set) var renewals = 0
  public private(set) var paired: PairedDevice?
  public private(set) var cancelled = false
  private var serving: Bool
  private let wasServing: Bool
  private var routeAttempted = false
  private let openedAt: Date
  private let knownPhones: Set<String>

  public init(servesPhones: Bool, server: PhoneServer, phones: [PairedDevice], now: Date) {
    serving = servesPhones
    wasServing = servesPhones
    self.server = server
    openedAt = now
    knownPhones = Set(phones.filter(\.isPhone).map(\.id))
  }

  public var serverCheck: Check {
    switch server {
    case .off: return serving ? .working : .waiting
    case .starting: return .working
    case .running: return .ok
    case .degraded, .failed: return .problem
    }
  }

  public var tailnetCheck: Check {
    switch server {
    case .running(let tailscale, _, _): return tailscale ? .ok : .problem
    case .off, .starting: return .waiting
    case .degraded, .failed: return .waiting
    }
  }

  public var routeCheck: Check {
    guard case .running(true, let route, _) = server else { return .waiting }
    switch route {
    case "routed": return .ok
    case "funneled": return .problem
    case nil: return .working
    default:
      if settingUpRoute { return .working }
      return routeAttempted ? .problem : .working
    }
  }

  /// A warning on the serving step that does not stop pairing.
  public var servesOtherHome: Bool {
    if case .running(_, _, true) = server { return true }
    return false
  }

  public var canContinue: Bool {
    switch step {
    case .app: return true
    case .tailscale: return tailscale.isRunning
    case .serve: return server.isReady
    case .pair, .done: return false
    }
  }

  public var canGoBack: Bool { step > .app && step < .done }

  /// Whether the code on screen expired and is no longer replaced without asking.
  public func codeExpired(now: Date) -> Bool {
    guard let codeExpiresAt, !requestingCode else { return false }
    return now >= codeExpiresAt && renewals >= Self.automaticRenewals
  }

  public mutating func apply(_ event: Event, now: Date) -> [Effect] {
    guard !cancelled else { return [] }
    var effects: [Effect] = []
    switch event {
    case .next:
      guard canContinue, let next = Step(rawValue: step.rawValue + 1) else { return [] }
      step = next
      if step == .serve {
        effects += enterServe()
      } else if step == .pair {
        effects += freshCode()
      }
    case .back:
      guard canGoBack, let previous = Step(rawValue: step.rawValue - 1) else { return [] }
      step = previous
      codeExpiresAt = nil
      requestingCode = false
      codeError = nil
    case .tailscale(let state):
      tailscale = state
    case .server(let state):
      server = state
    case .routeFinished(let error):
      settingUpRoute = false
      routeError = error
    case .retry:
      guard step == .serve else { return [] }
      routeAttempted = false
      routeError = nil
      if case .failed = server { effects.append(.startServing) }
    case .access(let control):
      guard control != self.control else { return [] }
      self.control = control
      if step == .pair { effects += freshCode() }
    case .codeIssued(let expiresAt, let control):
      guard step == .pair, requestingCode, control == self.control else { return [] }
      requestingCode = false
      codeExpiresAt = expiresAt
      codeError = nil
    case .codeFailed(let message):
      guard step == .pair, requestingCode else { return [] }
      requestingCode = false
      codeError = message
    case .newCode:
      guard step == .pair, !requestingCode else { return [] }
      effects += freshCode()
    case .devices(let devices):
      guard step == .pair else { return [] }
      if let phone = devices.first(where: { $0.isPhone && !knownPhones.contains($0.id) && $0.pairedAt >= openedAt }) {
        paired = phone
        step = .done
        codeExpiresAt = nil
        requestingCode = false
      }
    case .cancel:
      cancelled = true
      if serving, !wasServing, paired == nil { return [.stopServing] }
      return []
    case .tick:
      if step == .pair, !requestingCode, let codeExpiresAt, now >= codeExpiresAt, renewals < Self.automaticRenewals {
        renewals += 1
        requestingCode = true
        effects.append(.requestCode(control: control))
      }
    }
    effects += setUpRouteIfNeeded()
    return effects
  }

  private mutating func enterServe() -> [Effect] {
    routeAttempted = false
    routeError = nil
    guard !serving || server == .off else { return [] }
    serving = true
    return [.startServing]
  }

  private mutating func freshCode() -> [Effect] {
    renewals = 0
    codeExpiresAt = nil
    codeError = nil
    requestingCode = true
    return [.requestCode(control: control)]
  }

  private mutating func setUpRouteIfNeeded() -> [Effect] {
    guard step == .serve, !routeAttempted, !settingUpRoute,
      case .running(true, let route, _) = server, route == "missing" || route == "unknown"
    else { return [] }
    routeAttempted = true
    settingUpRoute = true
    return [.setUpRoute]
  }
}
