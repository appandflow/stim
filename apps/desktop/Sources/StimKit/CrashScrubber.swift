import Foundation

/// Removes what identifies the user's machine and workspaces from crash report text before it leaves the Mac:
/// file paths outside system and app locations, the machine's host names, private and tailnet hosts and
/// addresses, URL hosts and queries, and credentials.
///
/// A path inside the app's own bundle keeps its part from the bundle name on, such as
/// `<path>/Stim.app/Contents/MacOS/StimDesktop`.
public struct CrashScrubber: Sendable {
  public let appBundleName: String
  private let hostNames: Pattern?

  public init(hostNames: [String], appBundleName: String) {
    let names = Set(hostNames.filter { $0.count > 2 }).sorted { $0.count > $1.count }
    let alternatives = names.map(NSRegularExpression.escapedPattern).joined(separator: "|")
    self.hostNames = names.isEmpty ? nil : Pattern("(?i)(?<![\\w-])(?:\(alternatives))(?![\\w-])")
    self.appBundleName = appBundleName
  }

  public func scrub(_ text: String) -> String {
    var text = text
    text = Pattern.scheme.replace(in: text, with: "$1 <redacted>")
    text = Pattern.url.map(in: text) { match in
      let host = ["localhost", "127.0.0.1"].contains(match[2].lowercased()) ? match[2] : "<host>"
      return "\(match[1])://\(host)\(match[3])\(match[4])\(match[5].isEmpty ? "" : "?<redacted>")"
    }
    text = Pattern.keyValue.replace(in: text, with: "$1$2<redacted>")
    text = Pattern.opaqueToken.replace(in: text, with: "<redacted>")
    if let hostNames { text = hostNames.replace(in: text, with: "<host>") }
    text = Pattern.privateHost.replace(in: text, with: "<host>")
    text = Pattern.tailnetIPv6.replace(in: text, with: "<ip>")
    text = Pattern.ipv4.replace(in: text, with: "<ip>")
    return Pattern.path.map(in: text) { match in
      let path = match[0]
      if path == "/" || Self.keptPathPrefixes.contains(where: path.hasPrefix) { return path }
      let components = path.split(separator: "/", omittingEmptySubsequences: false)
      guard let bundle = components.firstIndex(where: { $0 == appBundleName }) else { return "<path>" }
      return "<path>/" + components[bundle...].joined(separator: "/")
    }
  }

  /// `value` with every string inside it, through dictionaries and arrays, scrubbed.
  public func scrub(_ value: Any) -> Any {
    switch value {
    case let string as String: scrub(string)
    case let dictionary as [String: Any]: dictionary.mapValues { scrub($0) }
    case let array as [Any]: array.map { scrub($0) }
    default: value
    }
  }

  private static let keptPathPrefixes = [
    "/System/", "/usr/", "/Library/", "/Applications/", "/bin/", "/sbin/", "/opt/homebrew/", "/dev/",
  ]
}

private struct Pattern: Sendable {
  let regex: NSRegularExpression

  init(_ pattern: String) {
    regex = try! NSRegularExpression(pattern: pattern)
  }

  static let scheme = Pattern(#"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+"#)
  static let keyValue = Pattern(
    #"(?i)\b([\w-]*(?:token|secret|password|passwd|apikey|api_key|api-key|signature|authorization|dsn))(["']?\s*[=:]\s*["']?)[^\s&"',;}]+"#
  )
  static let opaqueToken = Pattern(
    #"(?<![\w-])(?=[A-Za-z_-]*\d)(?=[\d_-]*[A-Za-z])[A-Za-z0-9_-]{40,}(?![\w-])"#)
  static let url = Pattern(
    #"(?i)\b([a-z][a-z0-9+.-]*)://(?:[^/\s@"'<>]*@)?([^/\s?#"'<>:]+)(:\d+)?([^\s?#"'<>]*)(\?[^\s#"'<>]*)?"#)
  static let privateHost = Pattern(
    #"(?i)\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:local|ts\.net|lan|internal|home\.arpa)\b"#)
  static let tailnetIPv6 = Pattern(#"(?i)\bfd7a:115c:a1e0(?::[0-9a-f]{0,4}){1,5}"#)
  static let ipv4 = Pattern(#"(?<![\d.])(?!127\.)\d{1,3}(?:\.\d{1,3}){3}(?![\d.])"#)
  static let path = Pattern(
    #"(?:(?<=file://)|(?<![\w.~:/>-]))(?:~(?=/)|/)[^\s:'"(),;<>\[\]{}|*?]*"#)

  func replace(in text: String, with template: String) -> String {
    regex.stringByReplacingMatches(in: text, range: NSRange(text.startIndex..., in: text), withTemplate: template)
  }

  func map(in text: String, _ transform: ([String]) -> String) -> String {
    var result = ""
    var last = text.startIndex
    for match in regex.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
      guard let range = Range(match.range, in: text) else { continue }
      let groups = (0..<match.numberOfRanges).map { index in
        Range(match.range(at: index), in: text).map { String(text[$0]) } ?? ""
      }
      result += text[last..<range.lowerBound] + transform(groups)
      last = range.upperBound
    }
    return result + text[last...]
  }
}
