#if DEBUG
  import StimKit
  import SwiftUI

  enum DiscoveryFixtures {
    static func capHitUsingHostingMac() -> DiscoveryPrompt {
      Discovery.capHit(
        source: .init(at: Date(), workspaceID: "fixture", platform: "ios"), mac: nil, hosts: ["janics-mac-mini"])!
    }

    static func prompt(_ type: DiscoveryType) -> DiscoveryPrompt {
      let now = Date(timeIntervalSince1970: 1_791_284_400)
      let mac = Tailnet.macs(
        statusJSON: Data(
          """
          {"BackendState":"Running","Peer":{"mini":{"ID":"mini","HostName":"Studio",
          "DNSName":"janics-mac-mini.tail.test","OS":"macOS","Online":true}}}
          """.utf8))!.first!
      let placements = try! JSONDecoder().decode(
        [BuildPlacements.Placement].self,
        from: Data(
          """
          [{"at":"2026-10-05T12:00:00Z","project":"/fixture","platform":"ios","decision":"here",
          "reason":"local build","buildMs":240000,"slotWaitMs":65000}]
          """.utf8))
      let three = Array(repeating: placements[0], count: 3)
      switch type {
      case .slowCold: return Discovery.slowCold(placements: three, machines: [], macs: [mac], now: now)!
      case .newMac: return Discovery.newMac(macs: [mac], seen: [], machines: [], hosting: [], now: now).prompt!
      case .slotWait: return Discovery.slotWait(placements: three, macs: [mac], now: now)!
      case .lowWithCaches:
        return Discovery.lowWithCaches(
          plan: PressurePlan.make(freeBytes: 0, minimumFreeGb: 20, hardFloorGb: 5, report: nil),
          cacheBytes: 48 * 1_073_741_824)!
      case .capHit:
        return Discovery.capHit(source: .init(at: now, workspaceID: "fixture", platform: "ios"), mac: mac, hosts: [])!
      case .away: return Discovery.away(pairedPhones: 0, durationMs: 700_000, idleSeconds: 400)!
      }
    }
  }

  struct DiscoveryFixtureView: View {
    var type: DiscoveryType
    @StateObject private var center: NoticeCenter

    init(type: DiscoveryType, usesHostingMac: Bool = false) {
      self.type = type
      let center = NoticeCenter()
      let prompt = usesHostingMac ? DiscoveryFixtures.capHitUsingHostingMac() : DiscoveryFixtures.prompt(type)
      if prompt.surface == .banner {
        center.show(DiscoveryCoordinator.notice(prompt, perform: { _ in }, snooze: {}, never: {}))
      }
      _center = StateObject(wrappedValue: center)
    }

    var body: some View {
      ZStack(alignment: .bottomLeading) {
        Palette.background
        if type == .away {
          let prompt = DiscoveryFixtures.prompt(type)
          Card {
            VStack(alignment: .leading, spacing: Space.sm) {
              Text("Notification text").textStyle(.caption).foregroundStyle(Palette.secondary)
              Text(prompt.title).font(.stim(.headline))
              Text(prompt.detail ?? "").foregroundStyle(Palette.secondary)
            }
            .padding(Space.md)
          }
          .padding(Space.xl)
        } else {
          NoticeStack(center: center)
        }
      }
      .frame(width: 360, height: 300)
    }
  }

  struct DiscoveryPlayground: View {
    @State private var type = DiscoveryType.slowCold

    var body: some View {
      VStack {
        Picker("Suggestion", selection: $type) {
          ForEach(DiscoveryType.allCases, id: \.self) { type in Text(type.rawValue).tag(type) }
        }
        .frame(width: 320)
        DiscoveryFixtureView(type: type).id(type)
      }
      .padding(Space.xl)
    }
  }
#endif
