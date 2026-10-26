import EmulatorFrames
import SimulatorFrames
import SwiftUI

enum DeviceAudioTarget: Sendable {
  case simulator(String)
  case emulator(serial: String, avdName: String)

  struct Volume: Sendable {
    let current: Int
    let maximum: Int
  }

  var id: String {
    switch self {
    case .simulator(let udid): return "ios.\(udid)"
    case .emulator(_, let avdName): return "android.\(avdName)"
    }
  }

  var title: String {
    switch self {
    case .simulator: return "Sound"
    case .emulator: return "Media sound"
    }
  }

  var help: String {
    switch self {
    case .simulator: return "Play this simulator's sound through its selected output"
    case .emulator: return "Play music and video from this emulator; alarms and ringtones are separate"
    }
  }

  func read() async throws -> Volume {
    switch self {
    case .simulator(let udid): return Volume(current: try await SimulatorAudio.read(udid: udid), maximum: 100)
    case .emulator(let serial, let avdName):
      let read = try await EmulatorAudio.read(serial: serial, avdName: avdName)
      return Volume(current: read.current, maximum: read.maximum)
    }
  }

  func setVolume(_ volume: Int) async throws -> Volume {
    switch self {
    case .simulator(let udid): return Volume(current: try await SimulatorAudio.setVolume(volume, udid: udid), maximum: 100)
    case .emulator(let serial, let avdName):
      let read = try await EmulatorAudio.setVolume(volume, serial: serial, avdName: avdName)
      return Volume(current: read.current, maximum: read.maximum)
    }
  }
}

struct DeviceAudioOptionsView: View {
  let target: DeviceAudioTarget
  let canControl: Bool
  @State private var volume: Int?
  @State private var maximum = 100
  @State private var busy = false
  @State private var error: String?
  @State private var operation: Task<Void, Never>?

  var body: some View {
    VStack(alignment: .leading, spacing: Space.sm) {
      if let volume {
        Toggle(target.title, isOn: Binding(get: { volume > 0 }, set: { setSound($0) }))
          .disabled(busy || !canControl)
          .help(target.help)
      } else {
        HStack {
          Text(target.title)
          Spacer()
          if busy { ProgressView().controlSize(.small) } else { Text("Unavailable").foregroundStyle(Palette.secondary) }
        }
      }
      if let error {
        Text(error).font(.stim(.caption)).foregroundStyle(Palette.warning)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .task(id: canControl) {
      guard canControl else { return }
      busy = true
      defer { busy = false }
      do {
        let read = try await target.read()
        try Task.checkCancellation()
        volume = read.current
        maximum = read.maximum
      } catch is CancellationError {} catch { self.error = error.localizedDescription }
    }
    .onDisappear { operation?.cancel() }
    .onChange(of: canControl) { _, allowed in
      if !allowed { operation?.cancel() }
    }
  }

  private func setSound(_ enabled: Bool) {
    guard canControl, !busy, let volume else { return }
    let key = "deviceSoundVolume.\(target.id)"
    if !enabled, volume > 0 { UserDefaults.standard.set(volume, forKey: key) }
    let remembered = UserDefaults.standard.integer(forKey: key)
    let desired = enabled ? ((1...maximum).contains(remembered) ? remembered : max(1, maximum * 3 / 5)) : 0
    busy = true
    error = nil
    operation = Task {
      defer { busy = false }
      do {
        let updated = try await target.setVolume(desired)
        try Task.checkCancellation()
        self.volume = updated.current
        maximum = updated.maximum
      } catch is CancellationError {
      } catch {
        self.error = error.localizedDescription
      }
    }
  }
}
