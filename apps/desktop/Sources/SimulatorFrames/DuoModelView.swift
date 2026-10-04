// Copyright (c) 2026 Siniulator contributors. Adapted under the MIT license in Support/Siniulator-LICENSE.txt.
import AppKit
import IOSurface
import Metal
import SceneKit

@MainActor
final class DuoModelView: SCNView {
  private let clip: DuoPoseClip
  private let cameraNode = SCNNode()
  private let inner: SCNNode
  private let cover: SCNNode
  private let innerHits: DuoScreenHitMesh
  private let coverHits: DuoScreenHitMesh
  private let metal: MTLDevice
  private var textures: [UInt32: MTLTexture] = [:]
  private var surfaces: [UInt32: IOSurface] = [:]
  private var frozen: [UInt32: MTLTexture] = [:]
  private var pendingSnapshot: (id: UInt32, texture: MTLTexture)?
  let innerID: UInt32
  let coverID: UInt32
  private let nativeTurns: [UInt32: Int]
  private var angle: CGFloat = 180
  private var quarterTurns = 0
  var activeID: UInt32

  static var assetURL: URL {
    URL(fileURLWithPath: CoreSimulator.developerDir)
      .deletingLastPathComponent()
      .appendingPathComponent(
        "SharedFrameworks/DeviceKit.framework/Versions/A/PlugIns/CoreDevicePopDeviceKitExtension.devicekitplugin/Contents/Resources/V68.usdz"
      )
  }

  static func load(innerID: UInt32, coverID: UInt32, nativeTurns: [UInt32: Int], assetURL: URL? = nil) -> DuoModelView? {
    guard let source = SCNSceneSource(url: assetURL ?? Self.assetURL, options: nil),
      let scene = source.scene(options: [.animationImportPolicy: SCNSceneSource.AnimationImportPolicy.play]),
      let inner = scene.rootNode.childNode(withName: "mQHVkATpIwJRVQx", recursively: true),
      let cover = scene.rootNode.childNode(withName: "zaWsadDZpWAUDAX", recursively: true),
      let clip = DuoPoseClip(root: scene.rootNode),
      let innerHits = DuoScreenHitMesh(node: inner),
      let coverHits = DuoScreenHitMesh(node: cover),
      let metal = MTLCreateSystemDefaultDevice()
    else { return nil }
    return DuoModelView(
      scene: scene, inner: inner, cover: cover, clip: clip,
      innerHits: innerHits, coverHits: coverHits, metal: metal, innerID: innerID, coverID: coverID, nativeTurns: nativeTurns)
  }

  private init(
    scene: SCNScene, inner: SCNNode, cover: SCNNode, clip: DuoPoseClip,
    innerHits: DuoScreenHitMesh, coverHits: DuoScreenHitMesh, metal: MTLDevice,
    innerID: UInt32, coverID: UInt32, nativeTurns: [UInt32: Int]
  ) {
    self.inner = inner
    self.cover = cover
    self.clip = clip
    self.innerHits = innerHits
    self.coverHits = coverHits
    self.metal = metal
    self.innerID = innerID
    self.coverID = coverID
    activeID = innerID
    self.nativeTurns = nativeTurns
    super.init(frame: .zero, options: [SCNView.Option.preferredRenderingAPI.rawValue: SCNRenderingAPI.metal.rawValue])
    self.scene = scene
    scene.rootNode.addChildNode(cameraNode)
    let camera = SCNCamera()
    camera.fieldOfView = 31
    camera.zNear = 0.01
    camera.zFar = 200
    camera.wantsHDR = false
    cameraNode.camera = camera
    pointOfView = cameraNode
    backgroundColor = .clear
    wantsLayer = true
    layer?.backgroundColor = NSColor.clear.cgColor
    antialiasingMode = .multisampling4X
    allowsCameraControl = false
    rendersContinuously = false
    isPlaying = false
    prepare(inner)
    prepare(cover)
    let ambient = SCNNode()
    ambient.light = SCNLight()
    ambient.light?.type = .ambient
    ambient.light?.color = NSColor(white: 0.5, alpha: 1)
    scene.rootNode.addChildNode(ambient)
    let key = SCNNode()
    key.light = SCNLight()
    key.light?.type = .omni
    key.light?.intensity = 900
    key.position = SCNVector3(-4, 24, -8)
    scene.rootNode.addChildNode(key)
    setPose(angle: 180, orientation: 1, activeID: innerID)
  }

