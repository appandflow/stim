import StimKit
import Testing

@Test(arguments: [nil, 0, 1, 3] as [Int?])
func tutorialPhoneActionUsesPairingAvailability(count: Int?) {
  let state = TutorialPhoneState(pairedPhoneCount: count)
  switch count {
  case nil:
    #expect(state == .serverOff)
  case 0:
    #expect(state == .unpaired)
  default:
    #expect(state == .paired)
  }
}

@Test func tutorialMachineWithoutConfigurationOffersSkipFirst() {
  let state = TutorialMachineState(configured: false, approved: false)
  #expect(state.skipIsPrimary)
  #expect(!state.showsPrompt)
}

@Test func tutorialMachineConfigurationDoesNotAuthorizeTheBuildPrompt() {
  let state = TutorialMachineState(configured: true, approved: false)
  #expect(!state.skipIsPrimary)
  #expect(!state.showsPrompt)
}

@Test func tutorialApprovedMachineUnlocksTheBuildPrompt() {
  let state = TutorialMachineState(configured: true, approved: true)
  #expect(state.showsPrompt)
  #expect(!state.skipIsPrimary)
}
