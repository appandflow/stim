import Foundation

/// Free disk under the `budget.minFreeDiskGb` Stim enforces, and what `stim gc --delete` would do about it.
public struct PressurePlan: Hashable, Sendable {
  public var freeBytes: Int64
  /// The larger of `budget.minFreeDiskGb` and `budget.hardFloorDiskGb`, in the CLI's binary gigabytes.
  public var minimumFreeGb: Double
  /// Below `budget.hardFloorDiskGb`, where `start`, `ios` and `android` refuse with STIM_LOW_DISK.
  public var belowHardFloor: Bool
  public var clearsWorkspaces: Int
  public var removesWorktrees: Int
  public var deletesDevices: Int
  public var reclaimableBytes: Int64

  public var isEmpty: Bool { clearsWorkspaces + removesWorktrees + deletesDevices == 0 && reclaimableBytes == 0 }

  public static let arguments = ["gc", "--delete", "--json"]

  /// The plan when free space is under the budget, else nil. A budget of 0 turns the check off, as in the CLI.
  public static func make(freeBytes: Int64, minimumFreeGb: Double, hardFloorGb: Double, report: GcReport?)
    -> PressurePlan?
  {
    let minimum = max(minimumFreeGb, hardFloorGb)
    guard minimum > 0, Double(freeBytes) < minimum * gib else { return nil }
    return PressurePlan(
      freeBytes: freeBytes, minimumFreeGb: minimum, belowHardFloor: Double(freeBytes) < hardFloorGb * gib,
      clearsWorkspaces: report?.clearableOutputs.count ?? 0, removesWorktrees: report?.mergedWorktrees.count ?? 0,
      deletesDevices: report?.deletableDevices.count ?? 0, reclaimableBytes: report?.reclaimable.bytes ?? 0)
  }

  static let gib = 1_073_741_824.0

  public var headline: String {
    let free = (Double(freeBytes) / Self.gib * 10).rounded() / 10
    let budget = minimumFreeGb.rounded() == minimumFreeGb ? String(Int(minimumFreeGb)) : String(minimumFreeGb)
    return "Disk \(free) GB free, under the \(budget) GB Stim budget"
  }

  /// What `stim gc --delete` would do, as one sentence.
  public var proposal: String {
    guard !isEmpty else {
      return "Stim has nothing it can reclaim safely. Open Storage to see what uses the space."
    }
    var parts: [String] = []
    if clearsWorkspaces > 0 {
      parts.append("clear the build outputs of \(Self.count(clearsWorkspaces, "idle workspace"))")
    }
    if removesWorktrees > 0 { parts.append("remove \(Self.count(removesWorktrees, "merged worktree"))") }
    if deletesDevices > 0 { parts.append("delete \(Self.count(deletesDevices, "unused owned device"))") }
    if parts.isEmpty { parts.append("empty what stim gc reports") }
    let list = parts.count == 1 ? parts[0] : parts.dropLast().joined(separator: ", ") + " and " + parts.last!
    let freed = reclaimableBytes > 0 ? " to free about \(Format.fileSize(reclaimableBytes))" : ""
    return list.prefix(1).uppercased() + list.dropFirst() + freed + "."
  }

  static func count(_ n: Int, _ noun: String) -> String { n == 1 ? "1 \(noun)" : "\(n) \(noun)s" }

}