  required init?(coder: NSCoder) { nil }
  override func hitTest(_ point: NSPoint) -> NSView? { nil }

  func updateSurface(_ surface: IOSurface?, screenID: UInt32) {
    guard let surface else {
      surfaces[screenID] = nil
      textures[screenID] = nil
      if frozen[screenID] == nil {
        for material in node(screenID).geometry?.materials ?? [] { material.diffuse.contents = nil }
      }
      needsDisplay = true
      return
    }
    let changed = surfaces[screenID] !== surface
    surfaces[screenID] = surface
    guard frozen[screenID] == nil else { return }
    if changed || textures[screenID] == nil {
      textures[screenID] = texture(surface)
    }
    let matrix = textureTransform(turns: nativeTurns[screenID] ?? 0)
    for material in node(screenID).geometry?.materials ?? [] {
      material.diffuse.contents = textures[screenID]
      material.diffuse.contentsTransform = matrix
    }
    needsDisplay = true
  }

  func preparePanelChange() {
    guard let surface = surfaces[activeID], let texture = textures[activeID] else { return }
    let descriptor = MTLTextureDescriptor.texture2DDescriptor(
      pixelFormat: texture.pixelFormat,
      width: texture.width, height: texture.height, mipmapped: false)
    descriptor.storageMode = .shared
    descriptor.usage = .shaderRead
    guard let snapshot = metal.makeTexture(descriptor: descriptor) else { return }
    surface.lock(options: .readOnly, seed: nil)
    snapshot.replace(
      region: MTLRegionMake2D(0, 0, texture.width, texture.height), mipmapLevel: 0,
      withBytes: surface.baseAddress, bytesPerRow: surface.bytesPerRow)
    surface.unlock(options: .readOnly, seed: nil)
    pendingSnapshot = (activeID, snapshot)
  }

  func setPose(angle: CGFloat, orientation: UInt32, activeID: UInt32) {
    let nextAngle = min(180, max(0, angle))
    let uiTurns = orientation == 3 ? 1 : orientation == 4 ? 3 : orientation == 2 ? 2 : 0
    let nextTurns = (uiTurns - (nativeTurns[activeID] ?? 0) + 4) % 4
    guard self.angle != nextAngle || quarterTurns != nextTurns || self.activeID != activeID else { return }
    if self.activeID != activeID {
      if let snapshot = pendingSnapshot, snapshot.id == self.activeID {
        frozen[snapshot.id] = snapshot.texture
        for material in node(snapshot.id).geometry?.materials ?? [] { material.diffuse.contents = snapshot.texture }
      }
      pendingSnapshot = nil
      frozen[activeID] = nil
      textures[activeID] = nil
    }
    self.activeID = activeID
    self.angle = nextAngle
    quarterTurns = nextTurns
    SCNTransaction.begin()
    SCNTransaction.disableActions = true
    clip.apply(angle: self.angle)
    updateCamera()
    SCNTransaction.commit()
    if let surface = surfaces[activeID] { updateSurface(surface, screenID: activeID) }
    needsDisplay = true
  }

  override func layout() {
    super.layout()
    updateCamera()
  }

  func nativeScreenPoint(_ point: CGPoint, clamped: Bool) -> CGPoint? {
    let mesh = activeID == coverID ? coverHits : innerHits
    let near = unprojectPoint(SCNVector3(point.x, point.y, 0))
    let far = unprojectPoint(SCNVector3(point.x, point.y, 1))
    var uv = mesh.textureCoordinate(from: near, to: far)
    if uv == nil, clamped {
      uv = mesh.nearestTextureCoordinate(to: point, project: { self.projectPoint($0) }, unproject: { self.unprojectPoint($0) })
    }
    return uv.map { rotate($0, turns: nativeTurns[activeID] ?? 0) }
  }

  func viewPoint(_ native: CGPoint) -> CGPoint? {
    let mesh = activeID == coverID ? coverHits : innerHits
    let uv = rotate(native, turns: -(nativeTurns[activeID] ?? 0))
    guard let world = mesh.position(at: uv) else { return nil }
    let p = projectPoint(world)
    return CGPoint(x: p.x, y: p.y)
  }

