import Foundation
import NitroModules

protocol VideoConsumer: AnyObject {
  /// One Annex-B access unit. `generation` is the orientation generation it belongs to; `received` is when the
  /// stream got it, in `DispatchTime.now().uptimeNanoseconds`.
  func decode(_ accessUnit: Data, generation: Int, received: UInt64)
}

/// The video of one subscription. The session pushes stim-server video messages on its socket thread; the attached
/// `HybridStimVideoView` decodes them. While no view is attached, the stream keeps the messages since the last
/// keyframe, so a view that attaches late starts without waiting for one.
final class HybridVideoStream: HybridVideoStreamSpec {
  var onFormat: ((VideoFormat) -> Void)?
  var onProgress: ((VideoProgress) -> Void)?

  private static let fixedHeaderBytes = 21
  private static let maxBacklogBytes = 4 * 1024 * 1024
  private static let progressInterval: TimeInterval = 0.2

  private let lock = NSLock()
  private weak var consumer: VideoConsumer?
  private var backlog: [(Data, Int, UInt64)] = []
  private var backlogBytes = 0
  private var formatKey: String?
  private var generation = 0
  private var disposed = false
  private var frames = 0
  private var bytes = 0
  private var capturedAt = 0.0
  private var latencyMs = 0.0
  private var lastProgress = Date.distantPast
  private var progressScheduled = false
  #if DEBUG
    private var timings = (
      received: 0.0, decoded: 0.0, presented: 0.0, dropped: 0.0, queueSum: 0.0, queueMax: 0.0, presentSum: 0.0,
      presentMax: 0.0
    )
  #endif

  override init() {
    super.init()
  }

  func push(packet: ArrayBuffer) throws {
    let data = packet.toData(copyIfNeeded: true)
    let fixed = HybridVideoStream.fixedHeaderBytes
    guard data.count >= fixed, data[data.startIndex] == 1 else { return }
    let base = data.startIndex
    let headerLength = Int(data[base + 2]) << 8 | Int(data[base + 3])
    let idLength = Int(data[base + 20])
    guard headerLength >= fixed + idLength, headerLength <= data.count else { return }
    let flags = data[base + 1]
    let keyframe = flags & 1 != 0
    let posture: VideoPosture? = flags & 2 != 0 ? .folded : flags & 4 != 0 ? .unfolded : nil
    let artworkTurns: Double? = flags & 32 != 0 ? Double((flags >> 3) & 3) : nil
    var capturedBits: UInt64 = 0
    for i in 0..<8 { capturedBits = capturedBits << 8 | UInt64(data[base + 8 + i]) }
    let captured = Double(bitPattern: capturedBits)
    let width = Int(data[base + 16]) << 8 | Int(data[base + 17])
    let height = Int(data[base + 18]) << 8 | Int(data[base + 19])
    let accessUnit = data[(base + headerLength)...]
    let received = DispatchTime.now().uptimeNanoseconds

    lock.lock()
    #if DEBUG
      timings.received += 1
    #endif
    if disposed {
      #if DEBUG
        timings.dropped += 1
      #endif
      lock.unlock()
      return
    }
    var changed: VideoFormat?
    if formatKey != nil || keyframe {
      let key = "\(width)x\(height) \(posture.map { $0.stringValue } ?? "") \(artworkTurns.map { "\($0)" } ?? "")"
      if key != formatKey {
        formatKey = key
        if artworkTurns != nil { generation += 1 }
        changed = VideoFormat(
          width: Double(width), height: Double(height), posture: posture, artworkTurns: artworkTurns,
          generation: Double(generation))
      }
    }
    let unitGeneration = generation
    frames += 1
    bytes += accessUnit.count
    capturedAt = captured
    latencyMs = Date().timeIntervalSince1970 * 1000 - captured
    let target = consumer
    if target == nil {
      if keyframe {
        backlog.removeAll()
        backlogBytes = 0
      }
      if !backlog.isEmpty || keyframe, backlogBytes + accessUnit.count <= HybridVideoStream.maxBacklogBytes {
        backlog.append((Data(accessUnit), unitGeneration, received))
        backlogBytes += accessUnit.count
      } else {
        recordDropped(holdingLock: true)
      }
    }
    let progress = takeProgress()
    let formatCallback = onFormat
    lock.unlock()

    if let changed { formatCallback?(changed) }
    target?.decode(Data(accessUnit), generation: unitGeneration, received: received)
    if let progress { onProgress?(progress) }
  }

