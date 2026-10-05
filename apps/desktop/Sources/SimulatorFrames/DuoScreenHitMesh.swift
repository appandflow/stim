// Copyright (c) 2026 Siniulator contributors. Adapted under the MIT license in Support/Siniulator-LICENSE.txt.
import SceneKit
import simd

@MainActor final class DuoScreenHitMesh {
  private let mesh: DuoMesh
  private struct Triangle {
    let positions: SIMD3<Int>
    let uv: [SIMD2<Float>]
  }
  private let triangles: [Triangle]
  private var posed: [SIMD3<Float>] = []
  private var lastTransforms: [simd_float4x4] = []

  init?(node: SCNNode) {
    guard let geometry = node.geometry, let mesh = DuoMesh(node: node),
      let triangles = Self.triangles(geometry)
    else { return nil }
    self.mesh = mesh
    self.triangles = triangles
  }

  private func updatePose() {
    let transforms = mesh.transforms
    if transforms != lastTransforms {
      posed = mesh.vertices.indices.map { index in
        let point = mesh.position(at: index, using: transforms)
        return SIMD3(point.x, point.y, point.z)
      }
      lastTransforms = transforms
    }
  }

  func textureCoordinate(from near: SCNVector3, to far: SCNVector3) -> CGPoint? {
    updatePose()
    let origin = SIMD3<Float>(Float(near.x), Float(near.y), Float(near.z))
    let direction = SIMD3<Float>(Float(far.x), Float(far.y), Float(far.z)) - origin
    var closest: Float = 1
    var result: SIMD2<Float>?
    for triangle in triangles {
      let a = posed[triangle.positions.x]
      let ab = posed[triangle.positions.y] - a
      let ac = posed[triangle.positions.z] - a
      let p = simd_cross(direction, ac)
      let determinant = simd_dot(ab, p)
      guard abs(determinant) > 1e-8 else { continue }
      let offset = origin - a
      let u = simd_dot(offset, p) / determinant
      guard u >= -1e-5, u <= 1.00001 else { continue }
      let q = simd_cross(offset, ab)
      let v = simd_dot(direction, q) / determinant
      guard v >= -1e-5, u + v <= 1.00001 else { continue }
      let distance = simd_dot(ac, q) / determinant
      guard distance >= 0, distance <= closest else { continue }
      closest = distance
      result = triangle.uv[0] * (1 - u - v) + triangle.uv[1] * u + triangle.uv[2] * v
    }
    return result.map { CGPoint(x: CGFloat($0.x), y: CGFloat($0.y)) }
  }

  func nearestTextureCoordinate(
    to point: CGPoint, project: (SCNVector3) -> SCNVector3,
    unproject: (SCNVector3) -> SCNVector3,
    maximumDistance: CGFloat = .infinity
  ) -> CGPoint? {
    updatePose()
    let projected = posed.map { position -> SIMD3<Float> in
      let p = project(SCNVector3(position.x, position.y, position.z))
      return SIMD3(Float(p.x), Float(p.y), Float(p.z))
    }
    let target = SIMD2<Float>(Float(point.x), Float(point.y))
    var distance = Float.infinity
    var best: SIMD2<Float>?
    for triangle in triangles {
      for edge in 0..<3 {
        let next = (edge + 1) % 3
        let a = projected[triangle.positions[edge]]
        let b = projected[triangle.positions[next]]
        let t = Self.segmentFraction(target, SIMD2(a.x, a.y), SIMD2(b.x, b.y))
        let candidate = a + (b - a) * t
        let squared = simd_length_squared(SIMD2(candidate.x, candidate.y) - target)
        if squared < distance {
          let p = unproject(SCNVector3(candidate.x, candidate.y, candidate.z))
          let start = posed[triangle.positions[edge]]
          let end = posed[triangle.positions[next]]
          let length = simd_length_squared(end - start)
          let fraction =
            length > 1e-12
            ? min(1, max(0, simd_dot(SIMD3(Float(p.x), Float(p.y), Float(p.z)) - start, end - start) / length)) : 0
          best = triangle.uv[edge] * (1 - fraction) + triangle.uv[next] * fraction
          distance = squared
        }
      }
    }
    guard distance <= Float(maximumDistance * maximumDistance) else { return nil }
    return best.map { CGPoint(x: CGFloat($0.x), y: CGFloat($0.y)) }
  }