  private func node(_ id: UInt32) -> SCNNode { id == coverID ? cover : inner }

  private func prepare(_ node: SCNNode) {
    node.geometry?.materials = (node.geometry?.materials ?? []).map { source in
      let material = source.copy() as? SCNMaterial ?? source
      material.lightingModel = .constant
      material.isDoubleSided = true
      material.blendMode = .replace
      material.transparency = 1
      material.transparent.contents = nil
      material.diffuse.intensity = 1
      material.multiply.contents = NSColor.white
      material.diffuse.wrapS = .clamp
      material.diffuse.wrapT = .clamp
      return material
    }
  }

  private func texture(_ surface: IOSurface) -> MTLTexture? {
    let format: MTLPixelFormat
    switch surface.pixelFormat {
    case 0x42475241: format = .bgra8Unorm_srgb
    case 0x52474241: format = .rgba8Unorm_srgb
    default: return nil
    }
    let descriptor = MTLTextureDescriptor.texture2DDescriptor(
      pixelFormat: format,
      width: surface.width, height: surface.height, mipmapped: false)
    descriptor.storageMode = .shared
    descriptor.usage = .shaderRead
    return metal.makeTexture(descriptor: descriptor, iosurface: surface, plane: 0)
  }

  private func updateCamera() {
    guard bounds.width > 0, bounds.height > 0 else { return }
    let t = min(1, max(0, (angle - 40) / 70))
    let orbit = -.pi / 2 * (1 - t * t * (3 - 2 * t))
    let direction = SIMD3<Float>(Float(sin(orbit)), Float(cos(orbit)), 0)
    let modelUp = SIMD3<Float>(0, 0, -1)
    let right = simd_cross(modelUp, direction)
    let rotation = Float(quarterTurns) * .pi / 2
    let up = modelUp * cos(rotation) - right * sin(rotation)
    let halfFOV = Float(31.0 * .pi / 360)
    let vertical = tan(halfFOV) * 0.9
    let horizontal = vertical * Float(bounds.width / bounds.height)
    let posed = clip.bounds()
    let cameraRight = simd_cross(up, direction)
    let distance = posed.points.reduce(Float(0)) { distance, point in
      let delta = point - posed.center
      let depth = simd_dot(delta, direction)
      return max(distance, depth + max(abs(simd_dot(delta, cameraRight)) / horizontal, abs(simd_dot(delta, up)) / vertical))
    }
    cameraNode.simdPosition = posed.center + direction * distance
    cameraNode.look(
      at: SCNVector3(posed.center.x, posed.center.y, posed.center.z),
      up: SCNVector3(up.x, up.y, up.z), localFront: SCNVector3(0, 0, -1))
  }

  private func rotate(_ p: CGPoint, turns: Int) -> CGPoint {
    switch (turns % 4 + 4) % 4 {
    case 1: return CGPoint(x: p.y, y: 1 - p.x)
    case 2: return CGPoint(x: 1 - p.x, y: 1 - p.y)
    case 3: return CGPoint(x: 1 - p.y, y: p.x)
    default: return p
    }
  }

  private func textureTransform(turns: Int) -> SCNMatrix4 {
    switch (turns % 4 + 4) % 4 {
    case 1:
      return SCNMatrix4(
        m11: 0, m12: -1, m13: 0, m14: 0, m21: 1, m22: 0, m23: 0, m24: 0,
        m31: 0, m32: 0, m33: 1, m34: 0, m41: 0, m42: 1, m43: 0, m44: 1)
    case 2:
      return SCNMatrix4(
        m11: -1, m12: 0, m13: 0, m14: 0, m21: 0, m22: -1, m23: 0, m24: 0,
        m31: 0, m32: 0, m33: 1, m34: 0, m41: 1, m42: 1, m43: 0, m44: 1)
    case 3:
      return SCNMatrix4(
        m11: 0, m12: 1, m13: 0, m14: 0, m21: -1, m22: 0, m23: 0, m24: 0,
        m31: 0, m32: 0, m33: 1, m34: 0, m41: 1, m42: 0, m43: 0, m44: 1)
    default: return SCNMatrix4Identity
    }
  }
}
