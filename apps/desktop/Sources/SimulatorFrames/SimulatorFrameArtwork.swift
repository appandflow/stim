// Copyright (c) 2026 Siniulator contributors. Adapted under the MIT license in Support/Siniulator-LICENSE.txt.
import AppKit
import StimKit

@MainActor
enum SimulatorFrameArtwork {
  static func load(udid: String) -> DeviceFrameArtwork? {
    guard let resources = resources(udid: udid) else { return nil }
    let profile = plist(resources.appendingPathComponent("profile.plist"))
    let capabilities = plist(resources.appendingPathComponent("capabilities.plist"))["capabilities"] as? [String: Any]
    guard let displays = capabilities?["displays"] as? [[String: Any]] else { return nil }
    let integrated = displays.filter { $0["displayType"] as? String == "integrated" }
    guard integrated.count == 1, let display = integrated.first,
      (number(display, "nativeRotation") ?? 0) == 0,
      let chromeID = profile["chromeIdentifier"] as? String,
      let name = chromeID.split(separator: ".").last,
      let width = number(display, "width"), let height = number(display, "height"),
      let scale = number(display, "scale"), width > 0, height > 0, scale > 0
    else { return nil }
    let chrome = URL(fileURLWithPath: "/Library/Developer/DeviceKit/Chrome/\(name).devicechrome/Contents/Resources")
    guard let data = try? Data(contentsOf: chrome.appendingPathComponent("chrome.json")),
      let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let images = json["images"] as? [String: Any],
      let sizing = images["sizing"] as? [String: Any],
      let left = number(sizing, "leftWidth"), let right = number(sizing, "rightWidth"),
      let top = number(sizing, "topHeight"), let bottom = number(sizing, "bottomHeight")
    else { return nil }
    let padding = images["devicePadding"] as? [String: Any] ?? [:]
    let padLeft = number(padding, "left") ?? 0
    let padRight = number(padding, "right") ?? 0
    let padTop = number(padding, "top") ?? 0
    let padBottom = number(padding, "bottom") ?? 0
    let screen = CGSize(width: width / scale, height: height / scale)
    let body = CGRect(x: padLeft, y: padTop, width: screen.width + left + right, height: screen.height + top + bottom)
    let aperture = CGRect(x: body.minX + left, y: body.minY + top, width: screen.width, height: screen.height)
    let geometry = DeviceFrameGeometry(
      size: CGSize(width: body.maxX + padRight, height: body.maxY + padBottom), aperture: aperture)
    let names = ["topLeft", "top", "topRight", "left", "right", "bottomLeft", "bottom", "bottomRight"]
    let pieces = names.compactMap { key -> NSImage? in
      guard let name = images[key] as? String else { return nil }
      return NSImage(contentsOf: chrome.appendingPathComponent(name).appendingPathExtension("pdf"))
    }
    guard pieces.count == names.count else { return nil }
    let paths = json["paths"] as? [String: Any]
    let outer = paths?["simpleOutsideBorder"] as? [String: Any] ?? [:]
    let outerRadius = number(outer, "cornerRadiusX") ?? 0
    let buttons = (json["inputs"] as? [[String: Any]] ?? []).compactMap { input -> (NSImage, CGRect)? in
      guard let name = input["image"] as? String,
        let image = NSImage(contentsOf: chrome.appendingPathComponent(name).appendingPathExtension("pdf")),
        let offsets = input["offsets"] as? [String: Any], let normal = offsets["normal"] as? [String: Any],
        let x = number(normal, "x"), let y = number(normal, "y")
      else { return nil }
      let position = input["anchor"] as? String == "right" ? body.maxX + x : body.minX + x - image.size.width
      return (image, CGRect(x: position, y: body.minY + y, width: image.size.width, height: image.size.height))
    }
    return DeviceFrameArtwork(
      geometry: geometry, cornerRadius: number(display, "cornerRadiusUL") ?? 0,
      background: { _ in
        NSColor.black.setFill()
        NSBezierPath(roundedRect: body, xRadius: outerRadius, yRadius: outerRadius).fill()
        for (image, rect) in buttons { draw(image, in: rect) }
        drawEdges(pieces, in: body)
      })
  }

  static func resources(udid: String) -> URL? {
    guard let device = CoreSimulator.device(udid: udid),
      let type = property("deviceType", on: device) as? NSObject,
      let identifier = property("identifier", on: type) as? String
    else { return nil }
    let root = URL(fileURLWithPath: "/Library/Developer/CoreSimulator/Profiles/DeviceTypes")
    guard let types = try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil),
      let bundle = types.first(where: { Bundle(url: $0)?.bundleIdentifier == identifier })
    else { return nil }
    return bundle.appendingPathComponent("Contents/Resources")
  }

  private static func property(_ name: String, on object: NSObject) -> Any? {
    let selector = NSSelectorFromString(name)
    return object.responds(to: selector) ? object.perform(selector)?.takeUnretainedValue() : nil
  }

  private static func plist(_ url: URL) -> [String: Any] {
    guard let data = try? Data(contentsOf: url) else { return [:] }
    return (try? PropertyListSerialization.propertyList(from: data, format: nil)) as? [String: Any] ?? [:]
  }

  private static func number(_ object: [String: Any], _ key: String) -> CGFloat? {
    (object[key] as? NSNumber).map { CGFloat(truncating: $0) }
  }

  private static func draw(_ image: NSImage, in rect: CGRect) {
    image.draw(in: rect, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
  }

  private static func drawEdges(_ pieces: [NSImage], in body: CGRect) {
    let left = pieces[0].size.width
    let right = pieces[2].size.width
    let top = pieces[0].size.height
    let bottom = pieces[5].size.height
    let width = max(0, body.width - left - right)
    let height = max(0, body.height - top - bottom)
    let rects = [
      CGRect(x: body.minX, y: body.minY, width: left, height: top),
      CGRect(x: body.minX + left, y: body.minY, width: width, height: top),
      CGRect(x: body.maxX - right, y: body.minY, width: right, height: top),
      CGRect(x: body.minX, y: body.minY + top, width: left, height: height),
      CGRect(x: body.maxX - right, y: body.minY + top, width: right, height: height),
      CGRect(x: body.minX, y: body.maxY - bottom, width: left, height: bottom),
      CGRect(x: body.minX + left, y: body.maxY - bottom, width: width, height: bottom),
      CGRect(x: body.maxX - right, y: body.maxY - bottom, width: right, height: bottom),
    ]
    for (image, rect) in zip(pieces, rects) { draw(image, in: rect) }
  }
}
