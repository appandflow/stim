import AVFoundation
import NitroModules
import UIKit

final class DisplayLayerView: UIView {
  override class var layerClass: AnyClass { AVSampleBufferDisplayLayer.self }
  var displayLayer: AVSampleBufferDisplayLayer { layer as! AVSampleBufferDisplayLayer }
}

/// Decodes the H.264 of the `VideoStream` it is given with VideoToolbox, through `AVSampleBufferDisplayLayer`. It stays
/// black until a keyframe carrying its SPS and PPS arrives, and fills its bounds.
final class HybridStimVideoView: HybridStimVideoViewSpec, VideoConsumer, RecyclableView {
  let view: UIView = {
    let display = DisplayLayerView()
    display.clipsToBounds = true
    display.backgroundColor = .black
    display.displayLayer.videoGravity = .resizeAspect
    display.displayLayer.backgroundColor = UIColor.black.cgColor
    return display
  }()

  var onKeyframeNeeded: (() -> Void)?
  var onOrientationCleared: ((Double) -> Void)?

  var stream: (any HybridVideoStreamSpec)? {
    didSet { attach(stream as? HybridVideoStream) }
  }

  private var displayLayer: AVSampleBufferDisplayLayer { (view as! DisplayLayerView).displayLayer }
  private let queue = DispatchQueue(label: "stim.video.decode")
  private var attached: HybridVideoStream?
  private var format: CMVideoFormatDescription?
  private var sps = Data()
  private var pps = Data()
  private var waitingForKeyframe = true
  private var generation = 0
  private var lastKeyframeRequest = Date.distantPast

  func onDropView() {
    attach(nil)
  }

  func prepareForRecycle() {
    attach(nil)
  }

  func decode(_ accessUnit: Data, generation: Int, received: UInt64) {
    let stream = attached
    queue.async { self.decodeOnQueue(accessUnit, generation: generation, received: received, stream: stream) }
  }

  private func attach(_ next: HybridVideoStream?) {
    if attached === next { return }
    attached?.detach(self)
    attached = next
    queue.async { self.reset() }
    next?.attach(self)
  }

  /// Releases the decoder state and the shown image; runs on `queue`.
  private func reset() {
    format = nil
    sps = Data()
    pps = Data()
    waitingForKeyframe = true
    generation = 0
    displayLayer.flushAndRemoveImage()
  }

  private func decodeOnQueue(_ accessUnit: Data, generation: Int, received: UInt64, stream: HybridVideoStream?) {
    let layer = displayLayer
    if self.generation != generation {
      self.generation = generation
      layer.flushAndRemoveImage()
      waitingForKeyframe = true
      DispatchQueue.main.async { self.onOrientationCleared?(Double(generation)) }
    }
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
    guard let format, !slices.isEmpty else {
      stream?.recordDropped()
      return requestKeyframe()
    }
    if !layer.isReadyForMoreMediaData {
      waitingForKeyframe = true
      stream?.recordDropped()
      requestKeyframe()
      return
    }
    if waitingForKeyframe {
      guard keyframe else {
        stream?.recordDropped()
        return requestKeyframe()
      }
      waitingForKeyframe = false
    }
    guard let sample = sampleBuffer(slices, format: format) else { return }
    layer.enqueue(sample)
    stream?.recordDecoded(received: received)
    stream?.recordPresented(received: received)
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
      displayLayer.flush()
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

  private func requestKeyframe() {
    let now = Date()
    guard now.timeIntervalSince(lastKeyframeRequest) >= 0.5 else { return }
    lastKeyframeRequest = now
    DispatchQueue.main.async { self.onKeyframeNeeded?() }
  }
}
