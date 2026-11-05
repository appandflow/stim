// Copyright (c) 2026 Siniulator contributors. Adapted under the MIT license in Support/Siniulator-LICENSE.txt.
import SceneKit
import simd

@MainActor final class DuoPoseClip {
  static let openTime = 260.0 / 24
  static let closedTime = 380.0 / 24
  private enum Property { case position, orientation, scale }
  private struct Track {
    let node: SCNNode
    let property: Property
    let times: [Double]
    let values: [SIMD4<Float>]
  }
  private let tracks: [Track]
  private let supports: [(node: SCNNode, points: [SIMD4<Float>])]

  init?(root: SCNNode) {
    var nodes = [root]
    root.enumerateChildNodes { node, _ in nodes.append(node) }
    let geometryNodes = nodes.filter { $0.geometry != nil }
    let meshes = geometryNodes.compactMap(DuoMesh.init)
    guard !meshes.isEmpty, meshes.count == geometryNodes.count else { return nil }
    var tracks: [Track] = []
    for owner in nodes {
      for key in owner.animationKeys {
        guard let player = owner.animationPlayer(forKey: key),
          let group = CAAnimation(scnAnimation: player.animation) as? CAAnimationGroup
        else { continue }
        for case let animation as CAKeyframeAnimation in group.animations ?? [] {
          guard let path = animation.keyPath,
            let separator = path.lastIndex(of: "."),
            let values = animation.values as? [NSValue], !values.isEmpty
          else { continue }
          let name = String(path[..<separator]).split(separator: "/").last.map(String.init)
          guard let node = nodes.first(where: { $0.name == name }) else { continue }
          let property: Property
          switch path[path.index(after: separator)...] {
          case "position": property = .position
          case "orientation": property = .orientation
          case "scale": property = .scale
          default: continue
          }
          let keyTimes: [Double]
          if let authoredTimes = animation.keyTimes {
            keyTimes = authoredTimes.map { $0.doubleValue }
          } else {
            let intervals = Double(max(1, values.count - 1))
            keyTimes = values.indices.map { Double($0) / intervals }
          }
          let times: [Double] = keyTimes.map { animation.beginTime + $0 * animation.duration }
          guard times.count == values.count else { continue }
          tracks.append(
            Track(
              node: node, property: property, times: times,
              values: values.map { value in
                if property == .orientation {
                  let q = value.scnVector4Value
                  return SIMD4(Float(q.x), Float(q.y), Float(q.z), Float(q.w))
                }
                let v = value.scnVector3Value
                return SIMD4(Float(v.x), Float(v.y), Float(v.z), 0)
              }))
        }
      }
      owner.removeAllAnimations()
    }
    guard !tracks.isEmpty else { return nil }
    self.tracks = tracks

    supports = meshes.flatMap { mesh -> [(node: SCNNode, points: [SIMD4<Float>])] in
      let box = mesh.node.boundingBox
      let minimum = SIMD3<Float>(Float(box.min.x), Float(box.min.y), Float(box.min.z))
      let maximum = SIMD3<Float>(Float(box.max.x), Float(box.max.y), Float(box.max.z))
      guard !mesh.bones.isEmpty else { return [(mesh.node, Self.corners(minimum, maximum))] }
      var boxes = Array(
        repeating: (SIMD3<Float>(repeating: .infinity), SIMD3<Float>(repeating: -.infinity)), count: mesh.bones.count)
      for vertex in mesh.vertices.indices {
        let v = mesh.vertices[vertex]
        let point = SIMD3(v.x, v.y, v.z)
        for influence in mesh.influences[vertex] {
          boxes[influence.index].0 = simd_min(boxes[influence.index].0, point)
          boxes[influence.index].1 = simd_max(boxes[influence.index].1, point)
        }
      }
      return mesh.bones.enumerated().map { index, bone in
        let box = boxes[index]
        return (bone, box.0.x.isFinite ? Self.corners(box.0, box.1).map { mesh.binds[index] * $0 } : [])
      }
    }
    Self.apply(tracks, time: Self.openTime)
  }

  func bounds() -> (center: SIMD3<Float>, points: [SIMD3<Float>]) {
    let points = supports.flatMap { support in
      support.points.map { point in
        let transformed = support.node.simdWorldTransform * point
        return SIMD3(transformed.x, transformed.y, transformed.z)
      }
    }
    let minimum = points.reduce(SIMD3<Float>(repeating: .infinity)) { simd_min($0, $1) }
    let maximum = points.reduce(SIMD3<Float>(repeating: -.infinity)) { simd_max($0, $1) }
    return ((minimum + maximum) / 2, points)
  }

  func apply(angle: CGFloat) {
    let t = Double(min(180, max(0, angle))) / 180
    Self.apply(tracks, time: Self.closedTime + (Self.openTime - Self.closedTime) * t)
  }

  private static func corners(_ minimum: SIMD3<Float>, _ maximum: SIMD3<Float>) -> [SIMD4<Float>] {
    [minimum.x, maximum.x].flatMap { x in
      [minimum.y, maximum.y].flatMap { y in
        [minimum.z, maximum.z].map { z in SIMD4(x, y, z, 1) }
      }
    }
  }

  private static func apply(_ tracks: [Track], time: Double) {
    for track in tracks {
      var lower = 0
      var upper = track.times.count - 1
      while lower + 1 < upper {
        let middle = (lower + upper) / 2
        if track.times[middle] <= time { lower = middle } else { upper = middle }
      }
      let span = track.times[upper] - track.times[lower]
      let fraction = span > 0 ? Float(min(1, max(0, (time - track.times[lower]) / span))) : 0
      let a = track.values[lower]
      let b = track.values[upper]
      if track.property == .orientation {
        track.node.simdOrientation = simd_slerp(simd_quatf(vector: a), simd_quatf(vector: b), fraction)
      } else {
        let value = simd_mix(a, b, SIMD4(repeating: fraction))
        let vector = SIMD3(value.x, value.y, value.z)
        if track.property == .position { track.node.simdPosition = vector } else { track.node.simdScale = vector }
      }
    }
  }
}
