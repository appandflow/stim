import Foundation
import OSLog

/// Stim Desktop's local debug log: a rotating file under `~/Library/Logs/Stim` and `os.Logger` categories for
/// Console.app. Nothing is sent anywhere. Warnings, errors, stalls and CLI failures always log; everything else
/// logs only when the `debugLogging` default is on. Every message passes `DebugLogRedaction` before it is written.
public enum DebugLog {
  public enum Level: Int, Comparable, Sendable {
    case debug, info, warning, error

    public static func < (lhs: Level, rhs: Level) -> Bool { lhs.rawValue < rhs.rawValue }

    var label: String {
      switch self {
      case .debug: "DEBUG"
      case .info: "INFO "
      case .warning: "WARN "
      case .error: "ERROR"
      }
    }
  }

  public enum Category: String, CaseIterable, Sendable {
    case app, cli, server, decode, navigation, stall, sampler, stream
  }

  public static let subsystem = "dev.stim.desktop"
  private static let pid = ProcessInfo.processInfo.processIdentifier

  public static let releaseBundleIdentifier = "dev.stim.desktop"

  public static var logURL: URL {
    FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent("Library/Logs/Stim/\(logFileName(bundleIdentifier: Bundle.main.bundleIdentifier))")
  }

  /// The release app writes `Desktop.log`. Any other bundle id (a `stim macos` test copy, a dev bundle) writes
  /// `Desktop-<id without the release prefix>.log`, so the installed app's log holds only its own lines.
  public static func logFileName(bundleIdentifier: String?) -> String {
    guard let bundleIdentifier, bundleIdentifier != releaseBundleIdentifier else { return "Desktop.log" }
    let suffix =
      bundleIdentifier.hasPrefix(releaseBundleIdentifier + ".")
      ? String(bundleIdentifier.dropFirst(releaseBundleIdentifier.count + 1)) : bundleIdentifier
    let safe = String(suffix.unicodeScalars.map { Self.fileNameCharacters.contains($0) ? Character($0) : "-" })
    return safe.isEmpty ? "Desktop.log" : "Desktop-\(safe).log"
  }

