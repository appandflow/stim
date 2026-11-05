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
