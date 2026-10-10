import Testing

@testable import StimKit

@Test func tutorialAskUsesPlainPathsAndFillsEachPlaceholderOnce() {
  let result = tutorialAsk(
    "In {tour}, keep {base}.", tourPath: "/tmp/my tour $1", repository: "/tmp/{tour}")
  #expect(result == "In /tmp/my tour $1, keep /tmp/{tour}.")
}