  private static let fileNameCharacters = CharacterSet(
    charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-")

  /// Whether the verbose level is on.
  public static var isVerbose: Bool { UserDefaults.standard.bool(forKey: AppPreferences.Key.debugLogging) }

  /// Info and debug messages need the verbose level; warnings and errors always log.
  public static func shouldLog(_ level: Level, verbose: Bool) -> Bool { verbose || level >= .warning }

  private static let file = DebugLogFile(url: logURL)
  private static let loggers = Dictionary(
    uniqueKeysWithValues: Category.allCases.map { ($0, Logger(subsystem: subsystem, category: $0.rawValue)) })

  /// The message closure runs only when the level is on, so a disabled debug line costs one defaults read.
  public static func log(_ level: Level, _ category: Category, _ message: @autoclosure () -> String) {
    guard shouldLog(level, verbose: isVerbose) else { return }
    write(level, category, message())
  }

  public static func debug(_ category: Category, _ message: @autoclosure () -> String) {
    log(.debug, category, message())
  }
  public static func info(_ category: Category, _ message: @autoclosure () -> String) { log(.info, category, message()) }
  public static func warning(_ category: Category, _ message: @autoclosure () -> String) {
    log(.warning, category, message())
  }
  public static func error(_ category: Category, _ message: @autoclosure () -> String) {
    log(.error, category, message())
  }

  private static func write(_ level: Level, _ category: Category, _ message: String) {
    let now = Date()
    file.queue.async {
      let text = DebugLogRedaction.singleLine(DebugLogRedaction.redact(message))
      let logger = loggers[category]
      switch level {
      case .debug: logger?.debug("\(text, privacy: .public)")
      case .info: logger?.info("\(text, privacy: .public)")
      case .warning: logger?.warning("\(text, privacy: .public)")
      case .error: logger?.error("\(text, privacy: .public)")
      }
      file.append("\(file.timestamp(now)) \(pid) \(level.label) \(category.rawValue) \(text)\n")
    }
  }

  /// Waits for queued lines to reach the file.
  public static func flush() { file.queue.sync {} }

  // MARK: Context for stall reports

  private struct Context {
    var destination = "launching"
    var lastCommand = "none"
  }
  private static let context = LockedValue(Context())

  /// An arrival at the Overview from another page logs as a warning whatever its cause, so the default log explains
  /// an unexpected jump. Every other page change logs at debug.
  public static func navigationLevel(to destination: String, from previous: String?) -> Level {
    destination == "overview" && previous != nil && previous != "overview" ? .warning : .debug
  }

  public static func setDestination(_ destination: String, from previous: String? = nil, cause: NavigationCause? = nil) {
    context.withLock { $0.destination = destination }
    let origin = previous.map { " from \($0)" } ?? ""
    let reason = cause.map { " cause=\($0.logDescription)" } ?? ""
    log(navigationLevel(to: destination, from: previous), .navigation, "destination \(destination)\(origin)\(reason)")
  }

  public static var destination: String { context.withLock { $0.destination } }
  public static var lastCommand: String { context.withLock { $0.lastCommand } }

  // MARK: Run ids and CLI calls

  public static func newRunID() -> String {
    "desktop-" + UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(12).lowercased()
  }

  /// The first `STIM_*` error code in `text`, such as `STIM_BAD_ARG`.
  public static func stimCode(in text: String) -> String? {
    guard let range = text.range(of: "STIM_[A-Z0-9_]+", options: .regularExpression) else { return nil }
    return String(text[range])
  }

  /// One `stim` or `stim-server` process run by Desktop, from its start to its exit.
  public struct CLIRun: Sendable {
    public let runID: String
    let tool: String
    let arguments: [String]
    let cwd: String?
    let started = Date()

    public init(tool: String, arguments: [String], cwd: String?) {
      runID = DebugLog.newRunID()
      self.tool = tool
      self.arguments = Self.loggable(arguments)
      self.cwd = cwd
      let command = "\(tool) \(self.arguments.joined(separator: " "))"
      DebugLog.context.withLock { $0.lastCommand = command }
      DebugLog.debug(.cli, "start run=\(runID) \(command)\(cwd.map { " cwd=\($0)" } ?? "")")
    }

    /// `stim settings set <key> <value>` carries sensitive values such as a keystore password as a positional
    /// argument, so the value never reaches the log.
    static func loggable(_ arguments: [String]) -> [String] {
      guard arguments.count > 3, arguments[0] == "settings", arguments[1] == "set" else { return arguments }
      return Array(arguments[..<3]) + [DebugLogRedaction.placeholder] + arguments[4...]
    }

    /// Logs the exit. A failure logs at error level with the `STIM_*` code and the tail of stderr.
    public func finish(status: Int32, timedOut: Bool = false, stderr: String = "", stdout: String = "") {
      let ms = Int(Date().timeIntervalSince(started) * 1000)
      let command = "\(tool) \(arguments.joined(separator: " "))"
      if !timedOut, status == SIGTERM || status == SIGKILL {
        DebugLog.info(.cli, "stopped run=\(runID) signal=\(status) \(ms)ms \(command)")
        return
      }
      guard status == 0, !timedOut else {
        let code = DebugLog.stimCode(in: stderr) ?? DebugLog.stimCode(in: String(stdout.prefix(4096)))
        let tail = String(stderr.suffix(600))
        DebugLog.error(
          .cli,
          "failed run=\(runID) exit=\(status)\(timedOut ? " timedOut" : "") \(ms)ms\(code.map { " code=\($0)" } ?? "") \(command)\(tail.isEmpty ? "" : " stderr: \(tail)")"
        )
        return
      }
      DebugLog.info(.cli, "done run=\(runID) exit=0 \(ms)ms \(command)")
    }

    public func fail(_ error: Error) {
      if error is CancellationError {
        DebugLog.debug(.cli, "cancelled run=\(runID) \(tool) \(arguments.joined(separator: " "))")
        return
      }
      DebugLog.error(.cli, "could not run run=\(runID) \(tool) \(arguments.joined(separator: " ")): \(error)")
    }
  }

  // MARK: Decode failures

  /// Where a decode failed: the type and the coding path, never the payload.
  public static func describe(_ error: DecodingError) -> String {
    func path(_ context: DecodingError.Context) -> String {
      context.codingPath.map { $0.intValue.map { "[\($0)]" } ?? ".\($0.stringValue)" }.joined()
    }
    switch error {
    case .keyNotFound(let key, let context): return "missing key \(key.stringValue) at \(path(context))"
    case .typeMismatch(let type, let context): return "expected \(type) at \(path(context))"
    case .valueNotFound(let type, let context): return "null \(type) at \(path(context))"
    case .dataCorrupted(let context): return "corrupted data at \(path(context)): \(context.debugDescription)"
    @unknown default: return "\(error)"
    }
  }

  /// Logs the type and coding path of a decode failure, once per repeated failure of one source.
  public static func decodeFailed<T>(_ type: T.Type, source: String, error: Error, bytes: Int) {
    guard let error = error as? DecodingError else { return }
    let message = "\(type) from \(source): \(describe(error))"
    if decodeFailures.withLock({ failures in failures.updateValue(message, forKey: source) != message }) {
      DebugLog.error(.decode, "\(message) (\(bytes) bytes)")
    }
  }

  /// Logs a sampler gap when its reason changes, so a gap that lasts for minutes writes one line. Nil marks the
  /// gap closed.
  public static func gap(_ key: String, _ reason: String?) {
    let changed = gaps.withLock { gaps -> Bool in
      guard gaps[key] != reason else { return false }
      gaps[key] = reason
      return true
    }
    guard changed else { return }
    if let reason { warning(.sampler, "\(key) unavailable: \(reason)") } else { info(.sampler, "\(key) available again") }
  }
  private static let decodeFailures = LockedValue([String: String]())
  private static let gaps = LockedValue([String: String?]())
}

/// A value behind a lock.
final class LockedValue<Value>: @unchecked Sendable {
  private let lock = NSLock()
  private var value: Value
  init(_ value: Value) { self.value = value }
  func withLock<T>(_ body: (inout Value) -> T) -> T { lock.withLock { body(&value) } }
}

/// Appends lines to a file (O_APPEND, so Desktop copies sharing the path interleave whole lines) and keeps `maxBytes` per file and `keep` older files (`Desktop.1.log`, `Desktop.2.log`, ...).
public final class DebugLogFile: @unchecked Sendable {
  let queue = DispatchQueue(label: "dev.stim.desktop.debuglog", qos: .utility)
  private let url: URL
  private let maxBytes: Int
  private let keep: Int
  private var handle: FileHandle?
  private var size = 0

