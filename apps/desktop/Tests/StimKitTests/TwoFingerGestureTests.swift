import AppKit
import Testing

@testable import StimKit

@Suite struct TwoFingerPositionsTests {
  @Test func shiftingThePanAnchorDoesNotJumpOrChangeFingerSeparation() {
    var positions = TwoFingerPositions()
    positions.update(pointer: CGPoint(x: 0.2, y: 0.4), translating: false)
    positions.update(pointer: CGPoint(x: 0.3, y: 0.5), translating: true)
    #expect(positions.first == CGPoint(x: 0.2, y: 0.4))
    #expect(positions.second == CGPoint(x: 0.8, y: 0.6))
    positions.update(pointer: CGPoint(x: 0.4, y: 0.6), translating: true)
    #expect(abs(positions.first.x - 0.3) < 0.000001)
    #expect(abs(positions.second.x - 0.9) < 0.000001)
    positions.update(pointer: CGPoint(x: 2, y: 2), translating: true)
    #expect(positions.second == CGPoint(x: 1, y: 1))
    #expect(abs(positions.second.x - positions.first.x - 0.6) < 0.000001)
    #expect(abs(positions.second.y - positions.first.y - 0.2) < 0.000001)
    let first = positions.first
    positions.update(pointer: CGPoint(x: 2, y: 2), translating: false)
    #expect(positions.first == first)
  }
}

@MainActor
@Suite struct TwoFingerGestureTests {
  private func event(_ type: NSEvent.EventType, _ point: CGPoint, flags: NSEvent.ModifierFlags = .option) -> NSEvent {
    NSEvent.mouseEvent(
      with: type, location: point, modifierFlags: flags, timestamp: 0, windowNumber: 0,
      context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
  }

  @Test func controlLossReleasesBothLastContactsAndCannotStartAnotherGesture() {
    let view = NSView(frame: CGRect(x: 0, y: 0, width: 100, height: 100))
    view.wantsLayer = true
    var enabled = true
    var trace: [(TwoFingerPhase, CGPoint, CGPoint)] = []
    let gesture = TwoFingerGesture(
      view: view, enabled: { enabled },
      map: { point, clamped in
        if !clamped, !view.bounds.contains(point) { return nil }
        return CGPoint(x: min(1, max(0, point.x / 100)), y: min(1, max(0, point.y / 100)))
      }, project: { $0 },
      send: { phase, first, second in
        trace.append((phase, first, second))
        return true
      })
    #expect(!gesture.mouseDown(event(.leftMouseDown, CGPoint(x: -1, y: 50))))
    #expect(trace.isEmpty)
    #expect(gesture.mouseDown(event(.leftMouseDown, CGPoint(x: 20, y: 40))))
    #expect(gesture.mouseDragged(event(.leftMouseDragged, CGPoint(x: 30, y: 45))))
    enabled = false
    gesture.cancel()
    #expect(trace.map { $0.0 } == [.down, .move, .up])
    #expect(trace[2].1 == trace[1].1)
    #expect(trace[2].2 == trace[1].2)
    #expect(!gesture.isActive)
    #expect(!gesture.mouseDown(event(.leftMouseDown, CGPoint(x: 20, y: 40))))
    gesture.cancel()
    #expect(trace.count == 3)
  }

  @Test func shiftUsesTheCursorAnchorInsteadOfTheKeyboardEventsLocation() {
    final class CursorWindow: NSWindow {
      override var mouseLocationOutsideOfEventStream: NSPoint { CGPoint(x: 30, y: 45) }
    }
    let window = CursorWindow(
      contentRect: CGRect(x: 0, y: 0, width: 100, height: 100), styleMask: .borderless, backing: .buffered, defer: false)
    let view = NSView(frame: CGRect(x: 0, y: 0, width: 100, height: 100))
    view.wantsLayer = true
    window.contentView = view
    var contacts: [(CGPoint, CGPoint)] = []
    let gesture = TwoFingerGesture(
      view: view, enabled: { true }, map: { point, _ in CGPoint(x: point.x / 100, y: point.y / 100) },
      project: { $0 },
      send: { _, first, second in
        contacts.append((first, second))
        return true
      })
    #expect(gesture.mouseDown(event(.leftMouseDown, CGPoint(x: 30, y: 45))))
    gesture.flagsChanged(
      NSEvent.keyEvent(
        with: .flagsChanged, location: .zero, modifierFlags: [.option, .shift], timestamp: 0,
        windowNumber: window.windowNumber, context: nil, characters: "", charactersIgnoringModifiers: "",
        isARepeat: false, keyCode: 56)!)
    #expect(gesture.mouseDragged(event(.leftMouseDragged, CGPoint(x: 40, y: 55), flags: [.option, .shift])))
    #expect(abs(contacts.last!.0.x - 0.4) < 0.000001)
    #expect(abs(contacts.last!.0.y - 0.55) < 0.000001)
    #expect(abs(contacts.last!.1.x - 0.8) < 0.000001)
    #expect(abs(contacts.last!.1.y - 0.65) < 0.000001)
    gesture.cancel()
  }

  @Test func releasingOptionEndsThePairBeforeMouseUp() {
    let view = NSView(frame: CGRect(x: 0, y: 0, width: 100, height: 100))
    view.wantsLayer = true
    var phases: [TwoFingerPhase] = []
    let gesture = TwoFingerGesture(
      view: view, enabled: { true }, map: { point, _ in CGPoint(x: point.x / 100, y: point.y / 100) },
      project: { $0 },
      send: { phase, _, _ in
        phases.append(phase)
        return true
      })
    #expect(gesture.mouseDown(event(.leftMouseDown, CGPoint(x: 20, y: 40))))
    gesture.flagsChanged(event(.leftMouseUp, CGPoint(x: 20, y: 40), flags: []))
    #expect(!gesture.mouseUp(event(.leftMouseUp, CGPoint(x: 20, y: 40), flags: [])))
    #expect(phases == [.down, .up])
  }
}
