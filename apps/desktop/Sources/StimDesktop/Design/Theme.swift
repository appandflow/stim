import AppKit
import CoreText
import StimKit
import SwiftUI

enum Theme {
  /// Applies an appearance preference to every window.
  @MainActor static func apply(_ appearance: Appearance) {
    switch appearance {
    case .auto: NSApp.appearance = nil
    case .light: NSApp.appearance = NSAppearance(named: .aqua)
    case .dark: NSApp.appearance = NSAppearance(named: .darkAqua)
    }
  }

}

extension Color {
  /// The one color each `Tone` stands for.
  init(_ tone: Tone) {
    switch tone {
    case .normal: self = Palette.text
    case .neutral: self = Palette.secondary
    case .tertiary: self = Palette.tertiary
    case .brand: self = Palette.primary
    case .accent: self = Palette.accent
    case .info: self = Palette.info
    case .success: self = Palette.success
    case .caution: self = Palette.warning
    case .warning: self = Palette.warning
    case .error: self = Palette.error
    }
  }
}

extension TextVariant {
  func nsFont(mono: Bool = false) -> NSFont {
    let name = mono ? FontFamily.mono : FontFamily.sans
    return NSFont(name: name, size: size) ?? .systemFont(ofSize: size)
  }

  /// The system text style a variant scales with when the macOS Text size setting changes.
  var scalingStyle: Font.TextStyle {
    switch self {
    case .caption2: .caption2
    case .caption: .caption
    case .footnote: .footnote
    case .callout: .callout
    case .body: .body
    case .headline: .headline
    case .title: .title
    }
  }
}

extension Font {
  static func stim(_ style: TextVariant, weight: Font.Weight? = nil, mono: Bool = false) -> Font {
    mono
      ? .custom(FontFamily.mono, size: style.size, relativeTo: style.scalingStyle)
      : .custom(FontFamily.sans, size: style.size, relativeTo: style.scalingStyle).weight(weight ?? style.weight)
  }
}

private struct StimTextStyle: ViewModifier {
  let style: TextVariant
  let weight: Font.Weight?
  let mono: Bool
  @ScaledMetric private var scale: CGFloat

  init(style: TextVariant, weight: Font.Weight?, mono: Bool) {
    self.style = style
    self.weight = weight
    self.mono = mono
    _scale = ScaledMetric(wrappedValue: 1, relativeTo: style.scalingStyle)
  }

  func body(content: Content) -> some View {
    let font = style.nsFont(mono: mono)
    let natural = font.ascender - font.descender + font.leading
    return content.font(.stim(style, weight: weight, mono: mono))
      .lineSpacing(max(0, style.lineHeight - natural) * scale)
  }
}

extension View {
  /// Sets a text style's font and the line spacing that brings its lines to the style's line height, both scaled by the Text size setting.
  func textStyle(_ style: TextVariant, weight: Font.Weight? = nil, mono: Bool = false) -> some View {
    modifier(StimTextStyle(style: style, weight: weight, mono: mono))
  }
}

extension Color {
  /// A color that follows the effective appearance, including Desktop's own Appearance setting.
  init(light: UInt32, dark: UInt32) {
    self.init(
      nsColor: NSColor(name: nil) { appearance in
        NSColor(rgba: appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light)
      })
  }

  init(rgba: UInt32) {
    self.init(nsColor: NSColor(rgba: rgba))
  }
}

extension NSColor {
  convenience init(rgba: UInt32) {
    self.init(
      srgbRed: CGFloat((rgba >> 24) & 0xFF) / 255,
      green: CGFloat((rgba >> 16) & 0xFF) / 255,
      blue: CGFloat((rgba >> 8) & 0xFF) / 255,
      alpha: CGFloat(rgba & 0xFF) / 255)
  }
}

/// The website's fonts and brand artwork. A bundled app carries copies in
/// `Contents/Resources`; `swift run` reads them from the website sources.
enum BrandAssets {
  static func registerFonts() {
    for name in ["InterVariable.woff2", "JetBrainsMono-Regular.woff2"] {
      guard let url = url(name, websitePath: "src/css/fonts") else { continue }
      CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
    }
  }

  static func jar(_ scheme: ColorScheme) -> URL? {
    url(scheme == .dark ? "stim-jar-dark.json" : "stim-jar-light.json", websitePath: "static/img/branding")
  }

  /// The wordmark's path art as a template image, so callers tint it with `Palette.primary`.
  static let wordmark: NSImage? = {
    let art = image("wordmark.svg")
    art?.isTemplate = true
    return art
  }()

  private static func image(_ name: String) -> NSImage? {
    url(name, websitePath: "static/img/branding").flatMap(NSImage.init(contentsOf:))
  }

  private static func url(_ name: String, websitePath: String) -> URL? {
    if let bundled = Bundle.main.resourceURL?.appendingPathComponent(name),
      FileManager.default.fileExists(atPath: bundled.path)
    {
      return bundled
    }
    let website = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()
      .appendingPathComponent("../../../../../website/\(websitePath)/\(name)")
      .standardizedFileURL
    return FileManager.default.fileExists(atPath: website.path) ? website : nil
  }
}
