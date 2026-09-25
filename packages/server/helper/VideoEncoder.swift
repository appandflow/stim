import Accelerate
import CoreMedia
import CoreVideo
import Foundation
import VideoToolbox

/// One encoded H.264 access unit in Annex-B form. A keyframe starts with its SPS and PPS.
struct AccessUnit {
  var data: Data
  var keyframe: Bool
  var capturedAt: Double
  var width: Int
  var height: Int
}

/// A low-latency hardware H.264 encoder: real time, no frame reordering, a keyframe at least every 2 s.
/// Each source frame is copied, rotated upright and scaled to fit `maxEdge` before encoding, so a source
/// surface the simulator keeps drawing into is never read after `encode` returns.
final class VideoEncoder {
  static let minBitrate = 250_000
  static let maxBitrate = 8_000_000

  private let queue = DispatchQueue(label: "stim.video.encode")
  private let output: (AccessUnit) -> Void
  private var session: VTCompressionSession?
  private var transfer: VTPixelTransferSession?
  private var rotation: VTPixelRotationSession?
  private var rotated: CVPixelBufferPool?
  private var rotatedSize = (width: 0, height: 0)
  private var size = (width: 0, height: 0)
  private var forceKeyframe = true
  private var lastTimestamp = CMTime.invalid

  private var maxEdge: Int
  private var fps: Int
  private var bitrate: Int
  private var bgra: CVPixelBufferPool?
  private var bgraSize = (width: 0, height: 0)

  init(maxEdge: Int, fps: Int, bitrate: Int, output: @escaping (AccessUnit) -> Void) {
    self.maxEdge = maxEdge
    self.fps = fps
    self.bitrate = bitrate
    self.output = output
  }

  deinit {
    if let session { VTCompressionSessionInvalidate(session) }
  }

