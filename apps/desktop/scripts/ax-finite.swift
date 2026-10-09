import ApplicationServices
import Foundation

func attr(_ element: AXUIElement, _ name: String) -> AnyObject? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value
}

func label(_ element: AXUIElement) -> String {
    let role = attr(element, kAXRoleAttribute) as? String ?? "?"
    let id = attr(element, kAXIdentifierAttribute) as? String ?? ""
    let title = attr(element, kAXTitleAttribute) as? String ?? ""
    return "\(role)[id=\(id) title=\(title)]"
}

func point(_ element: AXUIElement) -> CGPoint? {
    guard let raw = attr(element, kAXPositionAttribute) else { return nil }
    var p = CGPoint.zero
    return AXValueGetValue(raw as! AXValue, .cgPoint, &p) ? p : nil
}

func size(_ element: AXUIElement) -> CGSize? {
    guard let raw = attr(element, kAXSizeAttribute) else { return nil }
    var s = CGSize.zero
    return AXValueGetValue(raw as! AXValue, .cgSize, &s) ? s : nil
}

func frame(_ element: AXUIElement) -> CGRect? {
    guard let raw = attr(element, "AXFrame") else { return nil }
    var r = CGRect.zero
    return AXValueGetValue(raw as! AXValue, .cgRect, &r) ? r : nil
}

let childAttributes = [
    kAXChildrenAttribute, kAXVisibleChildrenAttribute, kAXRowsAttribute,
    kAXContentsAttribute, "AXChildrenInNavigationOrder", kAXColumnsAttribute,
]
var seen = Set<CFHashCode>()
var bad = 0
var total = 0

func walk(_ element: AXUIElement, _ path: [String]) {
    guard seen.insert(CFHash(element)).inserted else { return }
    total += 1
    let here = path + [label(element)]
    let p = point(element)
    let s = size(element)
    let f = frame(element)
    let finite = (f.map { $0.origin.x.isFinite && $0.origin.y.isFinite && $0.width.isFinite && $0.height.isFinite } ?? true)
        && (p.map { $0.x.isFinite && $0.y.isFinite } ?? true)
        && (s.map { $0.width.isFinite && $0.height.isFinite } ?? true)
    if !finite {
        bad += 1
        print("NON-FINITE pos=\(String(describing: p)) size=\(String(describing: s)) frame=\(String(describing: f))")
        print("  " + here.joined(separator: " > "))
    }
    let children = childAttributes.flatMap { attr(element, $0) as? [AXUIElement] ?? [] }
    for child in children { walk(child, here) }
}

guard CommandLine.arguments.count == 2, let pid = pid_t(CommandLine.arguments[1]) else {
    FileHandle.standardError.write(Data("usage: ax-finite.swift <pid>\n".utf8))
    exit(2)
}
guard AXIsProcessTrusted() else {
    FileHandle.standardError.write(Data("this process is not trusted for Accessibility\n".utf8))
    exit(2)
}
walk(AXUIElementCreateApplication(pid), [])
print("\(total) elements, \(bad) non-finite")
exit(bad == 0 ? 0 : 1)
