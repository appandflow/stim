import Foundation

/// Any JSON value, for setting values whose type depends on the setting.
public enum JSONValue: Codable, Hashable, Sendable {
  case null
  case bool(Bool)
  case number(Double)
  case string(String)
  case array([JSONValue])
  case object([String: JSONValue])

  public init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    if container.decodeNil() {
      self = .null
    } else if let value = try? container.decode(Bool.self) {
      self = .bool(value)
    } else if let value = try? container.decode(Double.self) {
      self = .number(value)
    } else if let value = try? container.decode(String.self) {
      self = .string(value)
    } else if let value = try? container.decode([JSONValue].self) {
      self = .array(value)
    } else {
      self = .object(try container.decode([String: JSONValue].self))
    }
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    switch self {
    case .null: try container.encodeNil()
    case .bool(let value): try container.encode(value)
    case .number(let value): try container.encode(value)
    case .string(let value): try container.encode(value)
    case .array(let value): try container.encode(value)
    case .object(let value): try container.encode(value)
    }
  }

  public var string: String? {
    if case .string(let value) = self { return value }
    return nil
  }

  public var number: Double? {
    if case .number(let value) = self { return value }
    return nil
  }

  public var bool: Bool? {
    if case .bool(let value) = self { return value }
    return nil
  }

  public var strings: [String]? {
    guard case .array(let values) = self else { return nil }
    let strings = values.compactMap(\.string)
    return strings.count == values.count ? strings : nil
  }

  /// Compact JSON, with whole numbers written without a fraction.
  public var json: String {
    switch self {
    case .null: return "null"
    case .bool(let value): return value ? "true" : "false"
    case .number(let value):
      return value.rounded() == value && abs(value) < 1e15 ? String(Int64(value)) : String(value)
    case .string(let value):
      let data = (try? JSONEncoder().encode(value)) ?? Data()
      return String(decoding: data, as: UTF8.self)
    case .array(let values): return "[\(values.map(\.json).joined(separator: ","))]"
    case .object(let values):
      let body = values.keys.sorted().map { key in "\(JSONValue.string(key).json):\(values[key]!.json)" }
      return "{\(body.joined(separator: ","))}"
    }
  }

  /// The value as the UI shows it: strings bare, everything else as JSON.
  public var display: String {
    if case .string(let value) = self { return value }
    return json
  }
}