  func attach(_ next: VideoConsumer) {
    lock.lock()
    if disposed {
      lock.unlock()
      return
    }
    consumer = next
    let replay = backlog
    backlog.removeAll()
    backlogBytes = 0
    lock.unlock()
    for (accessUnit, generation, received) in replay {
      next.decode(accessUnit, generation: generation, received: received)
    }
  }

  func detach(_ previous: VideoConsumer) {
    lock.lock()
    if consumer === previous { consumer = nil }
    lock.unlock()
  }

  func timing() throws -> VideoTiming {
    #if DEBUG
      lock.lock()
      defer { lock.unlock() }
      let t = timings
      return VideoTiming(
        enabled: true, received: t.received, decoded: t.decoded, presented: t.presented, dropped: t.dropped,
        meanDecodeQueueMs: t.decoded > 0 ? t.queueSum / t.decoded : 0, maxDecodeQueueMs: t.queueMax,
        meanPresentMs: t.presented > 0 ? t.presentSum / t.presented : 0, maxPresentMs: t.presentMax)
    #else
      return VideoTiming(
        enabled: false, received: 0, decoded: 0, presented: 0, dropped: 0, meanDecodeQueueMs: 0, maxDecodeQueueMs: 0,
        meanPresentMs: 0, maxPresentMs: 0)
    #endif
  }

  /// The view submitted a frame the stream received at `received` to its decoder.
  func recordDecoded(received: UInt64) {
    #if DEBUG
      let ms = Double(DispatchTime.now().uptimeNanoseconds &- received) / 1e6
      lock.lock()
      timings.decoded += 1
      timings.queueSum += ms
      timings.queueMax = max(timings.queueMax, ms)
      lock.unlock()
    #endif
  }

  /// The view showed a frame the stream received at `received`.
  func recordPresented(received: UInt64) {
    #if DEBUG
      let ms = Double(DispatchTime.now().uptimeNanoseconds &- received) / 1e6
      lock.lock()
      timings.presented += 1
      timings.presentSum += ms
      timings.presentMax = max(timings.presentMax, ms)
      lock.unlock()
    #endif
  }

  /// A frame was dropped. `holdingLock` is for `push`, which holds `lock`.
  func recordDropped(holdingLock: Bool = false) {
    #if DEBUG
      if !holdingLock { lock.lock() }
      timings.dropped += 1
      if !holdingLock { lock.unlock() }
    #endif
  }

  func dispose() {
    lock.lock()
    disposed = true
    consumer = nil
    backlog.removeAll()
    backlogBytes = 0
    lock.unlock()
  }

  /// The progress to report now, or nil; schedules a report for frames that arrive inside the interval. Holds `lock`.
  private func takeProgress() -> VideoProgress? {
    let now = Date()
    let elapsed = now.timeIntervalSince(lastProgress)
    guard elapsed >= HybridVideoStream.progressInterval else {
      if !progressScheduled {
        progressScheduled = true
        DispatchQueue.global().asyncAfter(deadline: .now() + HybridVideoStream.progressInterval - elapsed) {
          [weak self] in
          guard let self else { return }
          self.lock.lock()
          self.progressScheduled = false
          let progress = self.disposed ? nil : self.takeProgress()
          self.lock.unlock()
          if let progress { self.onProgress?(progress) }
        }
      }
      return nil
    }
    guard frames > 0 else { return nil }
    lastProgress = now
    let progress = VideoProgress(
      capturedAt: capturedAt, frames: Double(frames), bytes: Double(bytes), latencyMs: latencyMs)
    frames = 0
    bytes = 0
    return progress
  }
}
