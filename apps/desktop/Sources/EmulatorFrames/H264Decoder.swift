import CoreMedia
import CoreVideo
import Foundation
import VideoToolbox

/// Decodes an Annex-B H.264 stream into BGRA pixel buffers, one per access unit. A config packet (SPS and
/// PPS) replaces the session; packets before the first config are dropped.
public final class H264Decoder {
  private var format: CMVideoFormatDescription?
  private var session: VTDecompressionSession?
  private let output: (CVPixelBuffer) -> Void

  public init(output: @escaping (CVPixelBuffer) -> Void) {
    self.output = output
  }

  deinit {
    invalidate()
  }

  public func invalidate() {
    if let session {
      VTDecompressionSessionWaitForAsynchronousFrames(session)
      VTDecompressionSessionInvalidate(session)
    }
    session = nil
    format = nil
  }

  /// Returns false when the parameter sets could not make a decoder.
  @discardableResult
  public func configure(_ annexB: Data) -> Bool {
    invalidate()
    let units = AnnexB.units(annexB)
    guard let sps = units.first(where: { ($0.first ?? 0) & 0x1f == 7 }),
      let pps = units.first(where: { ($0.first ?? 0) & 0x1f == 8 })
    else { return false }
    var description: CMVideoFormatDescription?
    let status = sps.withUnsafeBytes { spsBytes in
      pps.withUnsafeBytes { ppsBytes in
        let pointers = [
          spsBytes.bindMemory(to: UInt8.self).baseAddress!, ppsBytes.bindMemory(to: UInt8.self).baseAddress!,
        ]
        return CMVideoFormatDescriptionCreateFromH264ParameterSets(
          allocator: nil, parameterSetCount: 2, parameterSetPointers: pointers, parameterSetSizes: [sps.count, pps.count],
          nalUnitHeaderLength: 4, formatDescriptionOut: &description)
      }
    }
    guard status == noErr, let description else { return false }
    let attributes: [CFString: Any] = [
      kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_32BGRA,
      kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary,
    ]
    var created: VTDecompressionSession?
    guard
      VTDecompressionSessionCreate(
        allocator: nil, formatDescription: description, decoderSpecification: nil,
        imageBufferAttributes: attributes as CFDictionary, outputCallback: nil, decompressionSessionOut: &created)
        == noErr, let created
    else { return false }
    format = description
    session = created
    return true
  }

  public func decode(_ annexB: Data) {
    guard let session, let format else { return }
    let units = AnnexB.units(annexB).filter { !$0.isEmpty && ![7, 8].contains($0[0] & 0x1f) }
    guard !units.isEmpty else { return }
    let sample = AnnexB.lengthPrefixed(units)
    var block: CMBlockBuffer?
    guard
      CMBlockBufferCreateWithMemoryBlock(
        allocator: nil, memoryBlock: nil, blockLength: sample.count, blockAllocator: nil, customBlockSource: nil,
        offsetToData: 0, dataLength: sample.count, flags: kCMBlockBufferAssureMemoryNowFlag, blockBufferOut: &block)
        == noErr, let block,
      sample.withUnsafeBytes({ CMBlockBufferReplaceDataBytes(with: $0.baseAddress!, blockBuffer: block, offsetIntoDestination: 0, dataLength: sample.count) }) == noErr
    else { return }
    var buffer: CMSampleBuffer?
    var size = sample.count
    guard
      CMSampleBufferCreateReady(
        allocator: nil, dataBuffer: block, formatDescription: format, sampleCount: 1, sampleTimingEntryCount: 0,
        sampleTimingArray: nil, sampleSizeEntryCount: 1, sampleSizeArray: &size, sampleBufferOut: &buffer) == noErr,
      let buffer
    else { return }
    let output = self.output
    VTDecompressionSessionDecodeFrame(session, sampleBuffer: buffer, flags: [], infoFlagsOut: nil) {
      status, _, image, _, _ in
      if status == noErr, let image { output(image) }
    }
  }
}
