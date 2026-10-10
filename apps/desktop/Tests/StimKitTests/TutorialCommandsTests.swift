import Testing

@testable import StimKit

@Test func tutorialCommandsResolveWorkspaceAndShellQuotedPaths() {
  let result = tutorialCommands(
    [#"cd "{base}""#, #"cd "{tour}""#, #"export AGENT_DEVICE_STATE_DIR="{stateDir}""#],
    tourPath: "/tmp/tour with spaces", repository: "/tmp/base", stateDir: "/tmp/state\"$`\\")
  #expect(
    result
      == "cd \"/tmp/base\"\ncd \"/tmp/tour with spaces\"\nexport AGENT_DEVICE_STATE_DIR=\"/tmp/state\\\"\\$\\`\\\\\""
  )
}

@Test func tutorialCommandsExpandDefaultHomeAndPreserveHeredoc() {
  let result = tutorialCommands(
    [#"base="{base}""#, #"cd "{tour}""#, "cat > App.js <<'EOF'", "console.log(`${TAG} title color=${TITLE_COLOR}`);", "EOF"],
    tourPath: nil, repository: nil, stateDir: nil)
  #expect(result.hasPrefix("base=\"$HOME/stim-tutorial\"\ncd \"<first worktree>\""))
  #expect(result.hasSuffix("cat > App.js <<'EOF'\nconsole.log(`${TAG} title color=${TITLE_COLOR}`);\nEOF"))
}

@Test func tutorialCommandsDoNotSubstituteInsideInsertedValues() {
  let result = tutorialCommands(
    [#"cd "{base}""#, #"cd "{tour}""#], tourPath: "/tmp/tour", repository: "/tmp/{tour}", stateDir: nil)
  #expect(result == "cd \"/tmp/{tour}\"\ncd \"/tmp/tour\"")
}

@Test func tutorialAskUsesPlainPathsAndFillsEachPlaceholderOnce() {
  let result = tutorialAsk(
    "In {tour}, keep {base}.", tourPath: "/tmp/my tour $1", repository: "/tmp/{tour}")
  #expect(result == "In /tmp/my tour $1, keep /tmp/{tour}.")
}
