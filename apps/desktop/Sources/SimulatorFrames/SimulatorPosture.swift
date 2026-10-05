// The hinge path, spring and vendor reports below are adapted from Siniulator
// (github.com/kmagiera/Siniulator, Sources/Siniulator/DuoMotion.swift and
// Sources/Siniulator/Input.swift), under this licence:
//
// MIT License
//
// Copyright (c) 2026 Siniulator contributors
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

import Foundation
import IOKit

/// The iPhone Duo postures Xcode's Device Hub offers, as hinge angles in degrees.
public enum DuoPosture: CaseIterable, Sendable {
  case closed, halfOpen, open

  public var hingeAngle: Double {
    switch self {
    case .closed: return 0
    case .halfOpen: return 120
    case .open: return 180
    }
  }

  public var label: String {
    switch self {
    case .closed: return "Folded"
    case .halfOpen: return "Half open"
    case .open: return "Unfolded"
    }
  }

  public var systemImage: String {
    switch self {
    case .closed: return "rectangle.portrait"
    case .halfOpen: return "book"
    case .open: return "rectangle"
    }
  }

  /// Whether the posture lights the cover panel rather than the inner one.
  public var isFolded: Bool { self == .closed }
}

/// The path the hinge takes between two angles. iOS 27.1 swaps panels only
/// while the angle moves continuously through the turn between the cover and
/// inner rest angles; a jump across it can leave both panels black.
enum DuoHinge {
  static let coverEnd = 0.20
  static let innerStart = 0.50
  static let coverRestAngle = 40.0
  static let innerRestAngle = 110.0

  static func estimatedAngle(remembered: Double?, folded: Bool?) -> Double {
    if folded == true {
      let openPreset = DuoPosture.allCases.contains { !$0.isFolded && $0.hingeAngle == remembered }
      return openPreset ? 0 : remembered ?? 0
    }
    if folded == false, remembered == 0 { return 180 }
    return remembered ?? 180
  }

  static func sweep(from: Double, to: Double, interval: Double = 1.0 / 60) -> [Double] {
    var spring = Spring(phase(for: from), maximumSpeed: 1)
    spring.target = phase(for: to)
    var angles: [Double] = []
    while !spring.isSettled {
      spring.advance(seconds: interval)
      angles.append(angle(at: spring.value))
    }
    return angles
  }

  static func phase(for angle: Double) -> Double {
    let angle = min(180, max(0, angle))
    if angle == 0 { return 0 }
    if angle == 180 { return 1 }
    var low = 0.0
    var high = 1.0
    for _ in 0..<40 {
      let middle = (low + high) / 2
      if Self.angle(at: middle) < angle { low = middle } else { high = middle }
    }
    return (low + high) / 2
  }

  static func angle(at phase: Double) -> Double {
    let phase = min(1, max(0, phase))
    let firstSlope = coverRestAngle / coverEnd
    let turnSlope = (innerRestAngle - coverRestAngle) / (innerStart - coverEnd)
    let lastSlope = (180 - innerRestAngle) / (1 - innerStart)
    let firstTangent = 1.5 / (0.8 / firstSlope + 0.7 / turnSlope)
    let secondTangent = 2.4 / (1.3 / turnSlope + 1.1 / lastSlope)
    if phase <= coverEnd {
      return segment(
        phase / coverEnd, start: 0, end: coverRestAngle, slope0: firstSlope * coverEnd,
        slope1: firstTangent * coverEnd)
    }
    if phase < innerStart {
      let span = innerStart - coverEnd
      return segment(
        (phase - coverEnd) / span, start: coverRestAngle, end: innerRestAngle, slope0: firstTangent * span,
        slope1: secondTangent * span)
    }
    let span = 1 - innerStart
    return segment(
      (phase - innerStart) / span, start: innerRestAngle, end: 180, slope0: secondTangent * span,
      slope1: lastSlope * span)
  }

  private static func segment(_ t: Double, start: Double, end: Double, slope0: Double, slope1: Double) -> Double {
    let t2 = t * t
    let t3 = t2 * t
    return (2 * t3 - 3 * t2 + 1) * start + (t3 - 2 * t2 + t) * slope0 + (-2 * t3 + 3 * t2) * end + (t3 - t2) * slope1
  }

  struct Spring {
    var value: Double
    var target: Double
    private(set) var velocity = 0.0
    let maximumSpeed: Double

    init(_ value: Double, maximumSpeed: Double) {
      self.value = value
      target = value
      self.maximumSpeed = maximumSpeed
    }

    var isSettled: Bool { abs(target - value) < 0.00001 && abs(velocity) < 0.0001 }

    mutating func advance(seconds: Double) {
      let dt = min(1.0 / 30, max(0, seconds))
      guard dt > 0 else { return }
      let frequency = 12.0
      let error = value - target
      let tangent = velocity + frequency * error
      let decay = exp(-frequency * dt)
      let proposed = target + (error + tangent * dt) * decay
      let step = proposed - value
      if abs(step) > maximumSpeed * dt {
        velocity = step.sign == .minus ? -maximumSpeed : maximumSpeed
        value += velocity * dt
      } else {
        value = proposed
        velocity = (velocity - frequency * tangent * dt) * decay
      }
      if isSettled {
        value = target
        velocity = 0
      }
    }
  }

