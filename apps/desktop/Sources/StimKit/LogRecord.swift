import Foundation

public enum LogSource: String, CaseIterable, Sendable {
  case metro, client, device, build
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
  public var stack: [StackFrame]?

  public var source: LogSource? { LogSource(rawValue: src) }
  public var date: Date { Date(timeIntervalSince1970: ts / 1000) }

  enum CodingKeys: String, CodingKey {
    case ts, src, level, msg, slot, event, platform, proc, marker, stack
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
    stack = try? c.decodeIfPresent([StackFrame].self, forKey: .stack)
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
