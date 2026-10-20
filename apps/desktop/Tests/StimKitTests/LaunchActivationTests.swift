import Testing

@testable import StimKit

@Suite struct LaunchActivationTests {
  @Test func backgroundReopenOfAnInactiveAppDoesNotActivate() {
    #expect(!LaunchActivation.reopenActivates(backgroundLaunch: true, appIsActive: false))
  }

  @Test func dockClickReopenStillActivates() {
    #expect(LaunchActivation.reopenActivates(backgroundLaunch: true, appIsActive: true))
  }

  @Test func ordinaryLaunchesKeepActivatingOnReopen() {
    #expect(LaunchActivation.reopenActivates(backgroundLaunch: false, appIsActive: false))
  }

  @Test func onlyTheStimMacosVariableMarksABackgroundLaunch() {
    #expect(LaunchActivation.isBackgroundLaunch(["STIM_BACKGROUND_LAUNCH": "1"]))
    #expect(!LaunchActivation.isBackgroundLaunch(["STIM_BACKGROUND_LAUNCH": "0"]))
    #expect(!LaunchActivation.isBackgroundLaunch([:]))
  }
}
