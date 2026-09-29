import Foundation

/// One row of the Logs view: the records of one failure, led by the record that carries its message. The phone's
/// `groupRecords` in `apps/mobile/src/lib/logs.ts` builds the same entries; both replay
/// `Tests/StimKitTests/Fixtures/log-entries-vectors.json`.
public struct LogEntry: Sendable {
  public var lead: LogRecord
  /// Other headline records of the same failure, such as `Bundling failed` and the failed bundle response, in log
  /// order.
  public var related: [LogRecord]
  /// How many of `related` come before `lead` in the log.
  public var relatedBefore: Int
  /// Lines Expo printed under the lead's message: its code frame and parser stack.
  public var context: [String]

  /// Every record of the entry as `stim logs` prints it, with the context lines under the lead.
  public var plainText: String {
    var lines = related[..<relatedBefore].map(\.plainText)
    lines.append(lead.plainText)
    lines += context
    lines += related[relatedBefore...].map(\.plainText)
    return lines.joined(separator: "\n")
  }
}

private let bundleLineWindowMs = 1000.0
private let bundleResponseWindowMs = 2000.0

private func isError(_ record: LogRecord) -> Bool { record.level >= .error }

private func isExpoLine(_ record: LogRecord) -> Bool {
  record.src == "metro" && record.raw == true && record.event == "expo_stdout"
}

private func regex(_ pattern: String) -> NSRegularExpression { try! NSRegularExpression(pattern: pattern) }

private func matches(_ regex: NSRegularExpression, _ text: String) -> Bool {
  regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil
}

