import AVFoundation
import ExpoModulesCore

final class DisplayLayerView: UIView {
  override class var layerClass: AnyClass { AVSampleBufferDisplayLayer.self }
  var displayLayer: AVSampleBufferDisplayLayer { layer as! AVSampleBufferDisplayLayer }
}

class StimVideoView: ExpoView {
  private let display = DisplayLayerView()
  private let queue = DispatchQueue(label: "stim.video.decode")
  private var format: CMVideoFormatDescription?
  private var sps = Data()
  private var pps = Data()
  private var waitingForKeyframe = true

  let onKeyframeNeeded = EventDispatcher()

  var streamId: String? {
    didSet {
      if let oldValue { StimVideoRegistry.remove(oldValue, self) }
      if let streamId { StimVideoRegistry.add(streamId, self) }
    }
  }

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    backgroundColor = .black
    display.displayLayer.videoGravity = .resizeAspect
    display.displayLayer.backgroundColor = UIColor.black.cgColor
    addSubview(display)
  }

  deinit {
    if let streamId { StimVideoRegistry.remove(streamId, self) }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    display.frame = bounds
  }

  /// Called on the JS thread with bytes it owns; decoding runs on `queue`.
  func push(_ accessUnit: Data) {
    queue.async { self.decode(accessUnit) }
  }

  private func decode(_ accessUnit: Data) {
    let layer = display.displayLayer
    if layer.status == .failed {
      layer.flush()
      waitingForKeyframe = true
      requestKeyframe()
    }
    var slices: [Data] = []
    var keyframe = false
    var parametersChanged = false
    accessUnit.withUnsafeBytes { bytes in
      for unit in AnnexB.units(bytes) {
        let type = unit[0] & 0x1f
        switch type {
        case NalType.sps:
          let value = Data(unit)
          if value != sps { sps = value; parametersChanged = true }
        case NalType.pps:
          let value = Data(unit)
          if value != pps { pps = value; parametersChanged = true }
        default:
          if type == NalType.idr { keyframe = true }
          if type >= 1 && type <= 5 { slices.append(Data(unit)) }
        }
      }
    }
    if parametersChanged || format == nil { makeFormat() }
    guard let format, !slices.isEmpty else { return }
    if !layer.isReadyForMoreMediaData {
      waitingForKeyframe = true
      requestKeyframe()
      return
    }
    if waitingForKeyframe {
      guard keyframe else { return }
      waitingForKeyframe = false
    }
    guard let sample = sampleBuffer(slices, format: format) else { return }
    layer.enqueue(sample)
  }

  private func makeFormat() {
    guard !sps.isEmpty, !pps.isEmpty else { return }
    var created: CMVideoFormatDescription?
    let status = sps.withUnsafeBytes { spsBytes in
      pps.withUnsafeBytes { ppsBytes in
        let pointers = [
          spsBytes.bindMemory(to: UInt8.self).baseAddress!,
          ppsBytes.bindMemory(to: UInt8.self).baseAddress!,
        ]
        let sizes = [sps.count, pps.count]
        return CMVideoFormatDescriptionCreateFromH264ParameterSets(
          allocator: kCFAllocatorDefault, parameterSetCount: 2, parameterSetPointers: pointers,
          parameterSetSizes: sizes, nalUnitHeaderLength: 4, formatDescriptionOut: &created)
      }
    }
    guard status == noErr, let created else { return }
    if let format, !CMFormatDescriptionEqual(format, otherFormatDescription: created) {
      display.displayLayer.flush()
    }
    format = created
  }

  private func sampleBuffer(_ slices: [Data], format: CMVideoFormatDescription) -> CMSampleBuffer? {
    var avcc = Data(capacity: slices.reduce(0) { $0 + $1.count + 4 })
    for slice in slices {
      var length = UInt32(slice.count).bigEndian
      withUnsafeBytes(of: &length) { avcc.append(contentsOf: $0) }
      avcc.append(slice)
    }
    var block: CMBlockBuffer?
    guard
      CMBlockBufferCreateWithMemoryBlock(
        allocator: kCFAllocatorDefault, memoryBlock: nil, blockLength: avcc.count, blockAllocator: kCFAllocatorDefault,
        customBlockSource: nil, offsetToData: 0, dataLength: avcc.count, flags: 0, blockBufferOut: &block) == noErr,
      let block
    else { return nil }
    let copied = avcc.withUnsafeBytes {
      CMBlockBufferReplaceDataBytes(
        with: $0.baseAddress!, blockBuffer: block, offsetIntoDestination: 0, dataLength: avcc.count)
    }
    guard copied == noErr else { return nil }
    var sample: CMSampleBuffer?
    var sampleSize = avcc.count
    guard
      CMSampleBufferCreateReady(
        allocator: kCFAllocatorDefault, dataBuffer: block, formatDescription: format, sampleCount: 1,
        sampleTimingEntryCount: 0, sampleTimingArray: nil, sampleSizeEntryCount: 1, sampleSizeArray: &sampleSize,
        sampleBufferOut: &sample) == noErr,
      let sample
    else { return nil }
    if let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: true),
      CFArrayGetCount(attachments) > 0
    {
      let dictionary = unsafeBitCast(CFArrayGetValueAtIndex(attachments, 0), to: CFMutableDictionary.self)
      CFDictionarySetValue(
        dictionary, Unmanaged.passUnretained(kCMSampleAttachmentKey_DisplayImmediately).toOpaque(),
        Unmanaged.passUnretained(kCFBooleanTrue).toOpaque())
    }
    return sample
  }

  private var lastKeyframeRequest = Date.distantPast

  private func requestKeyframe() {
    let now = Date()
    guard now.timeIntervalSince(lastKeyframeRequest) >= 0.5 else { return }
    lastKeyframeRequest = now
    DispatchQueue.main.async { self.onKeyframeNeeded([:]) }
  }
}

enum StimVideoRegistry {
  private final class Weak {
    weak var view: StimVideoView?
    init(_ view: StimVideoView) { self.view = view }
  }

  private static let lock = NSLock()
  private static var views: [String: Weak] = [:]

  static func add(_ id: String, _ view: StimVideoView) {
    lock.lock()
    defer { lock.unlock() }
    views[id] = Weak(view)
  }

  static func remove(_ id: String, _ view: StimVideoView) {
    lock.lock()
    defer { lock.unlock() }
    if views[id]?.view === view { views[id] = nil }
  }

  static func view(_ id: String) -> StimVideoView? {
    lock.lock()
    defer { lock.unlock() }
    return views[id]?.view
  }
}
