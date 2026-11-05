import Foundation
import Testing

@testable import StimKit

private func issue(_ code: String, _ severity: String, _ message: String = "simulator is booted with no Metro serving it")
  throws -> StatusIssue
{
  try JSONDecoder().decode(
    StatusIssue.self,
    from: Data(
      #"{"code":"\#(code)","severity":"\#(severity)","message":"\#(message)","remedy":"stim start","workspace":"/w"}"#.utf8))
}

@Test func tutorialFinishAndDeleteShowOnlyIssuesThatBlockStoppingOrRemoving() throws {
  let issues = [
    try issue("sim-without-metro", "info"), try issue("port-not-ours", "warning"),
    try issue("supervisor-unverified", "error"),
  ]
  #expect(TutorialIssues.shown(issues, step: "finish").map(\.code) == ["supervisor-unverified"])
  #expect(TutorialIssues.shown(issues, step: "delete").map(\.code) == ["supervisor-unverified"])
  #expect(TutorialIssues.shown(issues, step: "device").map(\.code) == ["port-not-ours", "supervisor-unverified"])
  #expect(TutorialIssues.shown(issues, step: "phone").isEmpty)
}

@Test func tutorialIssueMessagesReadAsSentences() {
  #expect(
    TutorialIssues.sentence("simulator is booted with no Metro serving it") == "Simulator is booted with no Metro serving it.")
  #expect(TutorialIssues.sentence("Already done.") == "Already done.")
}
