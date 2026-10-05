import SimulatorFrames
import SwiftUI

struct SimulatorDevelopmentOptionsView: View {
  let udid: String
  let canControl: Bool
  @State private var settings: SimulatorDevelopmentOptions.Settings?
  @State private var busy = false
  @State private var error: String?
  @State private var operation: Task<Void, Never>?

  var body: some View {
    VStack(alignment: .leading, spacing: Space.md) {
      HStack {
        Text("Development").font(.stim(.headline))
        Spacer()
        Button("Refresh development settings", systemImage: "arrow.clockwise") { run(.read) }
          .labelStyle(.iconOnly)
          .disabled(busy || !canControl)
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
    .onAppear { run(.read) }
    .onDisappear { operation?.cancel() }
    .onChange(of: canControl) { _, allowed in
      if !allowed { operation?.cancel() }
    }
  }

  private enum Action: Sendable {
    case read
    case slow(Bool)
    case shake
  }

  private func run(_ action: Action) {
    guard canControl, !busy else { return }
    busy = true
    error = nil
    operation = Task {
      defer { busy = false }
      do {
        try Task.checkCancellation()
        let updated: SimulatorDevelopmentOptions.Settings
        switch action {
        case .read: updated = try await SimulatorDevelopmentOptions.read(udid: udid)
        case .slow(let enabled): updated = try await SimulatorDevelopmentOptions.setSlowAnimations(enabled, udid: udid)
        case .shake: updated = try await SimulatorDevelopmentOptions.shake(udid: udid)
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
