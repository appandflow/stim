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

  static func body(_ size: CGFloat = 13, weight: Font.Weight = .regular) -> Font {
    .custom(FontFamily.sans, size: size).weight(weight)
  }

  static func heading(_ size: CGFloat) -> Font {
    .custom(FontFamily.sans, size: size).weight(.semibold)
  }

  static func mono(_ size: CGFloat = 11) -> Font {
    .custom(FontFamily.mono, size: size)
  }

  static func toneColor(_ tone: UsageTone) -> Color {
    switch tone {
    case .critical: return Palette.error
    case .warn: return Palette.warning
    case .normal: return Palette.text
    }
  }
}

extension TextVariant {
  func nsFont(mono: Bool = false) -> NSFont {
    let name = mono ? FontFamily.mono : FontFamily.sans
    return NSFont(name: name, size: size) ?? .systemFont(ofSize: size)
  }
}

extension Font {
  static func stim(_ style: TextVariant, weight: Font.Weight? = nil, mono: Bool = false) -> Font {
    mono
      ? .custom(FontFamily.mono, size: style.size)
      : .custom(FontFamily.sans, size: style.size).weight(weight ?? style.weight)
  }
}

extension View {
  /// Sets a text style's font and the line spacing that brings its lines to the style's line height.
  func textStyle(_ style: TextVariant, weight: Font.Weight? = nil, mono: Bool = false) -> some View {
    let font = style.nsFont(mono: mono)
    let natural = font.ascender - font.descender + font.leading
    return self.font(.stim(style, weight: weight, mono: mono)).lineSpacing(max(0, style.lineHeight - natural))
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
