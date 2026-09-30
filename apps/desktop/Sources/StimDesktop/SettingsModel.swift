import Foundation
import StimKit

/// The Settings window's view of `stim settings`: the fields from the shipped
/// schema and the values `stim settings --json` reports for one directory.
@MainActor
final class SettingsModel: ObservableObject {
  @Published private(set) var fields: [SettingField] = []
  @Published private(set) var schemaError: String?
  @Published private(set) var payload: SettingsPayload?
  @Published private(set) var loadError: String?
  @Published private(set) var refusals: [String: String] = [:]
  @Published private(set) var writing: Set<String> = []
  @Published private(set) var directory: String?

  private let cli: Task<StimCLI, Never>
  private let machine: MachineSettingsStore

  init(cli: Task<StimCLI, Never>, machine: MachineSettingsStore) {
    self.cli = cli
    self.machine = machine
  }

  static func id(_ key: String, _ scope: SettingScope) -> String { "\(scope.rawValue):\(key)" }

  func fields(in scope: SettingScope) -> [SettingField] {
    fields.filter { $0.scopes.contains(scope) }
  }

  func load(directory: String?) {
    self.directory = directory
    let cli = cli
    let cwd = directory ?? NSHomeDirectory()
    let needsSchema = fields.isEmpty
    Task.detached {
      let cli = await cli.value
      let schema: Result<[SettingField], Error>? =
        needsSchema
        ? Result {
          guard let url = SettingsSchema.locate(executable: cli.executable) ?? Self.repositorySchema() else {
            throw SchemaMissing()
          }
          return try SettingsSchema.fields(from: Data(contentsOf: url))
        } : nil
      let payload = await Result.awaiting { try await cli.settings(cwd: cwd) }
      await MainActor.run {
        guard self.directory == directory else { return }
        switch schema {
        case .success(let fields): self.fields = fields
        case .failure(let error): self.schemaError = error.localizedDescription
        case nil: break
        }
        switch payload {
        case .success(let payload):
          self.payload = payload
          self.loadError = nil
        case .failure(let error):
          self.payload = nil
          self.loadError =
            "stim settings --json failed: \(error.localizedDescription) It needs a Stim version with the settings command."
        }
      }
    }
  }

  /// Runs `stim settings set`, or `unset` for a nil value, then reloads every value. A machine-scope write goes
  /// through the machine settings store, whose `revision` makes the window reload.
  func write(_ field: SettingField, scope: SettingScope, value: JSONValue?) {
    let id = Self.id(field.key, scope)
    guard !writing.contains(id) else { return }
    writing.insert(id)
    refusals[id] = nil
    let machine = machine
    let cwd = directory ?? NSHomeDirectory()
    let argument = value.map(field.argument(for:))
    Task {
      let result = await machine.write(field.key, value: argument, scope: scope, cwd: cwd)
      writing.remove(id)
      switch result {
      case .success(.written): break
      case .success(.refused(let refusal)):
        refusals[id] = [refusal.message, refusal.remedy].compactMap { $0 }.joined(separator: " ")
      case .failure(let error):
        refusals[id] = error.localizedDescription
      }
      if scope != .machine { load(directory: directory) }
    }
  }

  struct SchemaMissing: LocalizedError {
    var errorDescription: String? {
      "Could not find \(SettingsSchema.fileName) next to the stim executable. It ships with Stim versions that have the settings command."
    }
  }

  /// `swift run` builds against this repository, whose CLI build writes the schema to `dist`.
  nonisolated private static func repositorySchema() -> URL? {
    let url = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()
      .appendingPathComponent("../../../../packages/stim-cli/dist/\(SettingsSchema.fileName)")
      .standardizedFileURL
    return FileManager.default.fileExists(atPath: url.path) ? url : nil
  }
}
