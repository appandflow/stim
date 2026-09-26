import Foundation

/// The payload printed by `stim settings --json`.
public struct SettingsPayload: Decodable, Sendable {
  public var project: String?
  public var files: [String: String]
  public var settings: [SettingEntry]
  public var unknown: [UnknownSetting]

  public func entry(_ key: String) -> SettingEntry? {
    settings.first { $0.key == key }
  }

  public func file(for scope: SettingScope) -> String? { files[scope.rawValue] }
}

public struct SettingEntry: Decodable, Hashable, Sendable {
  public struct EnvOverride: Decodable, Hashable, Sendable {
    public var name: String
    public var value: String
  }

  public var key: String
  public var value: JSONValue
  /// The winning layer: a scope name, `env`, `default`, or nil when unset.
  public var origin: String?
  public var layers: [String: JSONValue]
  public var env: EnvOverride?
  public var sensitive: Bool?
  /// Why the default applies on this machine, such as `Stim Desktop installed`, for a default `stim` picks per
  /// machine; nil otherwise.
  public var defaultReason: String?

  public func layer(_ scope: SettingScope) -> JSONValue? { layers[scope.rawValue] }

  /// The effective number. `stim settings --json` reports a value set by an environment variable as the
  /// variable's string, so a numeric string counts.
  public var number: Double? { value.number ?? value.string.flatMap { Double($0.trimmingCharacters(in: .whitespaces)) } }

  /// `origin`, with `defaultReason` when there is one.
  public var originLabel: String? {
    origin.map { origin in defaultReason.map { "\(origin) (\($0))" } ?? origin }
  }

  /// The layer a value in `scope` would override: the next lower layer that holds a value, or the default. The
  /// default is the effective value while it wins, since `stim` can pick it per machine, and the schema's otherwise.
  public func overridden(by scope: SettingScope, field: SettingField) -> (source: String, value: JSONValue)? {
    let order: [SettingScope] = [.workspace, .repo, .committed, .machine]
    guard let index = order.firstIndex(of: scope) else { return nil }
    for lower in order[(index + 1)...] where field.scopes.contains(lower) {
      if let value = layer(lower) { return (lower.rawValue, value) }
    }
    if origin == "default" { return ("default", value) }
    return field.defaultValue.map { ("default", $0) }
  }
}

public struct UnknownSetting: Decodable, Hashable, Sendable {
  public var key: String
  public var scope: SettingScope
  public var file: String
  public var value: JSONValue?
}

/// A `stim settings` refusal: the one JSON payload a failed `--json` command prints.
public struct SettingsRefusal: Decodable, Error, Hashable, Sendable {
  public var code: String
  public var message: String
  public var remedy: String?
}

public enum SettingsWriteResult: Sendable {
  case written(SettingEntry)
  case refused(SettingsRefusal)
}

struct SettingsWritePayload: Decodable {
  var setting: SettingEntry
}
