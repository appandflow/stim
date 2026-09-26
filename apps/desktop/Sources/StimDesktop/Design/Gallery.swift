#if DEBUG
  import SwiftUI

  /// Every design token and kit component, in light and dark side by side.
  struct ComponentGallery: View {
    static let windowID = "gallery"

    var body: some View {
      HStack(spacing: 0) {
        AppearanceHost(appearance: .aqua) { GalleryColumn() }
        AppearanceHost(appearance: .darkAqua) { GalleryColumn() }
      }
      .frame(minWidth: 1000, minHeight: 700)
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
              Button {} label: { Image(systemName: "line.3.horizontal.decrease") }.buttonStyle(.icon(active: true))
            }
          }
          section("Pills") {
            ForEach(Pill<Text>.Size.allCases, id: \.self) { size in
              FlowLayout(spacing: Space.sm, lineSpacing: Space.sm) {
                ForEach(PillTone.allCases, id: \.self) { tone in
                  Pill(String(describing: tone), tone: tone, size: size)
                }
                Pill(tone: .accent, size: size, outlined: true) { Text("outlined") }
              }
            }
          }
          section("Banners") {
            ForEach(BannerTone.allCases, id: \.self) { tone in
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
  }
#endif