private let codeFrameLine = [regex(#"^\s*>?\s*\d+\s*\|"#), regex(#"^\s*\|\s*\^"#)]
private let expoContextLine =
  [regex(#"^Code: \S"#)] + codeFrameLine + [
    regex(#"^Call Stack$"#), regex(#"^\s+.+\([^()]+:\d+:\d+\)\s*$"#), regex(#"^\s+at\s+\S+:\d+:\d+\s*$"#),
  ]

private func isCodeFrameLine(_ line: String) -> Bool { codeFrameLine.contains { matches($0, line) } }

/// The lines `stim logs --errors` attaches to an Expo error (`isExpoErrorContext` in `@stim-cli/core`).
private func isExpoContext(_ record: LogRecord) -> Bool {
  isExpoLine(record) && expoContextLine.contains { matches($0, record.msg) }
}

/// The entries of a growing log, the same as the phone's `groupRecords` builds from every record so far. In Expo's
/// dev server a failed bundle is a `Bundling failed` marker line, the error line with its code frame lines, and a
/// failed bundle response from Stim's middleware; those become one entry, and every other record is its own.
/// Appending a batch costs time in proportion to the batch.
public struct LogEntryList: Sendable {
  public private(set) var records: [LogRecord] = []
  public private(set) var entries: [LogEntry] = []

  private enum State: Sendable {
    /// A `Bundling failed` marker waiting for the next Expo line, which can be its error line.
    case lookahead
    /// An Expo error taking the code frame and stack lines Expo prints after it.
    case scanning
    case settled
  }

  private struct Group: Sendable {
    var first: Int
    var lead: Int
    var members: [Int]
    var context: [Int] = []
    var state: State
  }

  private var groups: [Group] = []
  /// Groups still taking records, in the order they started.
  private var open: [Int] = []
  private var failures: [Int] = []
  private var responses: [Int] = []
  /// The failed bundle response joined to each failure.
  private var responseOf: [Int: Int] = [:]
  private var merged = Set<Int>()
  /// The group of each entry.
  private var visible: [Int] = []

  public init() {}

  /// Adds records at the end of the log and returns the index of the first entry that changed; entries before it
  /// are unchanged.
  @discardableResult
  public mutating func append(_ batch: [LogRecord]) -> Int {
    var changed = groups.count
    var pairing = false
    for record in batch {
      let n = records.count
      records.append(record)
      if let g = offer(n) {
        changed = min(changed, g)
        continue
      }
      let g = groups.count
      let expoError = isExpoLine(record) && isError(record)
      let marker = expoError && record.marker == true
      groups.append(
        Group(first: n, lead: n, members: [n], state: marker ? .lookahead : expoError ? .scanning : .settled))
      if expoError { open.append(g) }
      if marker { failures.append(g) }
      if record.event == "bundle_response_failed" { responses.append(g) }
      pairing = pairing || marker || record.event == "bundle_response_failed"
    }
    if pairing { changed = min(changed, pairResponses()) }
    return rebuild(from: changed)
  }

  /// Drops at least `count` of the oldest records and the entries they belong to, never part of an entry, and
  /// returns how many entries it dropped.
  public mutating func dropOldest(_ count: Int) -> Int {
    var cut = min(count, records.count)
    guard cut > 0 else { return 0 }
    var straddled = true
    while straddled {
      straddled = false
      for (g, group) in groups.enumerated() {
        var indexes = group.members + group.context
        if let r = responseOf[g] { indexes.append(groups[r].lead) }
        if indexes.min()! < cut && indexes.max()! >= cut {
          cut = indexes.max()! + 1
          straddled = true
        }
      }
    }
    let droppedGroups = groups.prefix { $0.first < cut }.count
    let droppedEntries = visible.prefix { $0 < droppedGroups }.count
    records.removeFirst(cut)
    groups.removeFirst(droppedGroups)
    for g in groups.indices {
      groups[g].first -= cut
      groups[g].lead -= cut
      groups[g].members = groups[g].members.map { $0 - cut }
      groups[g].context = groups[g].context.map { $0 - cut }
    }
    let shift = { (gs: [Int]) in gs.filter { $0 >= droppedGroups }.map { $0 - droppedGroups } }
    open = shift(open)
    failures = shift(failures)
    responses = shift(responses)
    responseOf = Dictionary(
      uniqueKeysWithValues: responseOf.filter { $0.key >= droppedGroups }.map {
        ($0.key - droppedGroups, $0.value - droppedGroups)
      })
    merged = Set(responseOf.values)
    visible = visible.dropFirst(droppedEntries).map { $0 - droppedGroups }
    entries.removeFirst(droppedEntries)
    return droppedEntries
  }

  /// The index of the entry that holds `records[record]`.
  public func entryIndex(ofRecord record: Int) -> Int? {
    guard
      var g = groups.lastIndex(where: { $0.first <= record && ($0.members.contains(record) || $0.context.contains(record)) })
    else { return nil }
    if merged.contains(g), let failure = responseOf.first(where: { $0.value == g })?.key { g = failure }
    return visible.firstIndex(of: g)
  }

  /// Offers a new record to the open groups in the order they started, as the phone's `groupRecords` scans ahead
  /// from each one in turn, and returns the group that took it. An Expo line that an open group does not take ends
  /// its scan.
  private mutating func offer(_ n: Int) -> Int? {
    let record = records[n]
    guard isExpoLine(record) else { return nil }
    while let g = open.first {
      if groups[g].state == .lookahead {
        groups[g].state = .scanning
        if isError(record) && record.marker != true && record.ts - records[groups[g].first].ts <= bundleLineWindowMs {
          groups[g].members.append(n)
          groups[g].lead = n
          return g
        }
      }
      if isExpoContext(record) {
        groups[g].context.append(n)
        return g
      }
      groups[g].state = .settled
      open.removeFirst()
    }
    return nil
  }

  /// Joins each failed bundle response to the nearest unanswered failure of its platform, and returns the first
  /// group whose pairing changed.
  private mutating func pairResponses() -> Int {
    let records = records
    let groups = groups
    let first = { (g: Int) in records[groups[g].first] }
    var pairs: [Int: Int] = [:]
    for response in responses {
      let record = records[groups[response].lead]
      let distance = { (g: Int) in abs(first(g).ts - record.ts) }
      let prefix = record.platform.map { $0.lowercased() + " " }
      let target =
        failures
        .filter { g in
          pairs[g] == nil && distance(g) <= bundleResponseWindowMs
            && (prefix.map { first(g).msg.lowercased().hasPrefix($0) } ?? true)
        }
        .min { distance($0) < distance($1) }
      if let target { pairs[target] = response }
    }
    let changed = Set(pairs.keys).union(responseOf.keys).filter { pairs[$0] != responseOf[$0] }
    let moved = Set(pairs.values).symmetricDifference(merged)
    responseOf = pairs
    merged = Set(pairs.values)
    return changed.union(moved).min() ?? groups.count
  }

  private mutating func rebuild(from group: Int) -> Int {
    var start = visible.count
    while start > 0 && visible[start - 1] >= group { start -= 1 }
    visible.removeSubrange(start...)
    entries.removeSubrange(start...)
    for g in group..<groups.count where !merged.contains(g) {
      visible.append(g)
      entries.append(entry(g))
    }
    return start
  }

  private func entry(_ g: Int) -> LogEntry {
    let group = groups[g]
    var indexes = group.members
    if let r = responseOf[g] { indexes.append(groups[r].lead) }
    let related = indexes.filter { $0 != group.lead }.sorted()
    let lead = records[group.lead]
    return LogEntry(
      lead: lead,
      related: related.map { records[$0] },
      relatedBefore: related.firstIndex { $0 > group.lead } ?? related.count,
      context: group.context.isEmpty && lead.context != nil ? lead.context! : group.context.map { records[$0].msg })
  }
}

private let pathDelimiters = Set<Character>("'\"`(),:;<>[]{}")

private func isPathChar(_ c: Character?) -> Bool {
  guard let c else { return false }
  return !c.isWhitespace && !pathDelimiters.contains(c)
}

private func replaceRoot(_ text: String, root: String, under: String, bare: String?) -> String {
  var out = ""
  var from = text.startIndex
  var search = text.startIndex
  while search < text.endIndex, let found = text.range(of: root, options: .literal, range: search..<text.endIndex) {
    search = text.index(after: found.lowerBound)
    if found.lowerBound < from { continue }
    let before = found.lowerBound > text.startIndex ? text[text.index(before: found.lowerBound)] : nil
    let after = found.upperBound < text.endIndex ? text[found.upperBound] : nil
    if isPathChar(before) { continue }
    if after == "/" {
      out += text[from..<found.lowerBound] + under
      from = text.index(after: found.upperBound)
    } else if let bare, !isPathChar(after) {
      out += text[from..<found.lowerBound] + bare
      from = found.upperBound
    }
  }
  return out + text[from...]
}

private func trimmingTrailingSlashes(_ path: String?) -> String? {
  guard var path else { return nil }
  while path.hasSuffix("/") { path.removeLast() }
  return path.isEmpty ? nil : path
}

/// `text` with every path under `root` written relative to it. `root` matches only whole path segments, so
/// `/w/app` leaves `/w/apple/x` alone.
public func relativeTo(_ text: String, root: String?) -> String {
  guard let base = trimmingTrailingSlashes(root) else { return text }
  return replaceRoot(text, root: base, under: "", bare: nil)
}

/// `text` with the home folder written as `~` wherever it starts a path, with the same whole-segment matching as
/// `relativeTo`.
public func tildeHome(_ text: String, home: String?) -> String {
  guard let base = trimmingTrailingSlashes(home) else { return text }
  return replaceRoot(text, root: base, under: "~/", bare: "~")
}

/// The same `at fn (file:line:column)` line `stim logs` prints for a frame; nil for a frame with nothing to print.
func stackLine(_ frame: StackFrame) -> String? {
  let parts: [String?] = [frame.file, frame.line.map(String.init), frame.column.map(String.init)]
  let location = parts.compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: ":")
  let fn = frame.fn.flatMap { $0.isEmpty ? nil : $0 }
  if let fn { return location.isEmpty ? "at \(fn)" : "at \(fn) (\(location))" }
  return location.isEmpty ? nil : "at \(location)"
}

/// Whether `file` is the workspace's own code: under `root` and outside `node_modules`.
private func isAppFile(_ file: String, relative: String) -> Bool {
  relative != file && !relative.contains("node_modules/")
}

public struct StackPreview: Equatable, Sendable {
  public struct Frame: Equatable, Sendable {
    public var fn: String
    public var location: String
    /// Code in the workspace, outside `node_modules`.
    public var app: Bool
  }

  public var frames: [Frame]
  /// Frames left out of `frames`.
  public var hidden: Int
  /// Whether every hidden frame is framework code.
  public var hiddenFramework: Bool
}

private let previewFrames = 3
private let packageName = regex(#"node_modules/((?:@[^/]+/)?[^/]+)"#)
private let webScript = regex(#"^https?://"#)

private func scriptName(_ file: String) -> String? {
  guard matches(webScript, file) else { return nil }
  let path = file.prefix { $0 != "?" && $0 != "#" }
  let name = path.split(separator: "/", omittingEmptySubsequences: false).last.map(String.init) ?? ""
  return name.isEmpty ? nil : name
}

private func lastPackage(_ file: String) -> String? {
  guard file.contains("node_modules/"),
    let match = packageName.matches(in: file, range: NSRange(file.startIndex..., in: file)).last,
    let range = Range(match.range(at: 1), in: file)
  else { return nil }
  return String(file[range])
}

/// The top frames of a stack for a collapsed row: the workspace's own frames, and at most one framework frame,
/// which shows as its package.
public func stackPreview(_ stack: [StackFrame]?, root: String, home: String?) -> StackPreview? {
  guard let stack else { return nil }
  let all = stack.compactMap { frame -> StackPreview.Frame? in
    let file = frame.file ?? ""
    let relative = relativeTo(file, root: root)
    let app = isAppFile(file, relative: relative)
    let location =
      app
      ? ([relative] + [frame.line.map(String.init)].compactMap { $0 }).filter { !$0.isEmpty }.joined(separator: ":")
      : lastPackage(file) ?? scriptName(file) ?? tildeHome(file, home: home)
    let fn = frame.fn ?? ""
    return fn.isEmpty && location.isEmpty ? nil : StackPreview.Frame(fn: fn, location: location, app: app)
  }
  guard !all.isEmpty else { return nil }
  var shown = Set<Int>()
  var framework = false
  for (i, frame) in all.enumerated() where shown.count < previewFrames {
    if frame.app {
      shown.insert(i)
    } else if !framework {
      framework = true
      shown.insert(i)
    }
  }
  return StackPreview(
    frames: all.indices.filter(shown.contains).map { all[$0] },
    hidden: all.count - shown.count,
    hiddenFramework: all.indices.allSatisfy { shown.contains($0) || !all[$0].app })
}

/// What a log entry shows: its message first, then where it happened, then the code frame.
public struct LogEntryView: Equatable, Sendable {
  public struct StackLine: Equatable, Sendable {
    public var text: String
    /// Code in the workspace, outside `node_modules`.
    public var app: Bool
  }

  public var title: String
  public var location: String?
  public var codeFrame: [String]
  /// The rest of the message and the first lines of the entry's other records.
  public var notes: [String]
  public var stack: [StackLine]

  /// `notes`, then the stack, as the phone lists them under the code frame.
  public var details: [String] { notes + stack.map(\.text) }
}

private let expoErrorPrefix = regex(#"^\s*ERROR\s+"#)
private let babelError = regex(
  #"^(?:(?<type>[A-Z][A-Za-z]*Error): )?(?<file>[^\s:]*/[^\s:]*|[^\s:/]+\.[A-Za-z]+): (?<message>.*?)(?: \((?<line>\d+):(?<column>\d+)\))?$"#
)

private func group(_ match: NSTextCheckingResult, _ name: String, in text: String) -> String? {
  Range(match.range(withName: name), in: text).map { String(text[$0]) }
}

/// Whether `head` can match `babelError`: its first `: ` follows a path, or an error type and then a path.
private func mayNameFile(_ head: String) -> Bool {
  let parts = head.split(separator: ": ", maxSplits: 2, omittingEmptySubsequences: false)
  guard parts.count > 1 else { return false }
  let file = parts[0].hasSuffix("Error") && !parts[0].contains(" ") && parts.count > 2 ? parts[1] : parts[0]
  return !file.contains(where: \.isWhitespace) && (file.contains("/") || file.contains("."))
}

public func viewEntry(_ entry: LogEntry, root: String, home: String?) -> LogEntryView {
  let clean = { (text: String) in tildeHome(relativeTo(text, root: root), home: home) }
  var lines = entry.lead.msg.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
  var head = lines.isEmpty ? "" : lines.removeFirst()
  if head.contains("ERROR") {
    head = expoErrorPrefix.stringByReplacingMatches(
      in: head, range: NSRange(head.startIndex..., in: head), withTemplate: "")
  }
  if head.hasPrefix("["), head.hasSuffix("]"), head.count >= 2 { head = String(head.dropFirst().dropLast()) }

  var title = clean(head)
  var location: String?
  if mayNameFile(head), let match = babelError.firstMatch(in: head, range: NSRange(head.startIndex..., in: head)),
    let file = group(match, "file", in: head), let message = group(match, "message", in: head)
  {
    title = group(match, "type", in: head).map { "\($0): \(message)" } ?? message
    location =
      clean(file)
      + (group(match, "line", in: head).map { ":\($0):\(group(match, "column", in: head) ?? "")" } ?? "")
  }

  var codeFrame: [String] = []
  var notes = entry.related.map { clean(String($0.msg.prefix { $0 != "\n" })) }
  for line in lines + entry.context {
    if isCodeFrameLine(line) {
      codeFrame.append(line)
    } else if !line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      notes.append(clean(line))
    }
  }
  let stack = (entry.lead.stack ?? []).compactMap { frame -> LogEntryView.StackLine? in
    guard let line = stackLine(frame) else { return nil }
    let file = frame.file ?? ""
    return LogEntryView.StackLine(text: clean(line), app: isAppFile(file, relative: relativeTo(file, root: root)))
  }
  return LogEntryView(title: title, location: location, codeFrame: codeFrame, notes: notes, stack: stack)
}
