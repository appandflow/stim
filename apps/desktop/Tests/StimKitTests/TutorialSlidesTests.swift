import Testing

@testable import StimKit

private let steps = ["begin", "build", "parallel", "device", "finish", "delete"]

@Test func tutorialSlidesViewingAnotherStepNeverMovesProgress() {
  let slides = TutorialSlides(steps: steps, currentStep: "parallel", finished: false)
  #expect(slides.shown(nil) == "parallel")
  #expect(slides.shown("begin") == "begin")
  #expect(slides.shown(TutorialSlides.completion) == "parallel")
  #expect(slides.current == "parallel")
  #expect(slides.isAhead("device"))
  #expect(!slides.isAhead("build"))
  #expect(slides.previous("begin") == nil)
  #expect(slides.next("delete") == nil)
}

@Test func tutorialSlidesEndOnTheCompletionCardOnceFinished() {
  let deleting = TutorialSlides(steps: steps, currentStep: "delete", finished: true)
  #expect(deleting.next("delete") == TutorialSlides.completion)
  #expect(!deleting.isAhead(TutorialSlides.completion))
  let done = TutorialSlides(steps: steps, currentStep: nil, finished: true)
  #expect(done.shown(nil) == TutorialSlides.completion)
  #expect(done.previous(TutorialSlides.completion) == "delete")
}

@Test func tutorialSlidesFollowProgressOnlyFromTheStepThatCompleted() {
  let slides = TutorialSlides(steps: steps, currentStep: "device", finished: false)
  #expect(slides.viewed(nil, afterProgressFrom: "parallel") == nil)
  #expect(slides.viewed("parallel", afterProgressFrom: "parallel") == nil)
  #expect(slides.viewed("build", afterProgressFrom: "parallel") == "build")
}
