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
  /// The stream `stream` attached, on the main thread.
  private var attached: HybridVideoStream?
  /// The stream whose frames `queue` decodes; frames of any other are from before the last attach and dropped.
  private var decoding: HybridVideoStream?
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

  func decode(_ accessUnit: AccessUnit, generation: Int, received: UInt64, from stream: HybridVideoStream) {
    queue.async {
      guard self.decoding === stream else { return }
      self.decodeOnQueue(accessUnit, generation: generation, received: received, stream: stream)
    }
  }

  private func attach(_ next: HybridVideoStream?) {
    if attached === next { return }
    attached?.detach(self)
    attached = next
    queue.async {
      self.decoding = next
      self.reset()
    }
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

  private func decodeOnQueue(
    _ accessUnit: AccessUnit, generation: Int, received: UInt64, stream: HybridVideoStream
  ) {
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
    var slices: [UnsafeRawBufferPointer] = []
    var keyframe = false
    var parametersChanged = false
    for unit in AnnexB.units(UnsafeRawBufferPointer(accessUnit.bytes)) {
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
        if type >= 1 && type <= 5 { slices.append(unit) }
      }
    }
    if parametersChanged || format == nil { makeFormat() }
    guard let format, !slices.isEmpty else {
      stream.recordDropped()
      return requestKeyframe()
    }
    if !layer.isReadyForMoreMediaData {
      waitingForKeyframe = true
      stream.recordDropped()
      requestKeyframe()
      return
    }
    if waitingForKeyframe {
      guard keyframe else {
        stream.recordDropped()
        return requestKeyframe()
      }
      waitingForKeyframe = false
    }
    guard let sample = sampleBuffer(slices, of: accessUnit, format: format) else { return }
    layer.enqueue(sample)
    stream.recordDecoded(received: received)
    stream.recordPresented(received: received)
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

  /// The slices as one AVCC sample. When they are contiguous and each follows a 4-byte start code, as stim-server
  /// writes them, the start codes are rewritten as lengths in place and the block buffer references the access unit,
  /// which it keeps alive; otherwise the slices are copied into a new block.
  private func sampleBuffer(
    _ slices: [UnsafeRawBufferPointer], of accessUnit: AccessUnit, format: CMVideoFormatDescription
  ) -> CMSampleBuffer? {
    let bytes = accessUnit.bytes
    guard let base = bytes.baseAddress, let first = slices.first?.baseAddress, let last = slices.last else {
      return nil
    }
    let start = first - 4
    var inPlace = start >= UnsafeRawPointer(base)
    var expected = start
    for slice in slices where inPlace {
      let code = slice.baseAddress! - 4
      inPlace = code == expected && code.loadUnaligned(as: UInt32.self) == UInt32(1).bigEndian
      expected = slice.baseAddress! + slice.count
    }
    let length = inPlace ? last.baseAddress! + last.count - start : slices.reduce(0) { $0 + $1.count + 4 }
    var block: CMBlockBuffer?
    if inPlace {
      for slice in slices {
        UnsafeMutableRawPointer(mutating: slice.baseAddress! - 4).storeBytes(
          of: UInt32(slice.count).bigEndian, as: UInt32.self)
      }
      var source = CMBlockBufferCustomBlockSource(
        version: kCMBlockBufferCustomBlockSourceVersion, AllocateBlock: nil,
        FreeBlock: { refCon, _, _ in
          if let refCon { Unmanaged<AccessUnit>.fromOpaque(refCon).release() }
        }, refCon: Unmanaged.passUnretained(accessUnit).toOpaque())
      guard
        CMBlockBufferCreateWithMemoryBlock(
          allocator: kCFAllocatorDefault, memoryBlock: UnsafeMutableRawPointer(mutating: start), blockLength: length,
          blockAllocator: kCFAllocatorNull, customBlockSource: &source, offsetToData: 0, dataLength: length, flags: 0,
          blockBufferOut: &block) == noErr
      else { return nil }
      _ = Unmanaged.passUnretained(accessUnit).retain()
    } else {
      guard
        CMBlockBufferCreateWithMemoryBlock(
          allocator: kCFAllocatorDefault, memoryBlock: nil, blockLength: length, blockAllocator: kCFAllocatorDefault,
          customBlockSource: nil, offsetToData: 0, dataLength: length, flags: 0, blockBufferOut: &block) == noErr,
        let block
      else { return nil }
      var offset = 0
      for slice in slices {
        var size = UInt32(slice.count).bigEndian
        guard
          CMBlockBufferReplaceDataBytes(
            with: &size, blockBuffer: block, offsetIntoDestination: offset, dataLength: 4) == noErr,
          CMBlockBufferReplaceDataBytes(
            with: slice.baseAddress!, blockBuffer: block, offsetIntoDestination: offset + 4,
            dataLength: slice.count) == noErr
        else { return nil }
        offset += slice.count + 4
      }
    }
    var sample: CMSampleBuffer?
    var sampleSize = length
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
