import CoreGraphics
import Foundation

/// Still frames for hovering a replay track. stim-server's `replay.keyframe` answers with the keyframe that starts
/// the recorded segment of about 5 seconds `frames.seek` would show a time from, so a preview is at segment
/// granularity. `decode` turns each keyframe into an image, kept for the `capacity` segments used last.
///
/// One request is out at a time. `want` replaces the times waiting with the hovered one and its neighbours, so a
/// pointer that moves on drops them; the answer to the one out is kept. A server without `replay.keyframe` gets no
/// more requests.
@MainActor public final class ReplayPreviews {
  public static let capacity = 200
  /// Where the neighbours of a hovered time are, in milliseconds: about the two segments on each side.
  public static let neighbours: [Double] = [5000, -5000, 10_000, -10_000]

  /// Turns a keyframe into an image and calls back on the main actor, with nil when it cannot.
  public var decode: (ReplayKeyframe, @escaping @MainActor (CGImage?) -> Void) -> Void = { $1(nil) }
  /// Runs when an image arrives.
  public var onImage: () -> Void = {}
  /// The width over the height of the newest keyframe, nil before the first one.
  public private(set) var aspect: Double?

  /// `from` and `to` are the times known to show this segment's keyframe: the segment's own, and the requested times
  /// the server answered with it, such as one in a short gap before it.
  private struct Entry {
    var start: Double
    var from: Double
    var to: Double
    var image: CGImage?
    var used: Int
  }

  private let target: ReplayTarget
  private weak var server: ReplayServer?
  private var entries: [Entry] = []
  private var waiting: [Double] = []
  private var busy = false
  private var generation = 0
  private var supported = true
  private var uses = 0

  public init(target: ReplayTarget) {
    self.target = target
  }

  /// Whether a preview can show: connected to a server that serves `replay.keyframe`, as far as is known.
  public var isAvailable: Bool { server != nil && supported }

  func connect(_ server: ReplayServer?) {
    guard server !== self.server else { return }
    self.server = server
    generation += 1
    busy = false
    supported = true
    pump()
  }

  /// The image of the segment that shows `at`, once it is decoded.
  public func image(at: Double) -> CGImage? {
    guard let index = entries.firstIndex(where: { $0.from <= at && at <= $0.to }) else { return nil }
    uses += 1
    entries[index].used = uses
    return entries[index].image
  }

  /// Asks for the segment showing `at`, then its neighbours inside `bounds`; nil stops asking.
  public func want(_ at: Double?, within bounds: ClosedRange<Double>) {
    guard let at, isAvailable else {
      waiting = []
      return
    }
    waiting = ([at] + Self.neighbours.map { at + $0 }.filter(bounds.contains)).filter { !covered($0) }
    pump()
  }

  private func covered(_ at: Double) -> Bool {
    entries.contains { $0.from <= at && at <= $0.to }
  }

  private func pump() {
    guard !busy, let server, supported else { return }
    waiting.removeAll(where: covered)
    guard !waiting.isEmpty else { return }
    let at = waiting.removeFirst()
    busy = true
    let generation = generation
    var params = target.params
    params["at"] = .number(at)
    Task {
      let result: Result<JSONValue, Error>
      do {
        result = .success(try await server.request("replay.keyframe", params))
      } catch {
        result = .failure(error)
      }
      guard generation == self.generation else { return }
      busy = false
      switch result {
      case .success(let value):
        if let keyframe = ReplayKeyframe(value) { store(keyframe, for: at) }
      case .failure(let failure as ServerError) where ["unknown-method", "bad-request"].contains(failure.code):
        supported = false
        waiting = []
      case .failure:
        break
      }
      pump()
    }
  }

  private func store(_ keyframe: ReplayKeyframe, for at: Double) {
    if keyframe.height > 0 { aspect = Double(keyframe.width) / Double(keyframe.height) }
    uses += 1
    if let index = entries.firstIndex(where: { $0.start == keyframe.start }) {
      entries[index].from = min(entries[index].from, keyframe.start, at)
      entries[index].to = max(entries[index].to, keyframe.end, at)
      entries[index].used = uses
      return
    }
    entries.append(
      Entry(
        start: keyframe.start, from: min(keyframe.start, at), to: max(keyframe.end, at), image: nil, used: uses))
    if entries.count > Self.capacity, let oldest = entries.indices.min(by: { entries[$0].used < entries[$1].used }) {
      entries.remove(at: oldest)
    }
    decode(keyframe) { [weak self] image in
      guard let self, let index = self.entries.firstIndex(where: { $0.start == keyframe.start }) else { return }
      guard let image else {
        self.entries.remove(at: index)
        return
      }
      self.entries[index].image = image
      self.onImage()
    }
  }
}
