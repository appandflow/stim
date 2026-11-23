import Testing

@testable import StimKit

@Test func placementBadgesGroupByMachineAndOwnershipInOrder() throws {
  for owned in [true, false] {
    let badge = PlacementBadge(machine: "mini", reason: "capacity", owned: owned)
    let single = try #require(groupedPlacementBadges([badge]).first)
    #expect(single.count == 1)
    #expect(single.text == (owned ? "on mini" : "theirs, on mini"))
    #expect(single.accessibilityLabel == (owned ? "Yours, running on mini" : "Theirs, running on mini"))

    let three = groupedPlacementBadges([badge, badge, badge])
    #expect(three.count == 1)
    let grouped = try #require(three.first)
    #expect(grouped.count == 3)
    #expect(grouped.text == (owned ? "3 on mini" : "theirs, 3 on mini"))
    #expect(grouped.accessibilityLabel == (owned ? "Yours, 3 running on mini" : "Theirs, 3 running on mini"))
    #expect(grouped.reason == "capacity")

    let other = PlacementBadge(machine: "studio", reason: nil, owned: owned)
    let machines = groupedPlacementBadges([badge, other, badge])
    #expect(machines.map(\.machine) == ["mini", "studio"])
    #expect(machines.map(\.count) == [2, 1])
    #expect(machines[1].reason == nil)

    let differentReason = PlacementBadge(machine: "mini", reason: nil, owned: owned)
    #expect(groupedPlacementBadges([badge, differentReason, badge]).first?.reason == nil)
    let differentOwner = PlacementBadge(machine: "mini", reason: nil, owned: !owned)
    let owners = groupedPlacementBadges([badge, differentOwner])
    #expect(owners.count == 2)
    #expect(Set(owners.map(\.id)).count == 2)
  }
}
