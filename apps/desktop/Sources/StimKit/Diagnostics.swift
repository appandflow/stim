import Foundation

/// A breadcrumb for the crash reporter. Values are fixed words, page kinds, command names, durations and states.
public struct DiagnosticBreadcrumb: Sendable, Equatable {
  public var category: String
  public var message: String
  public var data: [String: String]

  public init(category: String, message: String, data: [String: String] = [:]) {
    self.category = category
    self.message = message
    self.data = data
  }
}

/// A handled failure as the crash reporter sends it: a fixed message, tags and a grouping fingerprint.
public struct DiagnosticReport: Sendable, Equatable {
  public var message: String
  public var tags: [String: String]
  public var fingerprint: [String]

  public init(message: String, tags: [String: String], fingerprint: [String]) {
    self.message = message
    self.tags = tags
    self.fingerprint = fingerprint
  }
}

public enum DecodeSource: String, Sendable {
  case cli
  case server
}

public enum ServerFailureKind: String, Sendable {
  case adoptionHomeMismatch = "adoption-home-mismatch"
  case launchFailed = "launch-failed"
  case noAnswer = "no-answer"
  case exited
  case tooOld = "too-old"
}

/// A handled failure Stim Desktop may report. Each case carries only fixed words, numbers, type names, coding
/// keys declared in code, never a path, argument, name, host or payload value.
public enum DiagnosticFailure: Sendable, Equatable {
  case decode(source: DecodeSource, type: String, path: String, reason: String)
  case server(ServerFailureKind)

  public var report: DiagnosticReport {
    switch self {
    case .decode(let source, let type, let path, let reason):
      return DiagnosticReport(
        message: "payload decode failed",
        tags: ["source": source.rawValue, "type": type, "coding_path": path, "reason": reason],
        fingerprint: ["decode", source.rawValue, type, path, reason])
    case .server(let kind):
      return DiagnosticReport(
        message: "stim-server start failed", tags: ["kind": kind.rawValue], fingerprint: ["stim-server", kind.rawValue])
    }
  }
}

/// Where breadcrumbs, tags and failures go. The app installs one only when the crash reporter is running.
public final class Diagnostics: @unchecked Sendable {
  public struct Sink: Sendable {
    public var breadcrumb: @Sendable (DiagnosticBreadcrumb) -> Void
    public var tag: @Sendable (String, String) -> Void
    public var report: @Sendable (DiagnosticReport) -> Void

    public init(
      breadcrumb: @escaping @Sendable (DiagnosticBreadcrumb) -> Void,
      tag: @escaping @Sendable (String, String) -> Void,
      report: @escaping @Sendable (DiagnosticReport) -> Void
    ) {
      self.breadcrumb = breadcrumb
      self.tag = tag
      self.report = report
    }
  }

  public static let shared = Diagnostics()

  /// The DSN the bundle's `StimSentryDSN` carries, or nil when it is absent or blank. Only a bundle that
  /// `bundle.sh --release` wrote one into starts the crash reporter.
  public static func sentryDSN(_ infoDictionaryValue: Any?) -> String? {
    let dsn = (infoDictionaryValue as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return dsn.isEmpty ? nil : dsn
  }

  private let lock = NSLock()
  private let maxReports: Int
  private var sink: Sink?
  private var reported: Set<String> = []

  /// `maxReports` caps the failures one session sends; each distinct failure is sent once.
  public init(maxReports: Int = 20) {
    self.maxReports = maxReports
  }

  public func install(_ sink: Sink?) {
    lock.withLock { self.sink = sink }
  }

  public func breadcrumb(_ category: String, _ message: String, data: [String: String] = [:]) {
    let sink = lock.withLock { self.sink }
    sink?.breadcrumb(DiagnosticBreadcrumb(category: category, message: message, data: data))
  }

  public func tag(_ key: String, _ value: String) {
    let sink = lock.withLock { self.sink }
    sink?.tag(key, value)
  }

  public func report(_ failure: DiagnosticFailure) {
    let report = failure.report
    let target: Sink? = lock.withLock {
      guard let current = self.sink, reported.count < maxReports,
        reported.insert(report.fingerprint.joined(separator: "|")).inserted
      else { return nil }
      return current
    }
    target?.report(report)
  }

  /// Why decoding failed and where, as type names and keys the model declares. Dictionary keys, which can be
  /// workspace or machine names, and array indices are replaced.
  public static func describe(_ error: Error) -> (reason: String, path: String) {
    guard let error = error as? DecodingError else { return ("other", "") }
    switch error {
    case .keyNotFound(let key, let context): return ("key-not-found", path(context.codingPath + [key]))
    case .typeMismatch(_, let context): return ("type-mismatch", path(context.codingPath))
    case .valueNotFound(_, let context): return ("value-not-found", path(context.codingPath))
    case .dataCorrupted(let context): return ("data-corrupted", path(context.codingPath))
    @unknown default: return ("other", "")
    }
  }

  public static func path(_ codingPath: [any CodingKey]) -> String {
    codingPath.prefix(12).map(component).joined(separator: ".")
  }

  private static func component(_ key: any CodingKey) -> String {
    if key.intValue != nil { return "[]" }
    guard Mirror(reflecting: key).displayStyle == .enum, type(of: key).init(stringValue: "\u{0}probe") == nil,
      key.stringValue.count <= 40,
      key.stringValue.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_") })
    else { return "<key>" }
    return key.stringValue
  }
}

/// Decodes `data` and reports a failure to the crash reporter, then rethrows it.
public func decodeReporting<T: Decodable>(
  _ type: T.Type, from data: Data, source: DecodeSource, decoder: JSONDecoder = JSONDecoder(),
  diagnostics: Diagnostics = .shared
) throws -> T {
  do {
    return try decoder.decode(type, from: data)
  } catch {
    DebugLog.decodeFailed(type, source: source.rawValue, error: error, bytes: data.count)
    let (reason, path) = Diagnostics.describe(error)
    diagnostics.report(.decode(source: source, type: String(String(describing: type).prefix(80)), path: path, reason: reason))
    throw error
  }
}

/// `decodeReporting` for a value the server sent as JSON.
public func decodeReporting<T: Decodable>(
  _ type: T.Type, from value: JSONValue, source: DecodeSource, diagnostics: Diagnostics = .shared
) throws -> T {
  try decodeReporting(type, from: try JSONEncoder().encode(value), source: source, diagnostics: diagnostics)
}
