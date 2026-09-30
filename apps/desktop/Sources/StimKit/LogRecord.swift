import Foundation

public enum LogSource: String, CaseIterable, Sendable {
  case metro, client, device, build, agent
}

public enum LogLevel: String, CaseIterable, Comparable, Sendable {
  case debug, info, warn, error, fatal

  public static func < (lhs: LogLevel, rhs: LogLevel) -> Bool {
    allCases.firstIndex(of: lhs)! < allCases.firstIndex(of: rhs)!
  }
}

/// One line of `stim logs --json`. Fields the model does not name are ignored.
public struct LogRecord: Decodable, Sendable {
  /// Epoch milliseconds.
  public var ts: Double
  /// `src` as written; a source newer than this app still decodes.
  public var src: String
  public var level: LogLevel
  public var msg: String
  public var slot: String?
  public var event: String?
  public var platform: String?
  public var proc: String?
  public var marker: Bool?
  /// A line a child process printed, recorded as is.
  public var raw: Bool?
  public var stack: [StackFrame]?
  /// The code frame and stack lines `stim logs --errors --json` attaches to an Expo error.
  public var context: [String]?
  /// The simulator UDID or emulator serial an `agent` record's action ran on.
  public var deviceId: String?
  /// The agent-device command an `agent` record ran, such as `tap`.
  public var command: String?

  public var source: LogSource? { LogSource(rawValue: src) }
  public var date: Date { Date(timeIntervalSince1970: ts / 1000) }

  enum CodingKeys: String, CodingKey {
    case ts, src, level, msg, slot, event, platform, proc, marker, raw, stack, context, deviceId, command
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    ts = try c.decode(Double.self, forKey: .ts)
    src = try c.decode(String.self, forKey: .src)
    level = LogLevel(rawValue: try c.decode(String.self, forKey: .level)) ?? .info
    msg = try c.decode(String.self, forKey: .msg)
    slot = try? c.decodeIfPresent(String.self, forKey: .slot)
    event = try? c.decodeIfPresent(String.self, forKey: .event)
    platform = try? c.decodeIfPresent(String.self, forKey: .platform)
    proc = try? c.decodeIfPresent(String.self, forKey: .proc)
    marker = try? c.decodeIfPresent(Bool.self, forKey: .marker)
    raw = try? c.decodeIfPresent(Bool.self, forKey: .raw)
    stack = try? c.decodeIfPresent([StackFrame].self, forKey: .stack)
    context = try? c.decodeIfPresent([String].self, forKey: .context)
    deviceId = try? c.decodeIfPresent(String.self, forKey: .deviceId)
    command = try? c.decodeIfPresent(String.self, forKey: .command)
  }

  /// Decodes one NDJSON line, or nil for a line that is not a record.
  public static func parse(_ line: some StringProtocol) -> LogRecord? {
    guard !line.isEmpty else { return nil }
    return try? JSONDecoder().decode(LogRecord.self, from: Data(line.utf8))
  }

  /// The record as one line of plain text, stack frames on following lines.
  public var plainText: String {
    var text = "\(date.formatted(Self.timeFormat)) \(level.rawValue.uppercased()) \(src)"
    if let slot { text += " [\(slot)]" }
    text += " \(msg)"
    for frame in stack ?? [] { text += "\n    at \(frame.description)" }
    return text
  }

  /// What VoiceOver reads for a log row: level, source, slot, time and message, then how many records the row
  /// groups when it groups more than one. `source` and `title` are the row's displayed source name and message.
  public func accessibilityLabel(source: String, title: String, recordCount: Int = 1) -> String {
    let level =
      switch level {
      case .debug: "Debug"
      case .info: "Info"
      case .warn: "Warning"
      case .error: "Error"
      case .fatal: "Fatal"
      }
    var parts = [level, source]
    if let slot { parts.append("slot \(slot)") }
    parts.append(date.formatted(Self.timeFormat))
    parts.append(title)
    if recordCount > 1 { parts.append(countLabel(recordCount, "record")) }
    return parts.joined(separator: ", ")
  }

  public static let timeFormat = Date.VerbatimFormatStyle(
    format: """
      \(hour: .twoDigits(clock: .twentyFourHour, hourCycle: .zeroBased)):\(minute: .twoDigits):\(second: .twoDigits)\
      .\(secondFraction: .fractional(3))
      """,
    timeZone: .current, calendar: .current)
}

/// A stack frame as the producer reported it; any field can be missing.
public struct StackFrame: Decodable, Sendable {
  public var file: String?
  public var line: Int?
  public var column: Int?
  public var fn: String?

  enum CodingKeys: String, CodingKey { case file, line, column, fn }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    file = try? c.decodeIfPresent(String.self, forKey: .file)
    line = try? c.decodeIfPresent(Int.self, forKey: .line)
    column = try? c.decodeIfPresent(Int.self, forKey: .column)
    fn = try? c.decodeIfPresent(String.self, forKey: .fn)
  }

  public var description: String {
    var location = file ?? "?"
    if let line { location += ":\(line)" + (column.map { ":\($0)" } ?? "") }
    return fn.map { "\($0) (\(location))" } ?? location
  }
}
