import Testing

@testable import StimKit

@Suite struct ResourceSummaryTests {
  @Test func dividersAppearOnlyBetweenVisibleItems() {
    for mask in 0..<8 {
      let cpu = mask & 1 != 0
      let memory = mask & 2 != 0
      let disk = mask & 4 != 0
      let entries = ResourceSummary.entries(cpu: cpu, memory: memory, disk: disk)
      let items = [cpu, memory, disk].filter { $0 }.count
      #expect(entries.filter { $0 != .divider }.count == items)
      #expect(entries.filter { $0 == .divider }.count == max(0, items - 1))
      #expect(entries.first != .divider && entries.last != .divider)
    }
  }

  @Test func keepsCpuMemoryDiskOrder() {
    #expect(
      ResourceSummary.entries(cpu: false, memory: true, disk: true) == [.item(.memory), .divider, .item(.disk)])
    #expect(
      ResourceSummary.entries(cpu: true, memory: true, disk: true)
        == [.item(.cpu), .divider, .item(.memory), .divider, .item(.disk)])
  }
}
