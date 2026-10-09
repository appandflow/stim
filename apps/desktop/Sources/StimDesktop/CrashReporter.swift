import AppKit
import Foundation
import Sentry
import StimKit
import SystemConfiguration

enum CrashReporter {
  static let appHangTimeout: TimeInterval = 2

  static func start() {
    if let dsn = Diagnostics.sentryDSN(Bundle.main.object(forInfoDictionaryKey: "StimSentryDSN")) {
      let scrubber = CrashScrubber(hostNames: machineHostNames(), appBundleName: Bundle.main.bundleURL.lastPathComponent)
      let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
      let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0"
      SentrySDK.start { options in
        options.dsn = dsn
        options.releaseName = "stim-desktop@\(version)+\(build)"
        options.dist = build
        options.sendDefaultPii = false
        options.tracesSampleRate = nil
        options.enableAutoPerformanceTracing = false
        options.enableAppHangTracking = true
        options.appHangTimeoutInterval = appHangTimeout
        options.maxBreadcrumbs = 150
        options.attachStacktrace = false
        options.enableNetworkTracking = false
        options.enableNetworkBreadcrumbs = false
        options.enableCaptureFailedRequests = false
        options.enableMetricKit = false
        options.enableAutoSessionTracking = false
        options.sendClientReports = false
        options.enableUncaughtNSExceptionReporting = true
        options.beforeSend = { scrub($0, with: scrubber) }
        options.beforeBreadcrumb = { scrub($0, with: scrubber) }
      }
      Diagnostics.shared.install(
        Diagnostics.Sink(
          breadcrumb: { crumb in
            let breadcrumb = Breadcrumb(level: .info, category: crumb.category)
            breadcrumb.message = crumb.message
            for (key, value) in crumb.data { breadcrumb.setData(value: value, key: key) }
            SentrySDK.addBreadcrumb(breadcrumb)
          },
          tag: { key, value in SentrySDK.configureScope { $0.setTag(value: value, key: key) } },
          report: { report in
            let event = Event(level: .warning)
            event.message = SentryMessage(formatted: report.message)
            event.tags = report.tags
            event.fingerprint = report.fingerprint
            SentrySDK.capture(event: event)
          }))
    }
    switch ProcessInfo.processInfo.environment["STIM_DESKTOP_CRASH_TEST"] {
    case "exception":
      DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
        NSException(
          name: .genericException,
          reason: "Stim Desktop crash test from \(Bundle.main.bundlePath) on \(ProcessInfo.processInfo.hostName)",
          userInfo: nil
        ).raise()
      }
    case "hang":
      DispatchQueue.main.asyncAfter(deadline: .now() + 3) { Thread.sleep(forTimeInterval: appHangTimeout + 3) }
    case "crash":
      DispatchQueue.main.asyncAfter(deadline: .now() + 3) { fatalError("Stim Desktop crash test") }
    default: break
    }
  }

  private static func machineHostNames() -> [String] {
    var buffer = [CChar](repeating: 0, count: Int(MAXHOSTNAMELEN) + 1)
    let hostName = gethostname(&buffer, buffer.count) == 0 ? String(cString: buffer) : nil
    return [
      hostName, hostName?.split(separator: ".").first.map(String.init),
      SCDynamicStoreCopyComputerName(nil, nil) as String?, SCDynamicStoreCopyLocalHostName(nil) as String?,
    ].compactMap { $0 }
  }

  private static func scrub(_ event: Event, with scrubber: CrashScrubber) -> Event {
    event.serverName = nil
    event.request = nil
    if let message = event.message {
      let scrubbed = SentryMessage(formatted: scrubber.scrub(message.formatted))
      scrubbed.message = message.message.map(scrubber.scrub)
      scrubbed.params = message.params?.map(scrubber.scrub)
      event.message = scrubbed
    }
    event.transaction = event.transaction.map(scrubber.scrub)
    event.tags = event.tags?.mapValues(scrubber.scrub)
    event.extra = event.extra.map { scrubber.scrub($0) as? [String: Any] ?? [:] }
    event.context = event.context?.mapValues { scrubber.scrub($0) as? [String: Any] ?? [:] }
    event.user?.data = event.user?.data.map { scrubber.scrub($0) as? [String: Any] ?? [:] }
    for exception in event.exceptions ?? [] {
      exception.value = exception.value.map(scrubber.scrub)
      exception.mechanism?.desc = exception.mechanism?.desc.map(scrubber.scrub)
      exception.mechanism?.data = exception.mechanism?.data.map { scrubber.scrub($0) as? [String: Any] ?? [:] }
      scrub(exception.stacktrace, with: scrubber)
    }
    for thread in event.threads ?? [] {
      thread.name = thread.name.map(scrubber.scrub)
      scrub(thread.stacktrace, with: scrubber)
    }
    scrub(event.stacktrace, with: scrubber)
    for image in event.debugMeta ?? [] {
      image.codeFile = image.codeFile.map(scrubber.scrub)
    }
    for breadcrumb in event.breadcrumbs ?? [] {
      _ = scrub(breadcrumb, with: scrubber)
    }
    return event
  }

  private static func scrub(_ stacktrace: SentryStacktrace?, with scrubber: CrashScrubber) {
    for frame in stacktrace?.frames ?? [] {
      frame.fileName = frame.fileName.map(scrubber.scrub)
      frame.package = frame.package.map(scrubber.scrub)
      frame.contextLine = nil
      frame.preContext = nil
      frame.postContext = nil
      frame.vars = nil
    }
  }

  private static func scrub(_ breadcrumb: Breadcrumb, with scrubber: CrashScrubber) -> Breadcrumb {
    breadcrumb.message = breadcrumb.message.map(scrubber.scrub)
    for (key, value) in breadcrumb.data ?? [:] {
      breadcrumb.setData(value: scrubber.scrub(value), key: key)
    }
    return breadcrumb
  }
}
