import Testing

@testable import StimKit

@Test func tutorialCommandsResolveWorkspaceAndShellQuotedPaths() {
  let result = tutorialCommands(
    [#"cd "{base}""#, #"cd "{tour}""#, #"export AGENT_DEVICE_STATE_DIR="{stateDir}""#, #"stim ios --build-machine "{machine}""#],
    tourPath: "/tmp/tour with spaces", repository: "/tmp/base", stateDir: "/tmp/state\"$`\\", machine: "Mac Studio")
  #expect(
    result
      == "cd \"/tmp/base\"\ncd \"/tmp/tour with spaces\"\nexport AGENT_DEVICE_STATE_DIR=\"/tmp/state\\\"\\$\\`\\\\\"\nstim ios --build-machine \"Mac Studio\""
  )
}

@Test func tutorialCommandsExpandDefaultHomeAndPreserveHeredoc() {
  let result = tutorialCommands(
    [#"base="{base}""#, #"cd "{tour}""#, "cat > App.js <<'EOF'", "console.log(`${TAG} title color=${TITLE_COLOR}`);", "EOF"],
    tourPath: nil, repository: nil, stateDir: nil, machine: nil)
  #expect(result.hasPrefix("base=\"$HOME/stim-tutorial\"\ncd \"$HOME/stim-tutorial-tour\""))
  #expect(result.hasSuffix("cat > App.js <<'EOF'\nconsole.log(`${TAG} title color=${TITLE_COLOR}`);\nEOF"))
}

@Test func tutorialCommandsDoNotSubstituteInsideInsertedValues() {
  let result = tutorialCommands(
    [#"cd "{base}""#, #"cd "{tour}""#], tourPath: "/tmp/tour", repository: "/tmp/{tour}", stateDir: nil, machine: nil)
  #expect(result == "cd \"/tmp/{tour}\"\ncd \"/tmp/tour\"")
}
