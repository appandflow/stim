import AVFoundation
import CoreImage
import CoreMediaIO
import Foundation
import IOKit

/// The screen of a USB-cabled iPhone, view only. macOS lists a cabled iPhone as an external muxed capture device,
/// the one QuickTime's New Movie Recording shows, only after a process sets
/// `kCMIOHardwarePropertyAllowScreenCaptureDevices`, and the device appears some seconds later. Capture runs only
/// while a subscriber asks for frames, so the phone is free for QuickTime otherwise.
///
/// The capture device's unique ID is a random UUID (macOS 27), and none of its CoreMediaIO properties names the
/// UDID. The USB device does: its serial number is the UDID without dashes. So the UDID must be cabled, and the
/// capture device is the only iOS one while one iPhone is cabled, or else the one named `name`; any other case
/// refuses rather than guess.
final class PhoneSource: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
  static let searchSeconds = 15.0
  static let retrySeconds = 2.0

  let udid: String
  let name: String?
  let queue = DispatchQueue(label: "stim.frames.phone")
  private let captureQueue = DispatchQueue(label: "stim.frames.phone-capture")
  private var pacer: Pacer!
  private let video = videoEncoder()
  private let jpegGate = JpegGate()
  private var config = Config(fps: 0)
  private var device: AVCaptureDevice?
  private var session: AVCaptureSession?
  private var authorized = false
  private var latest: CVPixelBuffer?
  private var retrying = false
  private var failure: String?
  private var reportedStall: String??
  private var observers: [NSObjectProtocol] = []
  private var watches: [NSKeyValueObservation] = []

  init(udid: String, name: String?) {
    self.udid = udid
    self.name = name
    super.init()
    pacer = Pacer { [unowned self] config in
      guard let pixels = self.queue.sync(execute: { self.latest }) else { return }
      self.render(pixels, config: config)
    }
  }

  /// The serial numbers of the iOS devices on USB, which are their UDIDs without dashes. The registry is walked
  /// instead of matched, because macOS leaves a cabled iPhone's USB device unregistered.
  static func cabledSerials() -> Set<String> {
    var iterator: io_iterator_t = 0
    guard
      IORegistryEntryCreateIterator(
        IORegistryGetRootEntry(kIOMainPortDefault), "IOUSB", IOOptionBits(kIORegistryIterateRecursively), &iterator)
        == KERN_SUCCESS
    else { return [] }
    defer { IOObjectRelease(iterator) }
    var serials: Set<String> = []
    while case let entry = IOIteratorNext(iterator), entry != 0 {
      defer { IOObjectRelease(entry) }
      let property = { (key: String) in
        IORegistryEntryCreateCFProperty(entry, key as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue()
      }
      guard property("UsbAppleDeviceECID") != nil, let serial = property("USB Serial Number") as? String else { continue }
      serials.insert(serial.uppercased())
    }
    return serials
  }

  func start() {
    var address = CMIOObjectPropertyAddress(
      mSelector: CMIOObjectPropertySelector(kCMIOHardwarePropertyAllowScreenCaptureDevices),
      mScope: CMIOObjectPropertyScope(kCMIOObjectPropertyScopeGlobal),
      mElement: CMIOObjectPropertyElement(kCMIOObjectPropertyElementMain))
    var allow: UInt32 = 1
    let status = CMIOObjectSetPropertyData(
      CMIOObjectID(kCMIOObjectSystemObject), &address, 0, nil, UInt32(MemoryLayout<UInt32>.size), &allow)
    guard status == 0 else { fail("macOS refused to list iPhone screens as capture devices (CoreMediaIO \(status)).") }
    let center = NotificationCenter.default
    observers.append(
      center.addObserver(forName: AVCaptureDevice.wasConnectedNotification, object: nil, queue: nil) { [weak self] _ in
        self?.queue.async { self?.find(until: nil) }
      })
    observers.append(
      center.addObserver(forName: AVCaptureDevice.wasDisconnectedNotification, object: nil, queue: nil) {
        [weak self] note in
        guard let gone = note.object as? AVCaptureDevice else { return }
        self?.queue.async {
          guard let self, let device = self.device, device.uniqueID == gone.uniqueID else { return }
          fail("The iPhone \(self.udid) was disconnected from this Mac.")
        }
      })
    find(until: Date().addingTimeInterval(Self.searchSeconds))
  }

  private func find(until deadline: Date?) {
    guard device == nil else { return }
    let cabled = Self.cabledSerials()
    guard cabled.contains(udid.replacingOccurrences(of: "-", with: "").uppercased()) else {
      fail(
        "The iPhone \(udid) is not cabled to this Mac. Stim shows a physical iPhone's screen only over a USB cable.")
    }
    let screens = AVCaptureDevice.DiscoverySession(deviceTypes: [.external], mediaType: .muxed, position: .unspecified)
      .devices.filter { $0.modelID == "iOS Device" }
    let found: AVCaptureDevice?
    if cabled.count == 1 && screens.count <= 1 {
      found = screens.first
    } else {
      guard let name else {
        fail("Several iPhones are cabled to this Mac, and Stim has no name to tell \(udid) apart from them.")
      }
      let named = screens.filter { $0.localizedName == name }
      if named.count > 1 {
        fail(
          "Several cabled iPhones are named \(name), so Stim cannot tell which one is \(udid). Rename one in "
            + "Settings > General > About > Name.")
      }
      found = named.first
    }
    guard let found else {
      guard let deadline else { return }
      if Date() > deadline {
        fail("macOS shows no screen for the iPhone \(udid). Unlock it, and tap Trust if it asks to trust this Mac.")
      }
      queue.asyncAfter(deadline: .now() + 1) { self.find(until: deadline) }
      return
    }
    device = found
    for key in [\AVCaptureDevice.isSuspended, \AVCaptureDevice.isInUseByAnotherApplication] {
      watches.append(found.observe(key) { [weak self] _, _ in self?.queue.async { self?.reportStall() } })
    }
    authorize()
  }

  /// The first capture asks the user for Camera access, which macOS attributes to the app that started stim-server.
  private func authorize() {
    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .authorized:
      authorized = true
      failure = nil
      reportStall()
      apply()
    case .notDetermined:
      failure = "macOS is asking on the Mac whether the app that runs stim-server may use the camera."
      reportStall()
      AVCaptureDevice.requestAccess(for: .video) { granted in
        self.queue.async {
          if !granted { self.denied() }
          self.authorize()
        }
      }
    default:
      denied()
    }
  }

  /// macOS denies without a prompt when the responsible app has no camera usage description, or runs with the
  /// hardened runtime and lacks the camera entitlement, such as a bare `node`.
  private func denied() -> Never {
    fail(
      "macOS denied Camera access, which capturing an iPhone screen needs. Run stim-server from Stim, and allow Stim "
        + "in System Settings > Privacy & Security > Camera.")
  }

  func configure(_ config: Config) {
    video.configure(enabled: config.video, maxEdge: config.maxEdge, fps: Int(config.fps), bitrate: config.bitrate)
    queue.async {
      self.config = config
      self.pacer.queue.async {
        self.pacer.config = config
        self.pacer.changed()
      }
      self.apply()
    }
  }

  func keyframe() {
    video.requestKeyframe()
    pacer.changed()
  }

  private func apply() {
    let wanted = config.fps > 0 && (config.jpeg || config.video)
    if wanted, session == nil, authorized, let device { open(device) }
    if !wanted, let session {
      self.session = nil
      latest = nil
      captureQueue.async { session.stopRunning() }
    }
  }

  private func open(_ device: AVCaptureDevice) {
    let session = AVCaptureSession()
    do {
      let input = try AVCaptureDeviceInput(device: device)
      for port in input.ports where port.mediaType != .video { port.isEnabled = false }
      guard session.canAddInput(input) else { throw CaptureError.refused }
      session.addInput(input)
    } catch {
      failure = "The iPhone \(udid) could not be opened for capture (\(error.localizedDescription))."
      return retry()
    }
    let output = AVCaptureVideoDataOutput()
    output.alwaysDiscardsLateVideoFrames = true
    output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
    output.setSampleBufferDelegate(self, queue: captureQueue)
    guard session.canAddOutput(output) else {
      failure = "The iPhone \(udid) offers no video output macOS can read."
      return retry()
    }
    session.addOutput(output)
    observers.append(
      NotificationCenter.default.addObserver(forName: AVCaptureSession.runtimeErrorNotification, object: session, queue: nil) {
        [weak self] note in
        let error = note.userInfo?[AVCaptureSessionErrorKey] as? Error
        self?.queue.async {
          guard let self, self.session === session else { return }
          self.failure = "Capture of the iPhone \(self.udid) stopped (\(error?.localizedDescription ?? "unknown error"))."
          self.session = nil
          self.captureQueue.async { session.stopRunning() }
          self.retry()
        }
      })
    self.session = session
    failure = nil
    reportStall()
    captureQueue.async { session.startRunning() }
  }

  private func retry() {
    reportStall()
    guard !retrying else { return }
    retrying = true
    queue.asyncAfter(deadline: .now() + Self.retrySeconds) {
      self.retrying = false
      self.apply()
    }
  }

  /// A locked iPhone, a device another app such as QuickTime captures, and a failed open are stalls: the last
  /// frame stays on screen with the reason, and frames resume when the reason clears.
  private func reportStall() {
    let stall: String?
    if let device, device.isInUseByAnotherApplication {
      stall = "Another app, such as QuickTime Player, is capturing this iPhone."
    } else if let device, device.isSuspended {
      stall = "The iPhone is locked. Unlock it to see its screen."
    } else {
      stall = failure
    }
    guard reportedStall != .some(stall) else { return }
    reportedStall = .some(stall)
    Output.notice(["stalled": stall.map { $0 as Any } ?? NSNull()])
  }

  func captureOutput(_ output: AVCaptureOutput, didOutput sample: CMSampleBuffer, from connection: AVCaptureConnection) {
    guard let pixels = CMSampleBufferGetImageBuffer(sample) else { return }
    queue.async { self.latest = pixels }
    pacer.changed()
  }

  private func render(_ pixels: CVPixelBuffer, config: Config) {
    if config.video { video.encode(pixels, quarterTurns: 0, capturedAt: now()) }
    guard config.jpeg, jpegGate.admit(config, pacer: pacer),
      let (data, width, height) = jpeg(CIImage(cvPixelBuffer: pixels), config: config)
    else { return }
    Output.frame(jpeg: data, width: width, height: height)
  }

  private enum CaptureError: Error { case refused }
}

extension PhoneSource: Source {
  func input(_ command: Command) {
    Output.notice(["inputError": "Stim shows a physical iPhone's screen but does not send it input."])
  }
}
