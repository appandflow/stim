import Foundation
import Testing

@testable import StimKit

private func payload(_ machines: String) -> SettingsPayload {
  try! JSONDecoder().decode(
    SettingsPayload.self,
    from: Data(
      """
      { "files": {}, "unknown": [], "settings": [
        { "key": "offload.machines", "value": \(machines), "origin": "machine", "layers": { "machine": \(machines) } },
        { "key": "recording.enabled", "value": true, "origin": "default", "layers": {} }
      ] }
      """.utf8))
}

private func entry(_ machines: String) -> SettingEntry {
  payload(machines).entry("offload.machines")!
}

private actor Backend {
  var machines = "[\"a\"]"
  var reads = 0
  var writes: [String] = []
  var failReads = false

  func read() throws -> SettingsPayload {
    reads += 1
    if failReads { throw StimCLI.Failure.exited(1, stderr: "boom") }
    return payload(machines)
  }

  func write(_ key: String, _ value: String?, _ scope: SettingScope) -> SettingsWriteResult {
    writes.append("\(scope.rawValue):\(key)=\(value ?? "unset")")
    if key == "offload.machines" { machines = value ?? "[]" }
    return .written(entry(machines))
  }

  func setFailReads(_ on: Bool) { failReads = on }
}

@MainActor private func store(_ backend: Backend) -> MachineSettingsStore {
  MachineSettingsStore(
    read: { try await backend.read() },
    write: { key, value, scope, _ in await backend.write(key, value, scope) })
}

@MainActor @Suite struct MachineSettingsStoreTests {
  @Test func concurrentRefreshesShareOneRead() async {
    let backend = Backend()
    let store = store(backend)
    async let first: Void = store.refresh()
    async let second: Void = store.refresh()
    _ = await (first, second)
    #expect(await backend.reads == 1)
    #expect(store.entry("offload.machines")?.value.strings == ["a"])
  }

  @Test func machineWriteReadsBackAndBumpsRevision() async {
    let backend = Backend()
    let store = store(backend)
    await store.refresh()
    let result = await store.write("offload.machines", value: "[\"b\"]", scope: .machine, cwd: "/home")
    guard case .success(.written) = result else {
      Issue.record("write did not report written")
      return
    }
    #expect(store.entry("offload.machines")?.value.strings == ["b"])
    #expect(store.revision == 1)
    #expect(await backend.reads == 2)
  }

  @Test func otherScopeWriteLeavesTheReadAlone() async {
    let backend = Backend()
    let store = store(backend)
    await store.refresh()
    _ = await store.write("metro.tunnel", value: "wormhole", scope: .workspace, cwd: "/repo")
    #expect(store.revision == 0)
    #expect(await backend.reads == 1)
    #expect(await backend.writes == ["workspace:metro.tunnel=wormhole"])
  }

  @Test func failedReadKeepsTheLastValueAndReportsTheError() async {
    let backend = Backend()
    let store = store(backend)
    await store.refresh()
    await backend.setFailReads(true)
    await store.refresh()
    #expect(store.entry("offload.machines")?.value.strings == ["a"])
    #expect(store.error != nil)
  }

  @Test func mergingReplacesTheEntryAndAddsAMissingOne() {
    let merged = payload("[\"a\"]").merging(entry("[\"a\",\"b\"]"))
    #expect(merged.entry("offload.machines")?.value.strings == ["a", "b"])
    #expect(merged.entry("recording.enabled") != nil)
    var bare = payload("[]")
    bare.settings.removeAll { $0.key == "offload.machines" }
    #expect(bare.merging(entry("[\"c\"]")).entry("offload.machines")?.value.strings == ["c"])
  }

  @Test func aReadStartedBeforeAWriteDoesNotOverwriteIt() async {
    let backend = Backend()
    let gate = Gate()
    let store = MachineSettingsStore(
      read: {
        let first = await backend.reads == 0
        let result = try await backend.read()
        if first { await gate.wait() }
        return result
      },
      write: { key, value, scope, _ in await backend.write(key, value, scope) })
    let slow = Task { await store.refresh() }
    await gate.entered()
    _ = await store.write("offload.machines", value: "[\"b\"]", scope: .machine, cwd: NSHomeDirectory())
    await gate.open()
    await slow.value
    #expect(store.entry("offload.machines")?.value.strings == ["b"])
  }
}

private actor Gate {
  private var waiting: CheckedContinuation<Void, Never>?
  private var isOpen = false
  private var hasEntered = false
  private var enteredWaiter: CheckedContinuation<Void, Never>?

  func wait() async {
    hasEntered = true
    enteredWaiter?.resume()
    guard !isOpen else { return }
    await withCheckedContinuation { waiting = $0 }
  }

  func entered() async {
    guard !hasEntered else { return }
    await withCheckedContinuation { enteredWaiter = $0 }
  }

  func open() {
    isOpen = true
    waiting?.resume()
  }
}
