import Foundation
import Testing

@testable import StimKit

@Suite struct BuildMachinesTests {
  @Test func listsOnlyOtherMacsThatAreOnline() throws {
    let status = #"""
      {"BackendState":"Running","Self":{"ID":"nSelf","OS":"macOS","DNSName":"laptop.tail1.ts.net.","Online":true},
       "Peer":{
        "a":{"ID":"nMini","HostName":"Mac mini","DNSName":"Mini.tail1.ts.net.","OS":"macOS","Online":true},
        "b":{"ID":"nOff","HostName":"old","DNSName":"old.tail1.ts.net.","OS":"macOS","Online":false},
        "c":{"ID":"nPhone","HostName":"localhost","DNSName":"iphone.tail1.ts.net.","OS":"iOS","Online":true},
        "d":{"ID":"nFunnel","HostName":"funnel-ingress-node","DNSName":"","Online":true}}}
      """#
    let macs = try #require(Tailnet.macs(statusJSON: Data(status.utf8)))
    #expect(macs == [TailnetMac(id: "nMini", hostName: "Mac mini", dnsName: "mini.tail1.ts.net")])
    #expect(macs.first?.machine == "mini")
    #expect(Tailnet.macs(statusJSON: Data(#"{"BackendState":"Stopped"}"#.utf8)) == nil)
  }

  @Test func readsSelfAndOfflinePeersWithoutChangingOnlineDiscovery() throws {
    let data = Data(
      #"""
      {"BackendState":"Running","Self":{"ID":"nSelf","HostName":"Laptop","DNSName":"Laptop.tail.test."},
      "Peer":{"a":{"ID":"nOff","OS":"macOS","HostName":"Air","DNSName":"Air.tail.test.","Online":false},
      "b":{"ID":"nOn","OS":"macOS","HostName":"Mini","DNSName":"Mini.tail.test.","Online":true},
      "c":{"ID":"nPhone","OS":"iOS","DNSName":"phone.tail.test.","Online":true}}}
      """#.utf8)
    #expect(Tailnet.selfNode(statusJSON: data) == TailnetMac(id: "nSelf", hostName: "Laptop", dnsName: "laptop.tail.test"))
    let peers = Tailnet.peers(statusJSON: data)
    #expect(peers.map(\.online) == [false, true])
    #expect(peers.map(\.mac.machine) == ["air", "mini"])
    #expect(Tailnet.reachability(statusJSON: nil, peer: nil) == .tailscaleMissing)
    #expect(Tailnet.reachability(statusJSON: Data(#"{"BackendState":"Stopped"}"#.utf8), peer: peers[1]) == .tailscaleStopped)
    #expect(Tailnet.reachability(statusJSON: data, peer: peers[0]) == .peerOffline)
    #expect(Tailnet.reachability(statusJSON: data, peer: peers[1]) == .ready)
    #expect(Tailnet.macs(statusJSON: data)?.map(\.id) == ["nOn"])
    #expect(Tailnet.buildPeers(statusJSON: data)?.map(\.id) == ["nOn"])
  }

  @Test func wizardPeersAddLinuxAndWindowsButNotOtherSystemsWhileHostingOffersStayOnMacs() throws {
    let data = Data(
      #"""
      {"BackendState":"Running","Self":{"ID":"nSelf","HostName":"Laptop","DNSName":"laptop.tail.test."},
      "Peer":{"a":{"ID":"nMini","OS":"macOS","HostName":"Mini","DNSName":"mini.tail.test.","Online":true},
      "b":{"ID":"nBox","OS":"linux","HostName":"build-box","DNSName":"build-box.tail.test.","Online":true},
      "c":{"ID":"nWin","OS":"windows","HostName":"pc","DNSName":"pc.tail.test.","Online":true},
      "d":{"ID":"nPhone","OS":"android","HostName":"phone","DNSName":"phone.tail.test.","Online":true}}}
      """#.utf8)
    let peers = Tailnet.peers(statusJSON: data)
    #expect(peers.map(\.mac.machine) == ["build-box", "mini", "pc"])
    #expect(peers.map(\.mac.os) == [.linux, .macOS, .windows])
    #expect(peers.map(\.mac.buildsAndroidOnly) == [true, false, true])
    #expect(Tailnet.macs(statusJSON: data)?.map(\.id) == ["nMini"])
    #expect(Tailnet.buildPeers(statusJSON: data)?.map(\.id) == ["nBox", "nMini", "nWin"])
    #expect(Tailnet.buildPeers(statusJSON: Data(#"{"BackendState":"Stopped"}"#.utf8)) == nil)
  }

  @Test func readsHostingPermissionsFromApprovedDoctorEntries() throws {
    let report = try JSONDecoder().decode(
      DoctorReport.self,
      from: Data(
        #"""
        {"project":"/p","findings":[],"remoteMachines":[{"machine":"mini","state":"approved","host":{"name":"Mini","screenRecording":true,"accessibility":false}}],
        "deviceHosts":[{"machine":"mini","state":"approved","deviceId":"host-id","host":{"name":"Mini","screenRecording":true,"accessibility":false}},
        {"machine":"air","state":"pending"}]}
        """#.utf8))
    #expect(report.deviceHosts?.first?.deviceId == "host-id")
    #expect(report.deviceHosts?.first?.host?.screenRecording == true)
    #expect(report.deviceHosts?.first?.host?.accessibility == false)
    #expect(report.deviceHosts?.last?.host == nil)
    #expect(report.remoteMachines?.first?.host == report.deviceHosts?.first?.host)
    #expect(try JSONDecoder().decode(DoctorReport.self, from: Data(#"{"project":"/p","findings":[]}"#.utf8)).deviceHosts == nil)
  }

  @Test func readsPlacementsFromStatsAndSplitsThemByMachine() throws {
    let stats = try JSONDecoder().decode(
      MachineStats.self,
      from: Data(
        #"""
        {"version":1,"project":null,"machine":{"ios":null,"android":null},"offload":{
          "today":{"here":1,"offloaded":1,"fellBack":1},
          "machines":{"mini":{"today":{"offloaded":1,"offloadedMs":200000,"savedMs":90000,"fallbacks":1},
                              "total":{"offloaded":4,"offloadedMs":800000,"savedMs":-5000,"fallbacks":2}}},
          "placements":[
            {"at":"2026-09-30T12:03:00.000Z","project":"/r/app","platform":"ios","decision":"fell-back","machine":"mini","reason":"mini: busy"},
            {"at":"2026-09-30T12:02:00.000Z","project":"/r/app","platform":"ios","decision":"offloaded","machine":"mini","reason":"this Mac is busy","buildMs":200000,"localEstimateMs":290000},
            {"at":"2026-09-30T12:01:00.000Z","project":"/r/app","platform":"android","decision":"here","reason":"load 0.6/core here","failed":true},
            {"at":"2026-09-30T12:00:00.000Z","project":"/r/app","platform":"ios","decision":"teleported","reason":"?"}]},
          "capacityRefusals":[
            {"at":"2026-09-30T12:04:00.000Z","kind":"device","platform":"android","max":3,"workspace":"fixture"},
            {"at":"2026-09-30T12:03:00.000Z","kind":"unknown","platform":"ios","max":2,"workspace":"older"}],
          "capacityWaits":[
            {"at":"2026-09-30T12:05:00.000Z","kind":"device-wait","platform":"ios","max":1,"workspace":"queued","ms":60000},
            {"at":"2026-09-30T12:04:00.000Z","kind":"unknown"}]}
        """#.utf8))
    let refusal = try #require(stats.capacityRefusals?.first)
    #expect(refusal.at == "2026-09-30T12:04:00.000Z")
    #expect(refusal.kind == "device")
    #expect(refusal.platform == "android")
    #expect(refusal.max == 3)
    #expect(refusal.workspace == "fixture")
    #expect(stats.capacityRefusals?.last?.kind == "unknown")
    let wait = try #require(stats.capacityWaits?.first)
    #expect(wait.at == "2026-09-30T12:05:00.000Z")
    #expect(wait.kind == "device-wait")
    #expect(wait.platform == "ios")
    #expect(wait.max == 1)
    #expect(wait.workspace == "queued")
    #expect(wait.ms == 60_000)
    let unknownWait = try #require(stats.capacityWaits?.last)
    #expect(unknownWait.kind == "unknown")
    #expect(unknownWait.platform == nil && unknownWait.max == nil && unknownWait.workspace == nil && unknownWait.ms == nil)
    let offload = try #require(stats.offload)
    #expect(offload.machines["mini"]?.total.savedMs == -5000)
    #expect(offload.placements(for: "mini").map(\.title) == ["Built here after mini", "Built on mini"])
    #expect(offload.placements(for: "mini").map(\.shortReason) == ["busy", "this Mac is busy"])
    #expect(offload.here.map(\.failed) == [true])
    #expect(offload.placements.last?.decision == .unknown)
    let fellBack = try JSONDecoder().decode(
      BuildPlacements.Placement.self,
      from: Data(#"{"at":"x","project":"/p","platform":"ios","decision":"fell-back","reason":"git"}"#.utf8))
    #expect(fellBack.title == "Built here after offloading")
    let ported = try JSONDecoder().decode(
      BuildPlacements.Placement.self,
      from: Data(#"{"at":"x","project":"/p","platform":"ios","decision":"offloaded","machine":"mini:7444","reason":"r"}"#.utf8))
    #expect(ported.title == "Built on mini")
    let older = try JSONDecoder().decode(MachineStats.self, from: Data(#"{"version":1}"#.utf8))
    #expect(older.offload == nil)
    #expect(older.capacityRefusals == nil)
    #expect(older.capacityWaits == nil)
  }

  @Test func describesOnlyTheCapacityAMachineReported() throws {
    let full = try JSONDecoder().decode(
      BuildMachineStatus.Capacity.self,
      from: Data(#"{"loadPerCore":0.3,"maxLoadPerCore":2,"cpus":10,"running":0,"max":1,"diskFreeBytes":812e9}"#.utf8))
    #expect(full.line == "load 0.3/core of 2 \u{00B7} 10 cores \u{00B7} 0 of 1 offloaded builds \u{00B7} 812 GB free")
    let old = try JSONDecoder().decode(BuildMachineStatus.Capacity.self, from: Data(#"{"loadPerCore":1.5}"#.utf8))
    #expect(old.line == "load 1.5/core")
  }

  @Test func namesWhatOnlyTheCardsIdentityLineShows() throws {
    let full = try JSONDecoder().decode(
      BuildMachineStatus.self,
      from: Data(
        #"{"machine":"mini","state":"approved","dnsName":"mini.tail1.ts.net","capacity":{"cpus":10,"running":0,"max":1}}"#.utf8))
    #expect(full.identityLine == "mini.tail1.ts.net \u{00B7} 10 cores \u{00B7} 0 of 1 offloaded builds")
    #expect(BuildMachineStatus(machine: "mini", state: .notAsked).identityLine == nil)
  }

  @Test func readsEachMachineStateFromDoctorAndToleratesNewOnes() throws {
    let report = try JSONDecoder().decode(
      DoctorReport.self,
      from: Data(
        #"""
        {"project":"/p","findings":[],"remoteMachines":[
          {"machine":"mini","state":"pending","dnsName":"mini.tail1.ts.net","requestedAt":"2026-09-28T12:00:00.000Z","expiresAt":"2026-09-28T21:05:00.000Z"},
          {"machine":"old:7444","state":"key-changed"},{"machine":"x","state":"from-the-future"},
          {"machine":"late","state":"lapsed","deviceId":"cd34"}]}
        """#.utf8))
    let machines = try #require(report.remoteMachines)
    #expect(machines.map(\.state) == [.pending, .keyChanged, .unknown, .lapsed])
    let utc = TimeZone(identifier: "UTC")!
    let british = Locale(identifier: "en_GB")
    #expect(machines[0].lapseLine(timeZone: utc, locale: british) == "Waiting for approval until 21:05.")
    #expect(machines[0].lapseLine(timeZone: TimeZone(identifier: "Asia/Tokyo")!, locale: british).contains("06:05"))
    #expect(BuildMachineStatus(machine: "m", state: .pending).lapseLine() == BuildMachineStatus.requestLapse)
    #expect(machines[3].state.title == "Request lapsed")
    #expect(machines[3].state.canAsk(requested: true))
    #expect(
      try JSONDecoder().decode(DoctorReport.self, from: Data(#"{"project":"/p","findings":[]}"#.utf8))
        .remoteMachines == nil)
  }

  @Test func readsReadinessAsReadyOrTheFirstReasonWithItsRemedy() throws {
    let url = try #require(Bundle.module.url(forResource: "doctor", withExtension: "json", subdirectory: "Fixtures"))
    let machines = try #require(try JSONDecoder().decode(DoctorReport.self, from: Data(contentsOf: url)).remoteMachines)
    #expect(
      machines.map(\.readiness.line) == [
        "Ready", "Busy (load 8.2/core)", "Stim build differs \u{2014} update the remote machine",
      ])
    #expect(machines.map(\.readiness.tone) == [.success, .warning, .error])
    #expect(machines[2].readiness.reasons == "Stim build 6bbe9103995f7eb6 there, e7749c9011f4d423 here")
    #expect(
      machines.map(\.detail) == [
        "Builds can run there.", "Builds stay on this Mac for now.", "Update the remote machine.",
      ])
    let older = try JSONDecoder().decode(
      BuildMachineStatus.self,
      from: Data(#"{"machine":"mini","state":"approved","offloadable":false,"reasons":["CPU x86_64 there, arm64 here"]}"#.utf8))
    #expect(older.readiness.line == "CPU x86_64 there, arm64 here")
    #expect(BuildMachineStatus(machine: "mini", state: .pending).readiness.line == "Waiting for approval")
  }

  @Test func namesTheLayerThatStoppedAMachineInsteadOfTheGenericLine() throws {
    func status(_ json: String) throws -> BuildMachineStatus {
      try JSONDecoder().decode(BuildMachineStatus.self, from: Data(json.utf8))
    }
    let notReady = try status(
      #"""
      {"machine":"mini","state":"unreachable","diagnosis":{"layer":"server","code":"server-not-ready","title":"Server not ready","message":"stim-server on mini is running but is not serving clients (HTTP 503).","remedy":"Check the disk that holds the Stim home on mini."}}
      """#)
    #expect(notReady.listStatus == MachineListStatus(title: "Server not ready", tone: .warning))
    #expect(notReady.readiness.title == "Server not ready")
    #expect(notReady.diagnosis?.code == "server-not-ready")
    #expect(notReady.rowDetail.hasPrefix("stim-server on mini is running but is not serving clients"))
    #expect(notReady.detail.hasSuffix("Check the disk that holds the Stim home on mini."))

    let signedOut = try status(
      #"""
      {"machine":"mini","state":"tailscale-off","diagnosis":{"layer":"tailscale","code":"tailscale-logged-out","title":"Tailscale signed out","message":"Tailscale on this Mac is signed out.","remedy":"Sign in."}}
      """#)
    #expect(signedOut.listStatus.title == "Tailscale signed out")

    let outdated = try status(
      #"""
      {"machine":"mini","state":"outdated","diagnosis":{"layer":"compat","code":"server-outdated","title":"Server is outdated","message":"Older protocol.","remedy":"Update it."}}
      """#)
    #expect(outdated.state == .unknown)
    #expect(outdated.listStatus == MachineListStatus(title: "Server is outdated", tone: .warning))

    let older = try status(#"{"machine":"mini","state":"unreachable"}"#)
    #expect(older.listStatus.title == "Unreachable")
    #expect(older.detail == "stim-server did not answer on its tailscale serve route.")
  }

  @Test func marksATailnetMachineInRemoteMachinesWithItsDoctorStateNotTheTailscaleFlag() throws {
    func status(_ json: String) throws -> BuildMachineStatus {
      try JSONDecoder().decode(BuildMachineStatus.self, from: Data(json.utf8))
    }
    let mini = TailnetMac(id: "n1", hostName: "Mini", dnsName: "janics-mac-mini.tail.ts.net")
    let second = TailnetMac(id: "n2", hostName: "Mini (2)", dnsName: "janics-mac-mini-2.tail.ts.net")

    #expect(OffloadMachines.added(mini, entries: [], statuses: nil) == nil)
    #expect(OffloadMachines.added(second, entries: ["janics-mac-mini"], statuses: nil) == nil)
    #expect(OffloadMachines.added(mini, entries: ["janics-mac-mini"], statuses: nil) == AddedMachine(entry: "janics-mac-mini"))
    #expect(
      OffloadMachines.added(mini, entries: ["Janics-Mac-Mini.tail.ts.net:7444"], statuses: nil)?.entry
        == "Janics-Mac-Mini.tail.ts.net:7444")

    let healthy = try status(
      #"{"machine":"janics-mac-mini","state":"approved","offloadable":true,"dnsName":"janics-mac-mini.tail.ts.net"}"#)
    #expect(
      OffloadMachines.added(mini, entries: ["janics-mac-mini"], statuses: [healthy])
        == AddedMachine(entry: "janics-mac-mini", status: MachineListStatus(title: "Approved", tone: .success), detail: nil))

    let stopped = try status(
      #"""
      {"machine":"janics-mac-mini","state":"unreachable","dnsName":"janics-mac-mini.tail.ts.net","diagnosis":{"layer":"server","code":"server-not-running","title":"Server not running","message":"stim-server is not running on janics-mac-mini.","remedy":"Start it there."}}
      """#)
    let added = try #require(OffloadMachines.added(mini, entries: ["janics-mac-mini"], statuses: [stopped]))
    #expect(added.status == MachineListStatus(title: "Server not running", tone: .warning))
    #expect(added.detail == "stim-server is not running on janics-mac-mini. Start it there.")

    let otherMachine = try status(#"{"machine":"janics-mac-mini","state":"approved","dnsName":"another.tail.ts.net"}"#)
    #expect(OffloadMachines.added(mini, entries: ["janics-mac-mini"], statuses: [otherMachine])?.status == nil)
  }

  @Test func showsOneListPillPerMachine() throws {
    func status(_ json: String) throws -> BuildMachineStatus {
      try JSONDecoder().decode(BuildMachineStatus.self, from: Data(json.utf8))
    }
    let cases: [(String, String, Tone)] = [
      (#"{"machine":"m","state":"approved","offloadable":true}"#, "Approved", .success),
      (#"{"machine":"m","state":"approved"}"#, "Approved", .success),
      (#"{"machine":"m","state":"pending","deviceId":"d1"}"#, "Waiting for approval", .warning),
      (#"{"machine":"m","state":"unreachable"}"#, "Unreachable", .warning),
      (
        #"{"machine":"m","state":"approved","offloadable":false,"problems":[{"code":"unreachable","reason":"r"}]}"#,
        "Unreachable", .warning
      ),
      (
        #"{"machine":"m","state":"approved","offloadable":false,"problems":[{"code":"stim-build","reason":"r"}]}"#,
        "Needs update", .warning
      ),
      (
        #"{"machine":"m","state":"approved","offloadable":false,"problems":[{"code":"disk","reason":"r"}]}"#,
        "Low on disk", .warning
      ),
      (
        #"{"machine":"m","state":"approved","offloadable":false,"problems":[{"code":"new-code","reason":"r"}]}"#,
        "Not offloading", .warning
      ),
      (
        #"{"machine":"m","state":"approved","offloadable":false,"problems":[{"code":"busy","reason":"r"}],"capacity":{"loadPerCore":8.2}}"#,
        "Busy (load 8.2/core)", .warning
      ),
      (#"{"machine":"m","state":"revoked"}"#, "Revoked", .error),
    ]
    for (json, title, tone) in cases {
      let listed = try status(json).listStatus
      #expect(listed == MachineListStatus(title: title, tone: tone), "\(json)")
    }
  }

  @Test func showsTheBuildsAMachineRunsInItsBusyPillAndNoBusyReasonLine() throws {
    func status(_ json: String) throws -> BuildMachineStatus {
      try JSONDecoder().decode(BuildMachineStatus.self, from: Data(json.utf8))
    }
    let busy = try status(
      #"""
      {"machine":"mini","state":"approved","offloadable":false,
       "reasons":["busy (already running 1 offloaded build(s), its limit; load 1.4/core, 1 of 2 build slots busy)"],
       "problems":[{"code":"busy","reason":"busy (already running 1 offloaded build(s), its limit; load 1.4/core, 1 of 2 build slots busy)"}],
       "capacity":{"running":1,"max":1,"builds":1,"maxBuilds":2,"loadPerCore":1.4,"maxLoadPerCore":2,"diskFreeBytes":824e9,
                   "memoryUsedBytes":9663676416,"memoryTotalBytes":17179869184}}
      """#)
    #expect(busy.listStatus == MachineListStatus(title: "Busy (1/2 builds)", tone: .warning))
    #expect(busy.problemLines.isEmpty)
    #expect(busy.rowDetail.isEmpty)
    #expect(
      busy.capacity?.resources == [
        MachineResource(kind: .cpu, label: "Load", value: "1.4/core", tone: .normal),
        MachineResource(kind: .memory, label: "RAM", value: "9.0/16 GB", tone: .normal),
        MachineResource(kind: .disk, label: "Disk", value: "824 GB free", tone: .normal),
      ])

    let unlimited = try status(
      #"{"machine":"m","state":"approved","offloadable":false,"problems":[{"code":"busy","reason":"r"}],"capacity":{"builds":3,"maxBuilds":0,"loadPerCore":0.5,"maxLoadPerCore":2}}"#
    )
    #expect(unlimited.listStatus.title == "Busy (3 builds)")
    let loaded = try status(
      #"{"machine":"m","state":"approved","offloadable":false,"problems":[{"code":"busy","reason":"r"}],"capacity":{"builds":0,"maxBuilds":2,"loadPerCore":8.2,"maxLoadPerCore":2}}"#
    )
    #expect(loaded.listStatus.title == "Busy (load 8.2/core)")
    #expect(
      try status(#"{"machine":"m","state":"approved","offloadable":false,"problems":[{"code":"busy","reason":"r"}]}"#).listStatus
        .title == "Busy")
    let both = try status(
      #"{"machine":"m","state":"approved","offloadable":false,"problems":[{"code":"busy","reason":"b"},{"code":"stim-build","reason":"s"}]}"#
    )
    #expect(both.problemLines.map(\.reason) == ["s"])
  }

  @Test func describesAMachineRowFromDoctorsReport() throws {
    func status(_ json: String) throws -> BuildMachineStatus {
      try JSONDecoder().decode(BuildMachineStatus.self, from: Data(json.utf8))
    }
    let mini = try status(
      #"""
      {"machine":"mini","state":"approved","offloadable":false,"reasons":["CocoaPods 1.17.0 there, 1.16.2 here"],
       "problems":[{"code":"cocoapods","reason":"CocoaPods 1.17.0 there, 1.16.2 here"}],
       "capacity":{"running":0,"max":1,"diskFreeBytes":825196154880,"cpus":10,"loadPerCore":0.6,"builds":0,"maxBuilds":2}}
      """#)
    #expect(mini.rowDetail.isEmpty)
    #expect(
      mini.capacity?.resources == [
        MachineResource(kind: .cpu, label: "Load", value: "0.6/core", tone: .normal),
        MachineResource(kind: .disk, label: "Disk", value: "825.2 GB free", tone: .normal),
      ])
    #expect(
      mini.problemLines == [
        .init(code: "cocoapods", reason: "CocoaPods 1.17.0 there, 1.16.2 here", fix: .command("gem install cocoapods -v 1.16.2"))
      ])

    let missingPods = try status(
      #"{"machine":"m","state":"approved","offloadable":false,"problems":[{"code":"cocoapods","reason":"CocoaPods null there, 1.16.2 here"}]}"#
    )
    #expect(missingPods.problemLines.first?.fix == .command("brew install cocoapods"))
    let build = try status(
      #"{"machine":"m","state":"approved","offloadable":false,"problems":[{"code":"stim-build","reason":"Stim build 5773060690f40277 there, d9b8bdb39828c9a0 here"},{"code":"other","reason":"odd"}]}"#
    )
    #expect(build.problemLines.map(\.fix) == [.advice("Update the remote machine."), nil])
    #expect(build.problemLines.map(\.reason) == ["Stim build 5773060 there, d9b8bdb here", "odd"])
    #expect(build.rowDetail.isEmpty)

    let ready = try status(
      #"{"machine":"m","state":"approved","offloadable":true,"capacity":{"running":1,"max":2,"builds":3,"maxBuilds":0}}"#)
    #expect(ready.rowDetail == "Builds can run there.")
    #expect(ready.problemLines.isEmpty)
    let older = try status(#"{"machine":"m","state":"approved","offloadable":true,"capacity":{"running":1,"max":2}}"#)
    #expect(older.rowDetail == "Builds can run there.")
    #expect(try status(#"{"machine":"m","state":"approved"}"#).rowDetail == "Builds can run there.")
    #expect(
      try status(#"{"machine":"m","state":"pending"}"#).rowDetail
        == "Someone on m approves it by running the setup command there. The request lapses after 15 minutes.")
  }

  @Test func listsBuildsAndSimulatorsForAMachineWithApprovedHosting() {
    let hosts = [
      BuildMachineStatus(machine: "mini", state: .approved), BuildMachineStatus(machine: "studio", state: .pending),
    ]
    #expect(buildMachineCapabilities("mini", hosts: hosts) == ["Builds", "Simulators"])
    #expect(buildMachineCapabilities("Mini:7443", hosts: hosts) == ["Builds", "Simulators"])
    #expect(buildMachineCapabilities("studio", hosts: hosts) == ["Builds"])
    #expect(buildMachineCapabilities("mini", hosts: nil) == ["Builds"])
  }

  @Test func movesAnEntryToChangeThePlacementPriority() {
    let entries = ["fast", "slow", "spare"]
    #expect(OffloadMachines.moving("slow", by: -1, in: entries) == #"["slow","fast","spare"]"#)
    #expect(OffloadMachines.moving("fast", by: 1, in: entries) == #"["slow","fast","spare"]"#)
    #expect(OffloadMachines.moving("spare", by: -2, in: entries) == #"["spare","fast","slow"]"#)
    #expect(OffloadMachines.moving("fast", by: -1, in: entries) == nil)
    #expect(OffloadMachines.moving("spare", by: 1, in: entries) == nil)
    #expect(OffloadMachines.moving("unlisted", by: -1, in: entries) == nil)
  }

  @Test func editsTheSettingAndUnsetsItWhenEmpty() {
    #expect(OffloadMachines.adding("mini", to: ["studio:7444"]) == #"["studio:7444","mini"]"#)
    #expect(OffloadMachines.adding("mini", to: ["mini"]) == #"["mini"]"#)
    #expect(OffloadMachines.removing("studio:7444", from: ["studio:7444", "mini"]) == #"["mini"]"#)
    #expect(OffloadMachines.removing("mini", from: ["mini"]) == nil)
    let mini = TailnetMac(id: "n", hostName: "Mac mini", dnsName: "mini.tail1.ts.net")
    #expect(OffloadMachines.names("Mini:7444", mini) && OffloadMachines.names("mini.tail1.ts.net", mini))
    #expect(!OffloadMachines.names("minimal", mini))
  }

  @Test func keepsABuildRequestTargetInTheInbox() throws {
    let target = OversightTarget.buildRequest(id: "ab12")
    let decoded = try JSONDecoder().decode(OversightTarget.self, from: JSONEncoder().encode(target))
    #expect(decoded == target && decoded.path == nil)
  }
}

struct TailnetProbeTests {
  private func fakeTailscale(_ body: String) throws -> (dir: URL, environment: [String: String]) {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("tailnet-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let script = dir.appendingPathComponent("tailscale")
    try "#!/bin/sh\n\(body)\n".write(to: script, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
    return (dir, ["PATH": dir.path + ":/usr/bin:/bin"])
  }

  @Test func reportsAStalledTailscaleAsTimedOutWithinTheTimeout() throws {
    let (dir, environment) = try fakeTailscale("exec sleep 30")
    defer { try? FileManager.default.removeItem(at: dir) }
    let started = Date()
    let probe = Tailnet.probe(environment: environment, timeout: 0.5, appBinary: "/nonexistent/Tailscale")
    #expect(probe == .timedOut)
    #expect(Date().timeIntervalSince(started) < 10)
    #expect(MacTailscale(probe: probe, install: .cli) == .unresponsive)
  }

  @Test func returnsTheStatusOfATailscaleThatAnswers() throws {
    let (dir, environment) = try fakeTailscale(#"echo '{"BackendState":"Running"}'"#)
    defer { try? FileManager.default.removeItem(at: dir) }
    let probe = Tailnet.probe(environment: environment, timeout: 5, appBinary: "/nonexistent/Tailscale")
    #expect(probe == .answered(Data("{\"BackendState\":\"Running\"}\n".utf8)))
  }

  @Test func readsAFailingTailscaleAsUnavailable() throws {
    let (dir, environment) = try fakeTailscale("exit 1")
    defer { try? FileManager.default.removeItem(at: dir) }
    #expect(Tailnet.probe(environment: environment, timeout: 5, appBinary: "/nonexistent/Tailscale") == .unavailable)
  }
}
