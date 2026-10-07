#if DEBUG
  import StimKit
  import SwiftUI

  struct ComponentGallery: View {
    static let windowID = "gallery"
    @State private var screen = PlaygroundScreen.notifications
    @State private var scenario = PlaygroundScenario.ready
    @State private var compact = false
    @State private var dark = false
    @State private var highContrast = false
    @State private var largeText = false
    @State private var reset = 0

    private var appearance: NSAppearance.Name {
      if highContrast { return dark ? .accessibilityHighContrastDarkAqua : .accessibilityHighContrastAqua }
      return dark ? .darkAqua : .aqua
    }

    var body: some View {
      VStack(spacing: 0) {
        ScrollView(.horizontal) {
          HStack(spacing: Space.md) {
            Picker("Screen", selection: $screen) {
              ForEach(PlaygroundScreen.allCases) { Text($0.rawValue).tag($0) }
            }
            .frame(width: 250)
            Picker("Scenario", selection: $scenario) {
              ForEach(screen.scenarios) { Text($0.rawValue).tag($0) }
            }
            .frame(width: 190)
            Toggle("Compact", isOn: $compact)
            Toggle("Dark", isOn: $dark)
            Button("Reset") { reset += 1 }
          }
          .padding(Space.md)
        }
        HStack(spacing: Space.lg) {
          Toggle("Large text", isOn: $largeText)
          Toggle("Increase contrast", isOn: $highContrast)
          Spacer()
          Text(screen == .archivedSidebar || screen == .archivedWorkspace ? "Archived history fixtures" : "DEBUG fixtures")
            .foregroundStyle(Palette.secondary)
        }
        .font(.stim(.caption)).padding(.horizontal, Space.md).padding(.bottom, Space.md)
        Divider()
        ScrollView(.horizontal) {
          AppearanceHost(appearance: appearance) {
            Group {
              if screen == .tokens {
                GalleryColumn()
              } else {
                PlaygroundScreenView(screen: screen, scenario: scenario)
                  .id("\(screen.rawValue)-\(scenario.rawValue)-\(reset)")
              }
            }
            .environment(\.colorScheme, dark ? .dark : .light)
            .environment(\.dynamicTypeSize, largeText ? .accessibility3 : .large)
          }
          .frame(width: compact ? 380 : 900)
          .frame(maxHeight: .infinity)
          .overlay(Rectangle().strokeBorder(Palette.border))
          .padding(Space.lg)
        }
      }
      .frame(minWidth: 640, minHeight: 640)
      .onChange(of: screen) { _, screen in
        if !screen.scenarios.contains(scenario) { scenario = .ready }
      }
    }
  }

  struct HostedDeviceGallery: View {
    var scenario: PlaygroundScenario
    var platform: String

    var body: some View {
      let state = scenario == .empty ? "stopped" : scenario == .error ? "unverified" : "ready"
      let iosJson = """
        {"name":"iPhone 17 Pro","udid":"","owned":false,"state":"\(state)",
         "host":{"machine":"janics-mac-mini:7443","session":"hosted-ios-gallery",
                 "device":{"name":"iPhone 17 Pro","runtime":"iOS 27.0"}}}
        """
      let androidJson = """
        {"name":"pixel_6 (API 30)","serial":"","owned":false,"physical":false,"state":"\(state)",
         "host":{"machine":"janics-mac-mini:7443","session":"hosted-android-gallery",
                 "device":{"name":"pixel_6 (API 30)","systemImage":"system-images;android-30;google_apis;arm64-v8a","api":30}}}
        """
      let device: DeviceRef? =
        platform == "android"
        ? (try? JSONDecoder().decode(AndroidDevice.self, from: Data(androidJson.utf8))).map { .android(slot: "tablet", $0) }
        : (try? JSONDecoder().decode(IosDevice.self, from: Data(iosJson.utf8))).map { .ios(slot: "tablet", $0) }
      if let device {
        let link: ServerLink = scenario == .error ? .unavailable("janics-mac-mini is unavailable.") : .connecting
        DeviceTile(
          device: device, hostedPreview: PhysicalScreen(device: device, link: link, now: Date()),
          screenHeight: 360, workspace: "/fixture/hosted-\(platform)"
        )
        .padding(Space.xl)
      }
    }
  }

  /// Dynamic `NSColor`s resolve against the hosting view's `NSAppearance`, which SwiftUI's `colorScheme`
  /// environment does not set, so each column is hosted in its own `NSHostingView`.
  private struct AppearanceHost<Content: View>: NSViewRepresentable {
    var appearance: NSAppearance.Name
    @ViewBuilder var content: Content

    func makeNSView(context: Context) -> NSHostingView<Content> {
      let view = NSHostingView(rootView: content)
      view.appearance = NSAppearance(named: appearance)
      return view
    }

    func updateNSView(_ view: NSHostingView<Content>, context: Context) {
      view.appearance = NSAppearance(named: appearance)
      view.rootView = content
    }
  }

  private struct GalleryColumn: View {
    var body: some View {
      ScrollView {
        VStack(alignment: .leading, spacing: Space.xxxl) {
          section("Text styles") {
            ForEach(TextVariant.allCases, id: \.self) { style in
              HStack(alignment: .firstTextBaseline, spacing: Space.md) {
                Text(verbatim: "\(style)").textStyle(style)
                Text("\(style.size, specifier: "%g") / \(style.lineHeight, specifier: "%g")")
                  .textStyle(.caption2, mono: true)
                  .foregroundStyle(Palette.tertiary)
              }
            }
            Text("stim ios --slot fold").textStyle(.footnote, mono: true)
          }
          section("Colors") {
            FlowLayout(spacing: Space.sm, lineSpacing: Space.sm) {
              ForEach(Palette.all, id: \.name) { name, color in
                VStack(spacing: Space.xs) {
                  RoundedRectangle(cornerRadius: Radius.small).fill(color).frame(width: 56, height: 32)
                    .overlay(RoundedRectangle(cornerRadius: Radius.small).strokeBorder(Palette.border))
                  Text(name).textStyle(.caption2).foregroundStyle(Palette.secondary)
                }
              }
            }
          }
          section("Buttons") {
            ForEach(ButtonSize.allCases, id: \.self) { size in
              HStack(spacing: Space.md) {
                ForEach(ButtonVariant.allCases, id: \.self) { variant in
                  Button(String(describing: variant)) {}.buttonStyle(.stim(variant, size))
                }
                Button("Disabled") {}.buttonStyle(.stim(.primary, size)).disabled(true)
              }
            }
          }
          section("Icon buttons") {
            HStack(spacing: Space.md) {
              IconButton(systemImage: "gearshape", help: "Settings") {}
              IconButton(systemImage: "cursorarrow.rays", tint: Palette.accent, badge: "2", help: "Agents") {}
              Button {
              } label: {
                Image(systemName: "line.3.horizontal.decrease")
              }.buttonStyle(.icon(active: true))
            }
          }
          section("Icon sizes") {
            FlowLayout(spacing: Space.lg, lineSpacing: Space.md) {
              ForEach(Self.iconSizes, id: \.name) { name, size in
                VStack(spacing: Space.xs) {
                  Image(systemName: "gearshape").iconFont(size).frame(height: IconSize.large)
                  Text(name).textStyle(.caption2)
                  Text("\(size, specifier: "%g") pt").textStyle(.caption2, mono: true).foregroundStyle(Palette.secondary)
                }
              }
            }
          }
          section("Hover rows") {
            VStack(alignment: .leading, spacing: Space.xxs) {
              ForEach(["Hover row", "Selected row", "Disabled row"], id: \.self) { title in
                Button {
                } label: {
                  Text(title).padding(.horizontal, Space.md).frame(maxWidth: .infinity, minHeight: 28, alignment: .leading)
                }
                .buttonStyle(.hoverRow(selected: title == "Selected row"))
                .disabled(title == "Disabled row")
              }
              Text("Row with a tap gesture").padding(.horizontal, Space.md).frame(minHeight: 28).hoverHighlight()
            }
            .frame(width: 240)
          }
          section("Pills") {
            ForEach(Pill<Text>.Size.allCases, id: \.self) { size in
              FlowLayout(spacing: Space.sm, lineSpacing: Space.sm) {
                ForEach(Tone.allCases, id: \.self) { tone in
                  Pill(String(describing: tone), tone: tone, size: size)
                }
                Pill(tone: .brand, size: size, outlined: true) { Text("outlined") }
              }
            }
          }
          section("Banners") {
            ForEach(Tone.allCases, id: \.self) { tone in
              Banner(tone: tone, icon: "exclamationmark.triangle.fill") {
                Text(verbatim: "\(tone) banner").textStyle(.body, weight: .semibold)
                Text("A message with more detail.").foregroundStyle(Palette.secondary)
              } trailing: {
                Button("Do it") {}.buttonStyle(.stim(.primary))
              }
            }
            Banner(tone: .accent, icon: "arrow.up.circle", style: .floating, onDismiss: {}) {
              Text("Floating banner").textStyle(.headline)
              Text("Anchored over the content.").foregroundStyle(Palette.secondary)
            }
          }
          section("Lists") {
            ListSection("Grouped", Self.rows, id: \.self) { row in
              ListRow {
                StatusDot(color: Palette.success)
                Text(row)
                Spacer()
                Pill("live", tone: .success, size: .small)
              }
            }
            ListSection("Separated", Self.rows, id: \.self, style: .separated) { row in
              ListRow(compact: true) {
                Text(row)
                Spacer()
                Button("Stop") {}.buttonStyle(.stim(.destructive))
              }
            }
          }
          section("Cards") {
            Card {
              Text("Default card").padding(Space.lg)
            }
            Card(radius: Radius.control, fill: Palette.raised, border: Palette.separator) {
              Text("Control radius, raised fill, separator border").padding(Space.lg)
            }
            ForEach([true, false], id: \.self) { clipsContent in
              Card(radius: Radius.chip, border: nil, clipsContent: clipsContent) {
                Text(clipsContent ? "Borderless, clipped content" : "Borderless, unclipped content")
                  .padding(Space.lg)
                  .frame(maxWidth: .infinity, alignment: .leading)
                  .overlay(alignment: .trailing) {
                    Circle().fill(Palette.accent).frame(width: 24, height: 24).offset(x: Space.md)
                  }
              }
            }
          }
          section("Terminal") {
            TerminalCard(
              lines: [
                TerminalLine(text: "$ stim ios", kind: .command),
                TerminalLine(text: "Checking workspace", kind: .output),
                TerminalLine(text: "Dependencies ready", kind: .ok),
                TerminalLine(text: "Cache miss", kind: .failed),
                TerminalLine(text: "Prebuild skipped", kind: .skipped),
                TerminalLine(text: "Building app", kind: .pending),
              ], mode: .live)
          }
          section("Status dots") {
            ForEach([CGFloat(6), CGFloat(7)], id: \.self) { size in
              HStack(spacing: Space.md) {
                Text("\(size, specifier: "%g") pt").textStyle(.caption2, mono: true)
                StatusDot(color: Palette.success, size: size)
                Text("Filled")
                StatusDot(color: Palette.success, filled: false, size: size)
                Text("Hollow")
              }
            }
          }
          section("Progress bars") {
            Text("Determinate (50%)").textStyle(.caption)
            StimProgressBar(value: 0.5)
            Text("Indeterminate").textStyle(.caption)
            StimProgressBar(value: nil)
          }
          section("Inline empty state") {
            InlineEmpty("No items yet")
          }
        }
        .textStyle(.body)
        .foregroundStyle(Palette.text)
        .padding(Space.xxl)
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .background(Palette.background)
    }

    private func section<Content: View>(_ title: String, @ViewBuilder _ content: () -> Content) -> some View {
      VStack(alignment: .leading, spacing: Space.md) {
        SectionLabel(title: title)
        content()
      }
    }

    private static let rows = ["iPhone 17 Pro", "Pixel 9"]
    private static let iconSizes: [(name: String, size: CGFloat)] = [
      ("micro", IconSize.micro),
      ("indicator", IconSize.indicator),
      ("compact", IconSize.compact),
      ("small", IconSize.small),
      ("control", IconSize.control),
      ("regular", IconSize.regular),
      ("row", IconSize.row),
      ("medium", IconSize.medium),
      ("large", IconSize.large),
    ]
  }
#endif
