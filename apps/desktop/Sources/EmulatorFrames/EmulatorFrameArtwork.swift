import AppKit

#if canImport(StimKit)
  import StimKit
#endif

struct EmulatorSkinLayout {
  var geometry: DeviceFrameGeometry
  var image: String
  var mask: String?
  var cornerRadius: CGFloat

  init?(_ contents: String) {
    let text = contents.split(whereSeparator: \.isNewline).map {
      $0.split(separator: "#", maxSplits: 1).first.map(String.init) ?? ""
    }.joined(separator: "\n")
    guard let expression = try? NSRegularExpression(pattern: "[{}]|\"[^\"]*\"|[^\\s{}]+") else { return nil }
    let tokens = expression.matches(in: text, range: NSRange(text.startIndex..., in: text)).compactMap { match in
      Range(match.range, in: text).map { String(text[$0]).trimmingCharacters(in: CharacterSet(charactersIn: "\"")) }
    }
    var index = 0
    guard let root = SkinNode.parse(tokens, index: &index), index == tokens.count,
      let parts = root.children["parts"], let layouts = root.children["layouts"], layouts.children.count == 1,
      let portrait = layouts.children["portrait"], let display = parts.children["device"]?.children["display"],
      let placement = portrait.children.values.first(where: { $0.values["name"] == "device" }),
      let body = parts.children["portrait"], let background = body.children["background"]?.values["image"],
      let width = portrait.number("width"), let height = portrait.number("height"),
      let screenWidth = display.number("width"), let screenHeight = display.number("height"),
      display.number("x") == 0, display.number("y") == 0,
      let x = placement.number("x"), let y = placement.number("y"),
      width > 0, height > 0, screenWidth > 0, screenHeight > 0, x >= 0, y >= 0,
      x + screenWidth <= width, y + screenHeight <= height
    else { return nil }
    geometry = DeviceFrameGeometry(
      size: CGSize(width: width, height: height), aperture: CGRect(x: x, y: y, width: screenWidth, height: screenHeight))
    image = background
    mask = body.children["foreground"]?.values["mask"]
    cornerRadius = display.number("corner_radius") ?? 0
  }
}

private struct SkinNode {
  var values: [String: String] = [:]
  var children: [String: SkinNode] = [:]

  func number(_ key: String) -> CGFloat? { values[key].flatMap(Double.init).map { CGFloat($0) } }

  static func parse(_ tokens: [String], index: inout Int) -> Self? {
    var node = Self()
    while index < tokens.count, tokens[index] != "}" {
      let key = tokens[index]
      index += 1
      guard index < tokens.count else { return nil }
      if tokens[index] == "{" {
        index += 1
        guard let child = parse(tokens, index: &index), index < tokens.count, tokens[index] == "}" else { return nil }
        node.children[key] = child
      } else {
        node.values[key] = tokens[index]
      }
      index += 1
    }
    return node
  }
}

@MainActor
enum EmulatorFrameArtwork {
  static func load(avdName: String) -> DeviceFrameArtwork? {
    let environment = ProcessInfo.processInfo.environment
    let home = FileManager.default.homeDirectoryForCurrentUser
    let avdRoot = URL(fileURLWithPath: StoragePaths(home: home.path, environment: environment).avds)
    let ini = values(avdRoot.appendingPathComponent(avdName).appendingPathExtension("ini"))
    guard let path = ini["path"] else { return nil }
    let config = values(URL(fileURLWithPath: path).appendingPathComponent("config.ini"))
    guard config["hw.sensor.hinge"] != "yes", config["hw.lcd.circular"] != "true" else { return nil }
    let skin: URL
    if let path = config["skin.path"], path.hasPrefix("/") {
      skin = URL(fileURLWithPath: path)
    } else if let name = config["hw.device.name"], !name.contains("/") {
      skin = URL(fileURLWithPath: "/Applications/Android Studio.app/Contents/plugins/android/resources/device-art-resources")
        .appendingPathComponent(name)
    } else {
      return nil
    }
    guard let contents = try? String(contentsOf: skin.appendingPathComponent("layout"), encoding: .utf8),
      let layout = EmulatorSkinLayout(contents),
      config["hw.lcd.width"].flatMap(Double.init) == Double(layout.geometry.aperture.width),
      config["hw.lcd.height"].flatMap(Double.init) == Double(layout.geometry.aperture.height),
      let background = NSImage(contentsOf: skin.appendingPathComponent(layout.image))
    else { return nil }
    let foreground = layout.mask.flatMap { NSImage(contentsOf: skin.appendingPathComponent($0)) }
    guard layout.mask == nil || foreground != nil else { return nil }
    return DeviceFrameArtwork(
      geometry: layout.geometry, cornerRadius: layout.cornerRadius,
      background: { rect in draw(background, in: rect) },
      foreground: { _ in if let foreground { draw(foreground, in: layout.geometry.aperture) } })
  }

  static func values(_ url: URL) -> [String: String] {
    guard let text = try? String(contentsOf: url, encoding: .utf8) else { return [:] }
    var values: [String: String] = [:]
    for line in text.split(whereSeparator: \.isNewline) {
      let pair = line.split(separator: "=", maxSplits: 1)
      if pair.count == 2 { values[String(pair[0])] = String(pair[1]) }
    }
    return values
  }

  private static func draw(_ image: NSImage, in rect: CGRect) {
    image.draw(in: rect, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
  }
}
