import Foundation
import StimKit

extension PairedServers {
  static let shared = PairedServers.live(
    store: KeychainPairedServerStore.make(),
    deviceName: Host.current().localizedName ?? ProcessInfo.processInfo.hostName,
    clientName: ServerSession.clientName,
    clientVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev",
    localServerID: { PairedServerSessions.localServerID })
}
