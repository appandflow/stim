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

  @Test func namesTheLastStderrLinesOfAFailedCommandPastAFullPipeBuffer() throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    let stim = dir.appendingPathComponent("stim").path
    let script = """
      #!/bin/sh
      head -c 200000 /dev/zero | tr '\\0' 'x' >&2
      printf '\\nfirst\\n\\nsecond\\nerror: disk full\\n' >&2
      exit 2
      """
    FileManager.default.createFile(atPath: stim, contents: Data(script.utf8), attributes: [.posixPermissions: 0o755])

    let cli = StimCLI(environment: ["PATH": "/usr/bin:/bin"], override: stim)

    let error = #expect(throws: StimCLI.Failure.self) { try cli.gcReport() }
    #expect(error?.localizedDescription == "stim exited with status 2: first\nsecond\nerror: disk full")
  }
}