  public init(url: URL, maxBytes: Int = 2_000_000, keep: Int = 3) {
    self.url = url
    self.maxBytes = maxBytes
    self.keep = keep
  }

  /// Appends on the calling queue, which must be `queue`.
  func append(_ line: String) {
    let data = Data(line.utf8)
    if handle == nil { open() }
    if size > 0, size + data.count > maxBytes { rotate() }
    guard let handle else { return }
    do {
      try handle.write(contentsOf: data)
      size += data.count
    } catch {
      self.handle = nil
    }
  }

  /// Appends and waits for the write; for callers outside the shared logger.
  public func appendSync(_ line: String) { queue.sync { append(line) } }

  func backup(_ index: Int) -> URL {
    url.deletingPathExtension().appendingPathExtension("\(index).log")
  }

  private func open() {
    let fm = FileManager.default
    try? fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    let descriptor = Darwin.open(url.path, O_WRONLY | O_APPEND | O_CREAT, 0o600)
    guard descriptor >= 0 else { return }
    var info = stat()
    size = fstat(descriptor, &info) == 0 ? Int(info.st_size) : 0
    handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
  }

  private func rotate() {
    try? handle?.close()
    handle = nil
    let fm = FileManager.default
    try? fm.removeItem(at: backup(keep))
    for index in stride(from: keep - 1, through: 1, by: -1) {
      try? fm.moveItem(at: backup(index), to: backup(index + 1))
    }
    try? fm.moveItem(at: url, to: backup(1))
    size = 0
    open()
  }

  private let formatter: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    formatter.timeZone = .current
    return formatter
  }()

  /// Formatted only on the logger queue, which is the formatter's one user.
  func timestamp(_ date: Date) -> String { formatter.string(from: date) }
}

/// Removes the shapes secrets take from text before it is written: pairing, device and setup tokens, bearer and
/// authorization values, URL credentials such as a Sentry DSN, JWTs, secret-named flags, keys and values, and long
/// opaque strings. Desktop never logs environment values.
public enum DebugLogRedaction {
  public static let placeholder = "[redacted]"

  private static let rules: [(NSRegularExpression, String)] = {
    let secretName =
      "[\\w-]*(?:token|ticket|secret|passw(?:or)?d|authorization|api[_-]?key|private[_-]?key|credential|dsn)[\\w-]*"
    let patterns: [(String, String)] = [
      ("(?i)(authorization[\"']?\\s*[:=]\\s*)[^\\n,}]+", "$1\(placeholder)"),
      ("(?i)\\b(?:bearer|basic)\\s+[\\w.~+/=-]+", "Bearer \(placeholder)"),
      ("(?i)(--\(secretName))(?:=|\\s+)(?:\"[^\"]*\"|'[^']*'|\\S+)", "$1=\(placeholder)"),
      ("(?i)(\"?\(secretName)\"?\\s*[:=]\\s*)(?!\\[redacted\\])(?:\"[^\"]*\"|'[^']*'|[^\\s,&}\\]]+)", "$1\(placeholder)"),
      ("(?i)([a-z][a-z0-9+.-]*://)[^\\s/@]+@", "$1\(placeholder)@"),
      ("(?i)([?&](?:token|ticket|secret|key|code|pair\\w*)=)[^\\s&]+", "$1\(placeholder)"),
      ("\\beyJ[\\w-]+\\.[\\w-]+\\.[\\w-]+\\b", placeholder),
      ("(?<![\\w/.-])[0-9a-fA-F]{32,}(?![\\w/.-])", placeholder),
      (
        "(?<![\\w/.-])(?![0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\\b)(?=[A-Za-z0-9_-]*\\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}(?![\\w/.-])",
        placeholder
      ),
    ]
    return patterns.compactMap { pattern, template in
      (try? NSRegularExpression(pattern: pattern)).map { ($0, template) }
    }
  }()

  public static func redact(_ text: String) -> String {
    var result = text
    for (regex, template) in rules {
      result = regex.stringByReplacingMatches(
        in: result, range: NSRange(result.startIndex..., in: result), withTemplate: template)
    }
    return result
  }

  /// One line, capped, so a stderr tail cannot split a record.
  public static func singleLine(_ text: String, limit: Int = 4000) -> String {
    let flat = text.split(whereSeparator: \.isNewline).joined(separator: " | ")
    return flat.count > limit ? String(flat.prefix(limit)) + "..." : flat
  }
}
