import Foundation

public enum SettingScope: String, CaseIterable, Codable, Hashable, Sendable {
  case machine, workspace, repo, committed
}

/// The editor a setting gets, chosen from its schema type.
public enum SettingControl: Hashable, Sendable {
  case picker([String])
  case toggle
  case stepper(minimum: Double?, maximum: Double?, integer: Bool)
  case filePicker
  case tokens
  case json
  case text
  case secure
}

/// One setting described by the `x-stim` annotation of `settings.schema.json`.
public struct SettingField: Hashable, Identifiable, Sendable {
  public var key: String
  public var kind: String
  public var description: String
  public var scopes: [SettingScope]
  public var choices: [String]
  public var minimum: Double?
  public var maximum: Double?
  public var integer: Bool
  public var pattern: String?
  public var defaultValue: JSONValue?
  public var env: String?
  public var sensitive: Bool
  public var committedAtRepository: Bool

  public var id: String { key }

  public var control: SettingControl {
    if sensitive { return .secure }
    switch kind {
    case "choice": return .picker(choices)
    case "boolean": return .toggle
    case "number": return .stepper(minimum: minimum, maximum: maximum, integer: integer)
    case "path": return .filePicker
    case "strings": return .tokens
    case "object": return .json
    default: return .text
    }
  }

  /// The value argument `stim settings set` takes: strings as-is, everything else as JSON.
  public func argument(for value: JSONValue) -> String {
    if case .string(let text) = value { return text }
    return value.json
  }
}

public enum SettingsSchema {
  public static let fileName = "settings.schema.json"

  public struct Invalid: LocalizedError {
    public var errorDescription: String? { "settings.schema.json is not a Stim settings schema." }
  }

  /// Every setting in the schema, each key once: the committed `.stim.json`
  /// tree first, then the machine-only settings from `$defs.machine`, each
  /// tree in dotted-key order.
  public static func fields(from data: Data) throws -> [SettingField] {
    guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw Invalid() }
    var fields: [SettingField] = []
    var seen: Set<String> = []
    let machine = (root["$defs"] as? [String: Any])?["machine"] as? [String: Any]
    for tree in [root, machine].compactMap({ $0 }) {
      collect(tree, into: &fields, seen: &seen)
    }
    guard !fields.isEmpty else { throw Invalid() }
    return fields
  }

  /// `settings.schema.json` beside the resolved `stim` executable, which is how
  /// the npm package ships it (`dist/cli.mjs` and `dist/settings.schema.json`).
  public static func locate(executable: String?, fileManager: FileManager = .default) -> URL? {
    guard let executable else { return nil }
    let resolved = URL(fileURLWithPath: executable).resolvingSymlinksInPath()
    let candidate = resolved.deletingLastPathComponent().appendingPathComponent(fileName)
    return fileManager.fileExists(atPath: candidate.path) ? candidate : nil
  }

  private static func collect(_ node: [String: Any], into fields: inout [SettingField], seen: inout Set<String>) {
    guard let properties = node["properties"] as? [String: Any] else { return }
    for name in properties.keys.sorted() {
      guard let child = properties[name] as? [String: Any] else { continue }
      if let field = field(child), !seen.contains(field.key) {
        seen.insert(field.key)
        fields.append(field)
      } else if child["x-stim"] == nil {
        collect(child, into: &fields, seen: &seen)
      }
    }
  }

  private static func field(_ schema: [String: Any]) -> SettingField? {
    guard let stim = schema["x-stim"] as? [String: Any], let key = stim["key"] as? String,
      let kind = stim["kind"] as? String
    else { return nil }
    let type = schema["type"] as? String
    return SettingField(
      key: key,
      kind: kind,
      description: schema["description"] as? String ?? "",
      scopes: (stim["scopes"] as? [String] ?? []).compactMap(SettingScope.init(rawValue:)),
      choices: schema["enum"] as? [String] ?? [],
      minimum: (schema["minimum"] as? NSNumber)?.doubleValue,
      maximum: (schema["maximum"] as? NSNumber)?.doubleValue,
      integer: type == "integer",
      pattern: schema["pattern"] as? String,
      defaultValue: schema["default"].flatMap(jsonValue),
      env: stim["env"] as? String,
      sensitive: stim["sensitive"] as? Bool ?? false,
      committedAtRepository: stim["committedAt"] as? String == "repository")
  }

  private static func jsonValue(_ any: Any) -> JSONValue? {
    guard JSONSerialization.isValidJSONObject([any]),
      let data = try? JSONSerialization.data(withJSONObject: [any], options: [.fragmentsAllowed])
    else { return nil }
    return (try? JSONDecoder().decode([JSONValue].self, from: data))?.first
  }
}
