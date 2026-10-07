import SimulatorFrames
import SwiftUI

/// The viewer's "Show device frame" choice. `unavailableReason` is why no frame can be drawn, or nil when one can.
struct DeviceFrameOption {
  let isOn: Binding<Bool>
  let unavailableReason: String?
}

struct SimulatorOptionsView: View {
  let udid: String
  let canControl: Bool
  let hasSimulator: Bool
  let title: String
  var frame: DeviceFrameOption?
  @State private var appearance: SimulatorAppearance?
  @State private var busy = false
  @State private var error: String?
  @State private var operation: Task<Void, Never>?

  #if DEBUG
    @State private var fixture: PlaygroundSimulator?

    init(fixture: PlaygroundSimulator) {
      udid = "playground"
      canControl = true
      hasSimulator = true
      title = "Simulator options"
      frame = fixture.frame
      _fixture = State(initialValue: fixture)
      _appearance = State(initialValue: fixture.appearance)
      _busy = State(initialValue: fixture.loading)
      _error = State(initialValue: fixture.error)
    }
  #endif

  init(udid: String?, title: String, frame: DeviceFrameOption?) {
    self.udid = udid ?? ""
    canControl = udid != nil
    hasSimulator = udid != nil
    self.title = title
    self.frame = frame
  }

  var body: some View {
    VStack(alignment: .leading, spacing: Space.md) {
      HStack {
        Text(title).font(.stim(.headline))
        Spacer()
        if busy { ProgressView().controlSize(.small) }
        if hasSimulator {
          Button("Refresh", systemImage: "arrow.clockwise") { load() }
            .labelStyle(.iconOnly)
            .nativeIconStyle()
            .disabled(busy || !canControl)
        }
      }
      if let frame {
        Toggle("Show device frame", isOn: frame.isOn)
          .disabled(frame.unavailableReason != nil)
          .help(frame.unavailableReason ?? "Draw the installed hardware frame around the screen")
        if let reason = frame.unavailableReason {
          Text(reason)
            .font(.stim(.caption))
            .foregroundStyle(Palette.secondary)
            .fixedSize(horizontal: false, vertical: true)
        }
        if hasSimulator { Divider() }
      }
      if let appearance, hasSimulator {
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
      } else if hasSimulator, !busy {
        Text("Appearance settings are unavailable.").foregroundStyle(Palette.secondary)
      }
      if let error {
        Text(error)
          .font(.stim(.caption))
          .foregroundStyle(Palette.warning)
          .fixedSize(horizontal: false, vertical: true)
      }
      #if DEBUG
        if fixture == nil, hasSimulator {
          Divider()
          SimulatorDevelopmentOptionsView(udid: udid, canControl: canControl)
        }
      #else
        if hasSimulator {
          Divider()
          SimulatorDevelopmentOptionsView(udid: udid, canControl: canControl)
        }
      #endif
    }
    .font(.stim(.callout))
    .controlSize(.small)
    .frame(width: 300)
    .padding(Space.lg)
    .onAppear { if hasSimulator { load() } }
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
    #if DEBUG
      if var fixture {
        fixture.apply(change)
        self.fixture = fixture
        appearance = fixture.appearance
        return
      }
    #endif
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
