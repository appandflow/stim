import StimKit
import Testing

struct MachineChoicesTests {
  @Test func yourMachinesHoldThisMachineAndRemoteMachinesWhileViewingHoldsPairedOnes() {
    let groups = MachineChoices.groups(remote: ["mini:7443", "studio"], paired: ["floco-key"])

    #expect(groups.map(\.title) == ["Your machines", "Viewing"])
    #expect(groups[0].choices == [.thisMachine, .remote("mini:7443"), .remote("studio")])
    #expect(groups[1].choices == [.paired("floco-key")])
  }

  @Test func aPageWithNoPairedMachineHasOneUnlabelledGroup() {
    let groups = MachineChoices.groups(remote: ["mini:7443"], paired: [])

    #expect(groups.map(\.title) == [nil])
    #expect(groups[0].choices == [.thisMachine, .remote("mini:7443")])
    #expect(MachineChoices.groups(remote: [], paired: []).flatMap(\.choices) == [.thisMachine])
  }

  @Test func aPairedMachinesSidebarSectionSaysItIsBeingViewed() {
    #expect(PairedServerWording.sectionTitle(name: "floco") == "floco (viewing)")
    #expect(PairedServerWording.sectionTitle(name: "") == "Machine (viewing)")
  }
}