  func configure(maxEdge: Int, fps: Int, bitrate: Int) {
    queue.async {
      self.maxEdge = maxEdge
      if self.fps != fps, let session = self.session {
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ExpectedFrameRate, value: fps as CFNumber)
      }
      self.fps = fps
      let clamped = min(max(bitrate, Self.minBitrate), Self.maxBitrate)
      if self.bitrate != clamped, let session = self.session { Self.applyBitrate(session, clamped) }
      self.bitrate = clamped
    }
  }

  func requestKeyframe() {
    queue.async { self.forceKeyframe = true }
  }

  /// `quarterTurns` counter-clockwise quarter turns make the source upright.
  func encode(_ source: CVPixelBuffer, quarterTurns: Int, capturedAt: Double) {
    queue.sync { self.encodeOnQueue(source, quarterTurns: quarterTurns, capturedAt: capturedAt) }
  }

  /// Encodes an upright RGBA8888 image, as the emulator's `streamScreenshot` sends it. CoreVideo has no
  /// RGBA pixel format, so the bytes are swizzled into a BGRA buffer.
  func encode(rgba: Data, width: Int, height: Int, capturedAt: Double) {
    queue.sync {
      if bgra == nil || bgraSize != (width, height) {
        let attributes: [CFString: Any] = [
          kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_32BGRA,
          kCVPixelBufferWidthKey: width,
          kCVPixelBufferHeightKey: height,
          kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary,
        ]
        bgra = nil
        CVPixelBufferPoolCreate(nil, nil, attributes as CFDictionary, &bgra)
        bgraSize = (width, height)
      }
      var buffer: CVPixelBuffer?
      guard rgba.count == width * height * 4, let bgra,
        CVPixelBufferPoolCreatePixelBuffer(nil, bgra, &buffer) == kCVReturnSuccess, let buffer
      else { return }
      CVPixelBufferLockBaseAddress(buffer, [])
      let swizzled = rgba.withUnsafeBytes { bytes -> Bool in
        var source = vImage_Buffer(
          data: UnsafeMutableRawPointer(mutating: bytes.baseAddress!), height: vImagePixelCount(height),
          width: vImagePixelCount(width), rowBytes: width * 4)
        var destination = vImage_Buffer(
          data: CVPixelBufferGetBaseAddress(buffer), height: vImagePixelCount(height), width: vImagePixelCount(width),
          rowBytes: CVPixelBufferGetBytesPerRow(buffer))
        return vImagePermuteChannels_ARGB8888(&source, &destination, [2, 1, 0, 3], vImage_Flags(kvImageNoFlags))
          == kvImageNoError
      }
      CVPixelBufferUnlockBaseAddress(buffer, [])
      if swizzled { encodeOnQueue(buffer, quarterTurns: 0, capturedAt: capturedAt) }
    }
  }

  private func encodeOnQueue(_ source: CVPixelBuffer, quarterTurns: Int, capturedAt: Double) {
    let sideways = quarterTurns % 2 != 0
    let width = sideways ? CVPixelBufferGetHeight(source) : CVPixelBufferGetWidth(source)
    let height = sideways ? CVPixelBufferGetWidth(source) : CVPixelBufferGetHeight(source)
    let target = Self.fit(width: width, height: height, maxEdge: maxEdge)
    guard let session = session(for: target), let pool = VTCompressionSessionGetPixelBufferPool(session),
      let input = upright(source, quarterTurns: quarterTurns, width: width, height: height)
    else { return }
    var buffer: CVPixelBuffer?
    guard CVPixelBufferPoolCreatePixelBuffer(nil, pool, &buffer) == kCVReturnSuccess, let buffer,
      let transfer = transferSession(),
      VTPixelTransferSessionTransferImage(transfer, from: input, to: buffer) == noErr
    else { return }
    var timestamp = CMTime(value: CMTimeValue(capturedAt * 1000), timescale: 1_000_000)
    if lastTimestamp.isValid, timestamp <= lastTimestamp {
      timestamp = CMTimeAdd(lastTimestamp, CMTime(value: 1, timescale: 1_000_000))
    }
    lastTimestamp = timestamp
    let properties = forceKeyframe ? [kVTEncodeFrameOptionKey_ForceKeyFrame: true] as CFDictionary : nil
    forceKeyframe = false
    VTCompressionSessionEncodeFrame(
      session, imageBuffer: buffer, presentationTimeStamp: timestamp, duration: .invalid,
      frameProperties: properties, infoFlagsOut: nil
    ) { [output] status, _, sample in
      guard status == noErr, let sample, let unit = Self.annexB(sample) else { return }
      output(
        AccessUnit(
          data: unit.data, keyframe: unit.keyframe, capturedAt: capturedAt, width: target.width, height: target.height))
    }
  }

  static func fit(width: Int, height: Int, maxEdge: Int) -> (width: Int, height: Int) {
    let scale = min(1, Double(maxEdge) / Double(max(width, height)))
    let even = { (value: Double) in max(2, Int(value.rounded(.down)) & ~1) }
    return (even(Double(width) * scale), even(Double(height) * scale))
  }

  private func session(for target: (width: Int, height: Int)) -> VTCompressionSession? {
    if let session, size == target { return session }
    if let session { VTCompressionSessionInvalidate(session) }
    session = nil
    size = target
    forceKeyframe = true
    let specification: [CFString: Any] = [
      kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder: true,
      kVTVideoEncoderSpecification_EnableLowLatencyRateControl: true,
    ]
    let attributes: [CFString: Any] = [
      kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
      kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary,
    ]
    var created: VTCompressionSession?
    guard
      VTCompressionSessionCreate(
        allocator: nil, width: Int32(target.width), height: Int32(target.height), codecType: kCMVideoCodecType_H264,
        encoderSpecification: specification as CFDictionary, imageBufferAttributes: attributes as CFDictionary,
        compressedDataAllocator: nil, outputCallback: nil, refcon: nil, compressionSessionOut: &created) == noErr,
      let created
    else { return nil }
    let properties: [CFString: Any] = [
      kVTCompressionPropertyKey_RealTime: true,
      kVTCompressionPropertyKey_AllowFrameReordering: false,
      kVTCompressionPropertyKey_ProfileLevel: kVTProfileLevel_H264_Main_AutoLevel,
      kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration: 2,
      kVTCompressionPropertyKey_ExpectedFrameRate: fps,
    ]
    for (key, value) in properties { VTSessionSetProperty(created, key: key, value: value as CFTypeRef) }
    Self.applyBitrate(created, bitrate)
    VTCompressionSessionPrepareToEncodeFrames(created)
    session = created
    return created
  }

  private static func applyBitrate(_ session: VTCompressionSession, _ bitrate: Int) {
    VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AverageBitRate, value: bitrate as CFNumber)
  }

  private func transferSession() -> VTPixelTransferSession? {
    if transfer == nil {
      VTPixelTransferSessionCreate(allocator: nil, pixelTransferSessionOut: &transfer)
      if let transfer {
        VTSessionSetProperty(transfer, key: kVTPixelTransferPropertyKey_ScalingMode, value: kVTScalingMode_Normal)
      }
    }
    return transfer
  }

  private func upright(_ source: CVPixelBuffer, quarterTurns: Int, width: Int, height: Int) -> CVPixelBuffer? {
    let turns = ((quarterTurns % 4) + 4) % 4
    if turns == 0 { return source }
    if rotation == nil { VTPixelRotationSessionCreate(nil, &rotation) }
    guard let rotation else { return nil }
    let angle = [kVTRotation_0, kVTRotation_CCW90, kVTRotation_180, kVTRotation_CW90][turns]
    VTSessionSetProperty(rotation, key: kVTPixelRotationPropertyKey_Rotation, value: angle)
    if rotated == nil || rotatedSize != (width, height) {
      let attributes: [CFString: Any] = [
        kCVPixelBufferPixelFormatTypeKey: CVPixelBufferGetPixelFormatType(source),
        kCVPixelBufferWidthKey: width,
        kCVPixelBufferHeightKey: height,
        kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary,
      ]
      rotated = nil
      CVPixelBufferPoolCreate(nil, nil, attributes as CFDictionary, &rotated)
      rotatedSize = (width, height)
    }
    var buffer: CVPixelBuffer?
    guard let rotated, CVPixelBufferPoolCreatePixelBuffer(nil, rotated, &buffer) == kCVReturnSuccess, let buffer,
      VTPixelRotationSessionRotateImage(rotation, source, buffer) == noErr
    else { return nil }
    return buffer
  }

  private static let startCode: [UInt8] = [0, 0, 0, 1]

  /// Converts the encoder's length-prefixed (AVCC) sample to Annex B, with the SPS and PPS before a keyframe.
  static func annexB(_ sample: CMSampleBuffer) -> (data: Data, keyframe: Bool)? {
    guard let block = CMSampleBufferGetDataBuffer(sample) else { return nil }
    let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[CFString: Any]]
    let keyframe = !(attachments?.first?[kCMSampleAttachmentKey_NotSync] as? Bool ?? false)
    var out = Data()
    if keyframe, let format = CMSampleBufferGetFormatDescription(sample) {
      var count = 0
      CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
        format, parameterSetIndex: 0, parameterSetPointerOut: nil, parameterSetSizeOut: nil,
        parameterSetCountOut: &count, nalUnitHeaderLengthOut: nil)
      for index in 0..<count {
        var pointer: UnsafePointer<UInt8>?
        var length = 0
        guard
          CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
            format, parameterSetIndex: index, parameterSetPointerOut: &pointer, parameterSetSizeOut: &length,
            parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil) == noErr, let pointer
        else { return nil }
        out.append(contentsOf: startCode)
        out.append(pointer, count: length)
      }
    }
    let total = CMBlockBufferGetDataLength(block)
    var bytes = Data(count: total)
    let copied = bytes.withUnsafeMutableBytes {
      CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: total, destination: $0.baseAddress!)
    }
    guard copied == noErr else { return nil }
    var offset = 0
    while offset + 4 <= bytes.count {
      let length = bytes[offset..<(offset + 4)].reduce(0) { $0 << 8 | Int($1) }
      offset += 4
      guard length > 0, offset + length <= bytes.count else { return nil }
      out.append(contentsOf: startCode)
      out.append(bytes[offset..<(offset + length)])
      offset += length
    }
    return (out, keyframe)
  }
}