  /// The vendor-defined HID report that sets the hinge angle through the
  /// simulator's Virtualization provider, in IOKit's binary serialization.
  static func report(angle: Double) -> Data? {
    let event: NSDictionary = [
      "provider": "com.apple.Virtualization.VirtualMachines", "source": "hinge-slider-control", "type": "range",
      "value": angle,
    ]
    return IOCFSerialize(event, CFOptionFlags(kIOCFSerializeToBinary)) as Data?
  }
}

/// Moves a booted iPhone Duo simulator's hinge through dtuhidd's vendor-defined
/// HID service, which CoreSimulator 1174 and later run in the simulator.
public enum SimulatorPosture {
  private static let lock = NSLock()
  private static var connections: [String: CoreDeviceHID] = [:]
  private static var angles: [String: Double] = [:]

  /// Whether the simulator takes hinge input, with a bounded background lookup.
  public static func isAvailable(udid: String) async -> Bool {
    (try? await SimulatorLookup.run(udid: udid) { connection(udid: udid) != nil }) ?? false
  }

  /// The posture Stim Desktop last moved this simulator to, if any.
  public static func lastPosture(udid: String) -> DuoPosture? {
    guard let angle = lastAngle(udid: udid) else { return nil }
    return DuoPosture.allCases.first { $0.hingeAngle == angle }
  }

  /// The hinge angle Stim Desktop last moved this simulator to, in degrees.
  public static func lastAngle(udid: String) -> Double? {
    lock.lock()
    defer { lock.unlock() }
    return angles[udid]
  }

  /// Estimates the hinge angle from the observed active panel and the last
  /// requested angle. An observed panel change overrides a conflicting cache.
  public static func estimatedAngle(udid: String, folded: Bool?) -> Double {
    DuoHinge.estimatedAngle(remembered: lastAngle(udid: udid), folded: folded)
  }

  /// Sweeps the hinge from `angle`, where it is now, to `posture`, about one
  /// second for a full fold. Returns an error message when the input service
  /// is missing or closes.
  public static func move(udid: String, from angle: Double, to posture: DuoPosture) async -> String? {
    await move(udid: udid, from: angle, to: posture.hingeAngle)
  }

  /// Sweeps the simulated hinge to an angle in 0...180 degrees. Returns an
  /// error message when the input service is missing or closes.
  public static func move(udid: String, from angle: Double, to target: Double) async -> String? {
    let hid: CoreDeviceHID
    do {
      hid = try await SimulatorLookup.run(udid: udid) {
        guard let hid = connection(udid: udid) else { throw SimulatorLookup.Failure.unavailable }
        return hid
      }
    } catch {
      return error.localizedDescription
    }
    while !hid.isReady, hid.isConnected { try? await Task.sleep(for: .milliseconds(50)) }
    guard hid.isConnected else { return "The simulator's input connection closed. Try again." }
    for angle in DuoHinge.sweep(from: angle, to: target) {
      guard let report = DuoHinge.report(angle: angle) else { return "IOKit could not serialize the hinge report." }
      hid.vendorDefined(report)
      try? await Task.sleep(for: .milliseconds(16))
    }
    guard hid.isConnected else { return "The simulator's input connection closed. Try again." }
    remember(target, udid: udid)
    return nil
  }

  // The Virtualization provider overwrites ordinary Duo rotation events; its enum follows
  // https://github.com/kmagiera/Siniulator/blob/e181521a32595c2e537e1ee6c359aae254dbfed3/Sources/Siniulator/Input.swift#L115-L146
  static func orient(udid: String, orientation: UInt32) -> Bool {
    guard let hid = connection(udid: udid) else { return false }
    while !hid.isReady, hid.isConnected { Thread.sleep(forTimeInterval: 0.05) }
    guard hid.isConnected else { return false }
    let values = ["portrait", "pud", "landscape-left", "landscape-right"]
    let event: NSDictionary = [
      "provider": "com.apple.Virtualization.VirtualMachines", "source": "orientation-picker-control", "type": "enum",
      "value": values[Int(orientation) - 1],
    ]
    guard let report = IOCFSerialize(event, CFOptionFlags(kIOCFSerializeToBinary)) as Data? else { return false }
    hid.vendorDefined(report)
    return hid.isConnected
  }

  private static func remember(_ angle: Double, udid: String) {
    lock.lock()
    angles[udid] = angle
    lock.unlock()
  }

  private static func connection(udid: String) -> CoreDeviceHID? {
    lock.lock()
    if let hid = connections[udid] {
      if hid.isConnected {
        lock.unlock()
        return hid
      }
      angles[udid] = nil
    }
    lock.unlock()
    guard let device = CoreSimulator.device(udid: udid),
      let hid = CoreDeviceHID(device: device, feature: CoreDeviceHID.vendorDefined)
    else { return nil }
    lock.lock()
    connections[udid] = hid
    lock.unlock()
    return hid
  }
}
