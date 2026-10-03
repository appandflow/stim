import SimulatorFrames
import SwiftUI

struct SimulatorOptionsView: View {
  let udid: String
  let canControl: Bool
  @State private var appearance: SimulatorAppearance?
  @State private var busy = false
  @State private var error: String?
  @State private var operation: Task<Void, Never>?

  var body: some View {
    VStack(alignment: .leading, spacing: Space.md) {
      HStack {
        Text("Simulator options").font(.stim(.headline))
        Spacer()
        if busy { ProgressView().controlSize(.small) }
        Button("Refresh", systemImage: "arrow.clockwise") { load() }
          .labelStyle(.iconOnly)
          .nativeControlStyle()
          .disabled(busy || !canControl)
      }
      if let appearance {
        mode(appearance)
        textSize(appearance)
        toggle(
          "Larger accessibility sizes", value: appearance.largerAccessibilitySizesEnabled,
          change: SimulatorOptions.Change.largerSizes)
        Divider()
        toggle("Increase contrast", value: appearance.increaseContrast, change: SimulatorOptions.Change.increaseContrast)
        toggle("Reduce motion", value: appearance.reduceMotion?.enabled, change: SimulatorOptions.Change.reduceMotion)
        toggle(
          "Reduce transparency", value: appearance.reduceTransparency?.enabled, change: SimulatorOptions.Change.reduceTransparency
        )
        toggle("Show button borders", value: appearance.showBorders?.enabled, change: SimulatorOptions.Change.showBorders)
      } else if !busy {
        Text("Appearance settings are unavailable.").foregroundStyle(Palette.secondary)
      }
      if let error {
        Text(error)
          .font(.stim(.caption))
          .foregroundStyle(Palette.warning)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .font(.stim(.callout))
    .controlSize(.small)
    .frame(width: 300)
    .padding(Space.lg)
    .onAppear { load() }
    .onDisappear { operation?.cancel() }
    .onChange(of: canControl) { _, allowed in
      if !allowed { operation?.cancel() }
    }
  }

  @ViewBuilder private func mode(_ appearance: SimulatorAppearance) -> some View {
    if let mode = appearance.mode {
      Picker("Appearance", selection: Binding(get: { mode }, set: { apply(.mode($0)) })) {
        ForEach(SimulatorAppearance.Mode.allCases, id: \.self) { mode in
          Text(mode.rawValue.capitalized).tag(mode)
        }
      }
      .disabled(busy || !canControl)
    } else {
      unavailable("Appearance")
    }
  }

  @ViewBuilder private func textSize(_ appearance: SimulatorAppearance) -> some View {
    if let size = appearance.size {
      Picker("Text size", selection: Binding(get: { size }, set: { apply(.textSize($0)) })) {
        ForEach(SimulatorAppearance.TextSize.allCases, id: \.self) { option in
          Text(option.label).tag(option)
            .disabled(option.isAccessibilitySize && appearance.largerAccessibilitySizesEnabled != true)
        }
      }
      .disabled(busy || !canControl)
    } else {
      unavailable("Text size")
    }
  }

  @ViewBuilder private func toggle(
    _ title: String, value: Bool?, change: @escaping (Bool) -> SimulatorOptions.Change
  ) -> some View {
    if let value {
      Toggle(title, isOn: Binding(get: { value }, set: { apply(change($0)) }))
        .disabled(busy || !canControl)
    } else {
      unavailable(title)
    }
  }

  private func unavailable(_ title: String) -> some View {
    HStack {
      Text(title)
      Spacer()
      Text("Unavailable").foregroundStyle(Palette.secondary)
    }
  }

  private func load() { run(nil) }
  private func apply(_ change: SimulatorOptions.Change) { run(change) }

  private func run(_ change: SimulatorOptions.Change?) {
    guard canControl, !busy else { return }
    busy = true
    error = nil
    operation = Task {
      defer { busy = false }
      do {
        let updated: SimulatorAppearance
        if let change {
          updated = try await SimulatorOptions.apply(change, udid: udid)
        } else {
          updated = try await SimulatorOptions.read(udid: udid)
        }
        try Task.checkCancellation()
        appearance = updated
      } catch is CancellationError {
      } catch {
        self.error = error.localizedDescription
      }
    }
  }
}
