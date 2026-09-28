import Foundation

/// The `frames.seek` requests of one replay: at most one is out at a time, at most one waits, and a newer seek
/// replaces the one waiting. Each seek makes stim-server resend the frames from the keyframe before it, so a drag
/// sends the pointer's latest time at most every `minimumInterval` instead of one seek per pointer event.
struct ReplaySeekQueue: Sendable {
  struct Seek: Equatable, Sendable {
    var at: Double
    var rate: Int
  }

  static let minimumInterval: TimeInterval = 0.05

  private(set) var sending: Seek?
  private(set) var waiting: Seek?
  private var sentAt = -Double.infinity

  /// Nothing is out or waiting, so the frames that arrive belong to the position shown.
  var isSettled: Bool { sending == nil && waiting == nil }

  /// Makes `seek` the one waiting, in place of any older one; `next` sends it.
  mutating func ask(_ seek: Seek) {
    waiting = seek
  }

  /// Returns the waiting seek when it can go out now: the subscription is open, nothing is out, and the last seek
  /// went out at least `minimumInterval` ago.
  mutating func next(now: TimeInterval, open: Bool) -> Seek? {
    guard open, sending == nil, let seek = waiting, now - sentAt >= Self.minimumInterval else { return nil }
    sending = seek
    waiting = nil
    sentAt = now
    return seek
  }

  /// How long until the waiting seek may go out, when only `minimumInterval` holds it back.
  func delay(now: TimeInterval, open: Bool) -> TimeInterval? {
    guard open, sending == nil, waiting != nil else { return nil }
    let delay = sentAt + Self.minimumInterval - now
    return delay > 0 ? delay : nil
  }

  /// The seek out was answered or refused. Returns whether it was the latest one asked for, so its answer is shown.
  mutating func finish() -> Bool {
    sending = nil
    return waiting == nil
  }

  /// The subscription went away with a seek out: it waits for the next subscription unless a newer one waits.
  mutating func interrupt() {
    if waiting == nil { waiting = sending }
    sending = nil
    sentAt = -.infinity
  }

  mutating func clear() {
    self = ReplaySeekQueue()
  }
}
