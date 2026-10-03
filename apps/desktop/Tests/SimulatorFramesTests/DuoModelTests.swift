import AppKit
import SceneKit
import Testing

@testable import SimulatorFrames

@Suite @MainActor
struct DuoModelTests {
  @Test func missingModelKeepsTheFramelessFallback() {
    let path = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).appendingPathExtension("usdz")
    #expect(DuoModelView.load(innerID: 3, coverID: 1, nativeTurns: [1: 0, 3: 1], assetURL: path) == nil)
  }

  @Test func followsPosedBoneWithIndependentTextureIndices() throws {
    let vertex = SCNGeometrySource(vertices: [SCNVector3(-1, -1, 0), SCNVector3(1, -1, 0), SCNVector3(0, 1, 0)])
    let texture = SCNGeometrySource(textureCoordinates: [CGPoint(x: 1, y: 0), CGPoint(x: 0.5, y: 1), CGPoint(x: 0, y: 0)])
    let element = SCNGeometryElement(
      data: Data([0, 2, 1, 0, 2, 1]), primitiveType: .triangles,
      primitiveCount: 1, indicesChannelCount: 2, interleavedIndicesChannels: true, bytesPerIndex: 1)
    let geometry = SCNGeometry(sources: [vertex, texture], elements: [element], sourceChannels: [0, 1])
    let weights: [Float] = [1, 1, 1]
    let weightData = weights.withUnsafeBytes { Data($0) }
    let weightSource = SCNGeometrySource(
      data: weightData, semantic: .boneWeights,
      vectorCount: 3, usesFloatComponents: true, componentsPerVector: 1, bytesPerComponent: 4, dataOffset: 0, dataStride: 4)
    let indexSource = SCNGeometrySource(
      data: Data([0, 0, 0]), semantic: .boneIndices,
      vectorCount: 3, usesFloatComponents: false, componentsPerVector: 1, bytesPerComponent: 1, dataOffset: 0, dataStride: 1)
    let node = SCNNode(geometry: geometry)
    let bone = SCNNode()
    node.skinner = SCNSkinner(
      baseGeometry: geometry, bones: [bone],
      boneInverseBindTransforms: [NSValue(scnMatrix4: SCNMatrix4Identity)], boneWeights: weightSource, boneIndices: indexSource)
    let root = SCNNode()
    root.addChildNode(node)
    root.addChildNode(bone)
    let hitMesh = try #require(DuoScreenHitMesh(node: node))
    let before = try #require(hitMesh.textureCoordinate(from: SCNVector3(0, 0, 1), to: SCNVector3(0, 0, -1)))
    #expect(abs(before.x - 0.5) < 0.00001 && abs(before.y - 0.5) < 0.00001)
    bone.position = SCNVector3(2, 0, 0)
    #expect(hitMesh.textureCoordinate(from: SCNVector3(0, 0, 1), to: SCNVector3(0, 0, -1)) == nil)
    let after = try #require(hitMesh.textureCoordinate(from: SCNVector3(2, 0, 1), to: SCNVector3(2, 0, -1)))
    #expect(abs(after.x - 0.5) < 0.00001 && abs(after.y - 0.5) < 0.00001)
  }
}
