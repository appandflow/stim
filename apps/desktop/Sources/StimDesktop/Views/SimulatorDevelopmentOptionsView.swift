import SimulatorFrames
import SwiftUI

struct SimulatorDevelopmentOptionsView: View {
  let udid: String
  let canControl: Bool
  @State private var settings: SimulatorDevelopmentOptions.Settings?
  @State private var busy = false
  @State private var error: String?
  @State private var operation: Task<Void, Never>?
  @State private var polling = SimulatorOptionsPolling()

  var body: some View {
    VStack(alignment: .leading, spacing: Space.md) {
      HStack {
        Text("Development").font(.stim(.headline))
      }
      if let slow = settings?.slowAnimations {
        Toggle("Slow animations", isOn: Binding(get: { slow }, set: { run(.slow($0)) }))
          .disabled(busy || !canControl)
      } else {
        HStack {
          Text("Slow animations")
          Spacer()
          Text("Unavailable").foregroundStyle(Palette.secondary)
        }
      }
      Button("Shake", systemImage: "iphone.radiowaves.left.and.right") { run(.shake) }
        .disabled(busy || !canControl || settings?.canShake != true)
      if let error {
        Text(error).font(.stim(.caption)).foregroundStyle(Palette.warning)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .task(id: canControl) {
      guard canControl else { return }
      await SimulatorOptionsPolling.run { await poll() }
    }
    .onDisappear { operation?.cancel() }
    .onChange(of: canControl) { _, allowed in
      if !allowed { operation?.cancel() }
    }
  }

  private enum Action: Sendable {
    case slow(Bool)
    case shake
  }

  private func poll() async {
    guard canControl, polling.canStartRead else { return }
    let token = polling.token
    do {
      let read = try await SimulatorDevelopmentOptions.readBounded(udid: udid)
      guard polling.accepts(token) else { return }
      if settings == nil { error = nil }
      settings = read
    } catch is CancellationError {
    } catch {
      guard !Task.isCancelled, polling.accepts(token), settings == nil else { return }
      self.error = error.localizedDescription
    }
  }

  private func run(_ action: Action) {
    guard canControl, !busy else { return }
    busy = true
    error = nil
    polling.beginChange()
    operation = Task {
      defer {
        polling.endChange()
        busy = false
      }
      do {
        try Task.checkCancellation()
        let updated: SimulatorDevelopmentOptions.Settings
        switch action {
        case .slow(let enabled): updated = try await SimulatorDevelopmentOptions.setSlowAnimationsBounded(enabled, udid: udid)
        case .shake: updated = try await SimulatorDevelopmentOptions.shakeBounded(udid: udid)
        }
        try Task.checkCancellation()
        settings = updated
      } catch is CancellationError {
      } catch {
        self.error = error.localizedDescription
      }
    }
  }
}
