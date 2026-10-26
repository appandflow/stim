import Foundation
import StimKit

/// The Settings window's fields and values for one directory, read from the matching local server.
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

  #if DEBUG
    private(set) var inMemory = false

    init(fixtures: [SettingField], payload: SettingsPayload?, error: String? = nil) {
      let cli = Task { StimCLI(environment: [:]) }
      self.cli = cli
      machine = MachineSettingsStore(cli: cli, server: { nil }, actions: { nil })
      fields = fixtures
      self.payload = payload
      loadError = error
      inMemory = true
    }
  #endif

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
    #if DEBUG
      if inMemory { return }
    #endif
    let cli = cli
    let cwd = directory ?? NSHomeDirectory()
    Task.detached {
      let cli = await cli.value
      let connection = await ServerSession.shared.statsConnection
      let schema = await Result.awaiting { try await readServerSettingsSchema(cli: cli, connection: connection) }
      let payload = await Result.awaiting { try await readServerSettings(cli: cli, connection: connection, cwd: cwd) }
      await MainActor.run {
        guard self.directory == directory else { return }
        switch schema {
        case .success(let fields):
          self.fields = fields
          self.schemaError = nil
        case .failure(let error):
          self.fields = []
          self.schemaError = error.localizedDescription
        }
        switch payload {
        case .success(let payload):
          self.payload = payload
          self.loadError = nil
        case .failure(let error):
          self.payload = nil
          self.loadError = "Could not load settings: \(error.localizedDescription)"
        }
      }
    }
  }

  /// Runs `stim settings set`, or `unset` for a nil value, then reloads every value. A machine-scope write goes
  /// through the machine settings store, whose `revision` makes the window reload.
  func write(_ field: SettingField, scope: SettingScope, value: JSONValue?) {
    #if DEBUG
      if inMemory {
        guard var entry = payload?.entry(field.key) else { return }
        entry.layers[scope.rawValue] = value
        let winner = [SettingScope.workspace, .repo, .committed, .machine].first { entry.layers[$0.rawValue] != nil }
        entry.value = winner.flatMap { entry.layers[$0.rawValue] } ?? field.defaultValue ?? .null
        entry.origin = winner?.rawValue ?? "default"
        payload = payload?.merging(entry)
        return
      }
    #endif
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

}
