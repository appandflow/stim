import StimKit
import Testing

@Test(arguments: [nil, 0, 1, 3] as [Int?])
func tutorialPhoneActionUsesPairingAvailability(count: Int?) {
  let state = TutorialPhoneState(pairedPhoneCount: count)
  switch count {
  case nil:
    #expect(state == .serverOff)
    #expect(state.buttonTitle == "Turn on Serve to phones")
  case 0:
    #expect(state == .unpaired)
    #expect(state.buttonTitle == "Pair a phone")
  default:
    #expect(state == .paired)
    #expect(state.buttonTitle == "Done already")
  }
}

@Test func tutorialMachineWithoutConfigurationOffersSkipFirst() {
  let state = TutorialMachineState(configured: false, approved: false)
  #expect(state.skipIsPrimary)
  #expect(!state.showsPrompt)
  #expect(state.buttonTitle == "Add build machine")
}

@Test func tutorialMachineConfigurationDoesNotAuthorizeTheBuildPrompt() {
  let state = TutorialMachineState(configured: true, approved: false)
  #expect(!state.skipIsPrimary)
  #expect(!state.showsPrompt)
  #expect(state.buttonTitle == "Open Add build machine")
}

@Test func tutorialApprovedMachineUnlocksTheBuildPrompt() {
  let state = TutorialMachineState(configured: true, approved: true)
  #expect(state.showsPrompt)
  #expect(!state.skipIsPrimary)
}
