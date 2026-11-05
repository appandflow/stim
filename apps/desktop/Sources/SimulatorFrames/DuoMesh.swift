// Copyright (c) 2026 Siniulator contributors. Adapted under the MIT license in Support/Siniulator-LICENSE.txt.
import SceneKit
import simd

@MainActor struct DuoMesh {
  let node: SCNNode
  let vertices: [SIMD4<Float>]
  let bones: [SCNNode]
  let binds: [simd_float4x4]
  let influences: [[(index: Int, weight: Float)]]

  init?(node: SCNNode) {
    guard let source = node.geometry?.sources(for: .vertex).first,
      source.componentsPerVector == 3, let values = Self.components(source),
      values.allSatisfy({ Float($0).isFinite })
    else { return nil }
    self.node = node
    vertices = stride(from: 0, to: values.count, by: 3).map {
      SIMD4(Float(values[$0]), Float(values[$0 + 1]), Float(values[$0 + 2]), 1)
    }
    guard let skin = node.skinner else {
      bones = []
      binds = []
      influences = []
      return
    }
    bones = skin.bones
    let bind = simd_float4x4(skin.baseGeometryBindTransform)
    binds =
      (skin.boneInverseBindTransforms?.map { simd_float4x4($0.scnMatrix4Value) }
      ?? Array(repeating: matrix_identity_float4x4, count: bones.count)).map { $0 * bind }
    guard !bones.isEmpty, binds.count == bones.count else { return nil }
    if skin.boneWeights.vectorCount == 0, skin.boneIndices.vectorCount == 0 {
      guard bones.count == 1 else { return nil }
      influences = vertices.map { _ in [(0, 1)] }
      return
    }
    guard skin.boneWeights.vectorCount == vertices.count,
      skin.boneIndices.vectorCount == vertices.count,
      skin.boneWeights.componentsPerVector == skin.boneIndices.componentsPerVector,
      let indices = Self.components(skin.boneIndices),
      let weights = Self.components(skin.boneWeights), indices.count == weights.count,
      indices.allSatisfy({ $0.isFinite && $0 >= 0 && $0 < Double(skin.bones.count) && $0.rounded() == $0 }),
      weights.allSatisfy({ Float($0).isFinite && $0 >= 0 })
    else { return nil }
    let count = skin.boneIndices.componentsPerVector
    influences = vertices.indices.map { vertex in
      (0..<count).compactMap { offset in
        let index = vertex * count + offset
        return weights[index] > 0 ? (Int(indices[index]), Float(weights[index])) : nil
      }
    }
    guard influences.allSatisfy({ !$0.isEmpty }) else { return nil }
  }

  var transforms: [simd_float4x4] {
    bones.isEmpty
      ? [node.simdWorldTransform]
      : bones.indices.map {
        bones[$0].simdWorldTransform * binds[$0]
      }
  }

  func position(at index: Int, using transforms: [simd_float4x4]) -> SIMD4<Float> {
    let vertex = vertices[index]
    if influences.isEmpty { return transforms[0] * vertex }
    return influences[index].reduce(SIMD4<Float>.zero) {
      $0 + transforms[$1.index] * vertex * $1.weight
    }
  }

  static func components(_ source: SCNGeometrySource) -> [Double]? {
    let size = source.bytesPerComponent
    guard source.vectorCount > 0, source.componentsPerVector > 0,
      source.dataOffset >= 0, source.dataStride >= source.componentsPerVector * size,
      [1, 2, 4, 8].contains(size),
      !source.usesFloatComponents || [4, 8].contains(size),
      source.dataOffset + (source.vectorCount - 1) * source.dataStride
        + source.componentsPerVector * size <= source.data.count
    else { return nil }
    return source.data.withUnsafeBytes { data in
      (0..<source.vectorCount).flatMap { vector in
        (0..<source.componentsPerVector).map { component -> Double in
          let offset = source.dataOffset + vector * source.dataStride + component * size
          if source.usesFloatComponents {
            return size == 4
              ? Double(data.loadUnaligned(fromByteOffset: offset, as: Float.self))
              : data.loadUnaligned(fromByteOffset: offset, as: Double.self)
          }
          switch size {
          case 1: return Double(data.loadUnaligned(fromByteOffset: offset, as: UInt8.self))
          case 2: return Double(data.loadUnaligned(fromByteOffset: offset, as: UInt16.self))
          case 4: return Double(data.loadUnaligned(fromByteOffset: offset, as: UInt32.self))
          default: return Double(data.loadUnaligned(fromByteOffset: offset, as: UInt64.self))
          }
        }
      }
    }
  }
}
