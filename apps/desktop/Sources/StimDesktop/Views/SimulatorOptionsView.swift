import SimulatorFrames
import SwiftUI

struct DeviceFrameOption {
  let isOn: Binding<Bool>
  private let reason: () -> String?
  var unavailableReason: String? { reason() }

  init(isOn: Binding<Bool>, unavailableReason: @autoclosure @escaping () -> String?) {
    self.isOn = isOn
    reason = unavailableReason
  }
}

struct DeviceFrameToggle: View {
  let frame: DeviceFrameOption

  var body: some View {
    Toggle("Show device frame", isOn: frame.unavailableReason == nil ? frame.isOn : .constant(false))
      .disabled(frame.unavailableReason != nil)
      .help(frame.unavailableReason ?? "Draw the installed hardware frame around the screen")
    if let reason = frame.unavailableReason {
      Text(reason)
        .font(.stim(.caption))
        .foregroundStyle(Palette.secondary)
        .fixedSize(horizontal: false, vertical: true)
    }
  }
}

struct SimulatorOptionsView: View {
  let udid: String
  let canControl: Bool
  var clipboard: ClipboardOptionsView? = nil
  var frame: DeviceFrameOption?
  @State private var appearance: SimulatorAppearance?
  @State private var busy = false
  @State private var error: String?
  @State private var operation: Task<Void, Never>?
  @State private var loaded = false
  @State private var polling = SimulatorOptionsPolling()

  #if DEBUG
    @State private var fixture: PlaygroundSimulator?

    init(fixture: PlaygroundSimulator) {
      udid = "playground"
      canControl = true
      clipboard = ClipboardOptionsView(paste: {}, copy: {})
      frame = fixture.frame
      _fixture = State(initialValue: fixture)
      _appearance = State(initialValue: fixture.appearance)
      _busy = State(initialValue: fixture.loading)
      _loaded = State(initialValue: !fixture.loading)
      _error = State(initialValue: fixture.error)
    }
  #endif

  init(udid: String, canControl: Bool, clipboard: ClipboardOptionsView? = nil, frame: DeviceFrameOption? = nil) {
    self.udid = udid
    self.canControl = canControl
    self.clipboard = clipboard
    self.frame = frame
  }

  var body: some View {
    VStack(alignment: .leading, spacing: Space.md) {
      HStack {
        Text("Simulator options").font(.stim(.headline))
        Spacer()
        if busy || (!loaded && canControl) { ProgressView().controlSize(.small) }
      }
      if let frame {
        DeviceFrameToggle(frame: frame)
        Divider()
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
      } else if !busy && (loaded || !canControl) {
        Text("Appearance settings are unavailable.").foregroundStyle(Palette.secondary)
      }
      if let error {
        Text(error)
          .font(.stim(.caption))
          .foregroundStyle(Palette.warning)
          .fixedSize(horizontal: false, vertical: true)
      }
      if let clipboard {
        Divider()
        clipboard
      }
      #if DEBUG
        if fixture == nil {
          Divider()
          SimulatorDevelopmentOptionsView(udid: udid, canControl: canControl)
        }
      #else
        Divider()
        SimulatorDevelopmentOptionsView(udid: udid, canControl: canControl)
      #endif
    }
    .font(.stim(.callout))
    .controlSize(.small)
    .frame(width: 300)
    .padding(Space.lg)
    .task(id: canControl) {
      guard canControl else { return }
      await SimulatorOptionsPolling.run { await poll() }
    }
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

  private func apply(_ change: SimulatorOptions.Change) { run(change) }

  private func poll() async {
    #if DEBUG
      if fixture != nil { return }
    #endif
    guard canControl, polling.canStartRead else { return }
    let token = polling.token
    do {
      let read = try await SimulatorOptions.read(udid: udid)
      guard polling.accepts(token) else { return }
      if appearance == nil { error = nil }
      appearance = read
    } catch is CancellationError {
    } catch {
      guard !Task.isCancelled, polling.accepts(token), appearance == nil else { return }
      self.error = error.localizedDescription
    }
    if polling.accepts(token) { loaded = true }
  }

  private func run(_ change: SimulatorOptions.Change) {
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
    polling.beginChange()
    operation = Task {
      defer {
        polling.endChange()
        busy = false
      }
      do {
        let updated = try await SimulatorOptions.apply(change, udid: udid)
        try Task.checkCancellation()
        appearance = updated
        loaded = true
      } catch is CancellationError {
      } catch {
        self.error = error.localizedDescription
      }
    }
  }
}
