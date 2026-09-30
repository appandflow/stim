import Foundation
import Observation

extension SettingsPayload {
  /// The payload with `entry` in place of the setting of the same key, as a write reports it before the next read.
  public func merging(_ entry: SettingEntry) -> SettingsPayload {
    var merged = self
    if let index = merged.settings.firstIndex(where: { $0.key == entry.key }) {
      merged.settings[index] = entry
    } else {
      merged.settings.append(entry)
    }
    return merged
  }
}

/// The one `stim settings --json` read for this Mac's own settings, in the home directory, that Stim Desktop's
/// views share. A machine-scope write through `write` shows in every reader before the next read, and `revision`
/// changes with it so a view of another directory's settings can reload.
@MainActor @Observable
public final class MachineSettingsStore {
  public typealias Read = @Sendable () async throws -> SettingsPayload
  public typealias Write =
    @Sendable (_ key: String, _ value: String?, _ scope: SettingScope, _ cwd: String) async throws
    -> SettingsWriteResult

  public private(set) var latest = Fetched<SettingsPayload>()
  public private(set) var revision = 0

  @ObservationIgnored private let read: Read
  @ObservationIgnored private let writer: Write
  @ObservationIgnored private var task: Task<Void, Never>?
  @ObservationIgnored private var taskEpoch = 0
  @ObservationIgnored private var epoch = 0

  public init(read: @escaping Read, write: @escaping Write) {
    self.read = read
    writer = write
  }

  public convenience init(cli: Task<StimCLI, Never>) {
    self.init(
      read: { try await cli.value.settings(cwd: NSHomeDirectory()) },
      write: { key, value, scope, cwd in
        try await cli.value.writeSetting(key, value: value, scope: scope, cwd: cwd)
      })
  }

  public var payload: SettingsPayload? { latest.value }
  public var error: String? { latest.error }

  public func entry(_ key: String) -> SettingEntry? { payload?.entry(key) }

  /// Reads the settings. Callers that ask while a read runs share it, unless a write finished since it started.
  public func refresh() async {
    if let task, taskEpoch == epoch {
      await task.value
      return
    }
    let epoch = epoch
    let read = read
    let started = Task {
      let result = await Result.awaiting { try await read() }
      if epoch == self.epoch { latest.record(result) }
    }
    task = started
    taskEpoch = epoch
    await started.value
    if task == started { task = nil }
  }

  /// Runs `stim settings set`, or `unset` for a nil value, in `cwd`. A machine-scope write shows in `latest` at once
  /// and is read back; a write in another scope leaves this Mac's own settings alone.
  public func write(_ key: String, value: String?, scope: SettingScope, cwd: String) async
    -> Result<SettingsWriteResult, any Error>
  {
    let writer = writer
    let result = await Result.awaiting { try await writer(key, value, scope, cwd) }
    guard scope == .machine else { return result }
    epoch += 1
    revision += 1
    if case .success(.written(let entry)) = result, let payload = latest.value {
      var merged = Fetched<SettingsPayload>()
      merged.record(.success(payload.merging(entry)))
      latest = merged
    }
    await refresh()
    return result
  }
}