  func position(at uv: CGPoint) -> SCNVector3? {
    updatePose()
    let target = SIMD2<Float>(Float(uv.x), Float(uv.y))
    var distance = Float.infinity
    var best: SIMD3<Float>?
    func world(_ p: SIMD3<Float>) -> SCNVector3 { SCNVector3(p.x, p.y, p.z) }
    for triangle in triangles {
      let a = triangle.uv[0]
      let ab = triangle.uv[1] - a
      let ac = triangle.uv[2] - a
      let offset = target - a
      let determinant = ab.x * ac.y - ab.y * ac.x
      if abs(determinant) > 1e-10 {
        let u = (offset.x * ac.y - offset.y * ac.x) / determinant
        let v = (ab.x * offset.y - ab.y * offset.x) / determinant
        if u >= -1e-5, v >= -1e-5, u + v <= 1.00001 {
          return world(
            posed[triangle.positions.x] * (1 - u - v)
              + posed[triangle.positions.y] * u + posed[triangle.positions.z] * v)
        }
      }
      for edge in 0..<3 {
        let next = (edge + 1) % 3
        let a = triangle.uv[edge]
        let b = triangle.uv[next]
        let t = Self.segmentFraction(target, a, b)
        let squared = simd_length_squared(a + (b - a) * t - target)
        if squared < distance {
          distance = squared
          best = posed[triangle.positions[edge]] * (1 - t) + posed[triangle.positions[next]] * t
        }
      }
    }
    return best.map(world)
  }

  private static func segmentFraction(_ point: SIMD2<Float>, _ a: SIMD2<Float>, _ b: SIMD2<Float>) -> Float {
    let length = simd_length_squared(b - a)
    return length > 1e-12 ? min(1, max(0, simd_dot(point - a, b - a) / length)) : 0
  }

  private static func triangles(_ geometry: SCNGeometry) -> [Triangle]? {
    guard let positionSource = geometry.sources.firstIndex(where: { $0.semantic == .vertex }),
      let uvSource = geometry.sources.firstIndex(where: { $0.semantic == .texcoord }),
      let uvValues = DuoMesh.components(geometry.sources[uvSource]),
      geometry.sources[uvSource].componentsPerVector == 2
    else { return nil }
    let uv = stride(from: 0, to: uvValues.count, by: 2).map {
      SIMD2<Float>(Float(uvValues[$0]), Float(uvValues[$0 + 1]))
    }
    let channels =
      geometry.geometrySourceChannels?.map(\.intValue)
      ?? Array(repeating: 0, count: geometry.sources.count)
    guard channels.count == geometry.sources.count else { return nil }
    var result: [Triangle] = []
    for element in geometry.elements {
      guard element.primitiveType == .triangles || element.primitiveType == .polygon,
        element.indicesChannelCount > 0,
        channels.allSatisfy({ $0 >= 0 && $0 < element.indicesChannelCount }),
        [1, 2, 4].contains(element.bytesPerIndex)
      else { return nil }
      let indices: [Int] = element.data.withUnsafeBytes { bytes in
        stride(from: 0, to: bytes.count - element.bytesPerIndex + 1, by: element.bytesPerIndex).map { offset in
          switch element.bytesPerIndex {
          case 1: Int(bytes.loadUnaligned(fromByteOffset: offset, as: UInt8.self))
          case 2: Int(bytes.loadUnaligned(fromByteOffset: offset, as: UInt16.self))
          default: Int(bytes.loadUnaligned(fromByteOffset: offset, as: UInt32.self))
          }
        }
      }
      let header = element.primitiveType == .polygon ? element.primitiveCount : 0
      guard indices.count >= header else { return nil }
      let counts = header > 0 ? Array(indices.prefix(header)) : Array(repeating: 3, count: element.primitiveCount)
      let count = counts.reduce(0, +)
      guard counts.allSatisfy({ $0 >= 3 }),
        indices.count == header + count * element.indicesChannelCount
      else { return nil }
      func index(_ corner: Int, _ source: Int) -> Int {
        indices[
          header
            + (element.hasInterleavedIndicesChannels
              ? corner * element.indicesChannelCount + channels[source]
              : channels[source] * count + corner)]
      }
      var start = 0
      for corners in counts {
        for corner in 1..<(corners - 1) {
          let corners = [start, start + corner, start + corner + 1]
          let positions = corners.map { index($0, positionSource) }
          let texcoords = corners.map { index($0, uvSource) }
          guard positions.allSatisfy({ $0 < geometry.sources[positionSource].vectorCount }),
            texcoords.allSatisfy({ $0 < uv.count })
          else { return nil }
          result.append(Triangle(positions: SIMD3(positions), uv: texcoords.map { uv[$0] }))
        }
        start += corners
      }
    }
    return result.isEmpty ? nil : result
  }

}
