import Foundation
import StimKit
import Testing

struct CLIFailureTests {
  private struct Boom: LocalizedError {
    var errorDescription: String? { "boom" }
  }

  @Test func keepsTheLastValueWhenARunFailsUntilOneSucceeds() {
    var fetched = Fetched<Int>()
    fetched.record(.failure(Boom()))
    #expect(fetched.value == nil)
    #expect(fetched.error == "boom")
    fetched.record(.success(1))
    fetched.record(.failure(Boom()))
    #expect(fetched.value == 1)
    #expect(fetched.error == "boom")
    fetched.record(.success(2))
    #expect(fetched.value == 2)
    #expect(fetched.error == nil)
  }

  @Test func namesTheStderrOfAFailedStimServerCommand() async throws {
    let dir = try scratchDirectory()
    defer { try? FileManager.default.removeItem(at: dir) }
    let server = try fake(
      in: dir, name: "stim-server",
      """
      #!/bin/sh
      printf '\nNo device named phone-1.\n\n' >&2
      exit 3
      """)

    let environment = StimServerCLI(environment: ["PATH": "/usr/bin:/bin"], override: server)

    let error = await #expect(throws: StimServerCLI.Failure.self) { try await environment.revoke("phone-1") }
    #expect(error?.localizedDescription == "No device named phone-1.")
  }

  private func scratchDirectory() throws -> URL {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
  }

  private func fake(in dir: URL, name: String, _ script: String) throws -> String {
    let path = dir.appendingPathComponent(name).path
    FileManager.default.createFile(atPath: path, contents: Data(script.utf8), attributes: [.posixPermissions: 0o755])
    return path
  }
}

@Test func stimHomeFollowsTheEnvironment() {
  #expect(StimHome.path(environment: ["STIM_HOME": "/tmp/other-home"]) == "/tmp/other-home")
  #expect(StimHome.path(environment: ["STIM_HOME": ""]) == "\(NSHomeDirectory())/.stim")
  #expect(StimHome.path(environment: [:]) == "\(NSHomeDirectory())/.stim")
}
