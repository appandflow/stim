import NitroModules
import UIKit

final class HybridTickerView: HybridTickerViewSpec, TickerConsumer, RecyclableView {
  let view: UILabel = {
    let label = UILabel()
    label.font = .monospacedDigitSystemFont(ofSize: 28, weight: .semibold)
    label.textAlignment = .center
    label.textColor = .white
    label.backgroundColor = .systemIndigo
    label.numberOfLines = 0
    return label
  }()

  private static var nextId = 0
  private let viewId: Int
  private var attached: HybridTicker?

  var ticker: (any HybridTickerSpec)? {
    didSet {
      tickerLog("view v\(viewId) setTicker \(describe(ticker))")
      attach(ticker as? HybridTicker)
    }
  }

  override init() {
    HybridTickerView.nextId += 1
    viewId = HybridTickerView.nextId
    super.init()
    view.text = "no ticker"
    tickerLog("view v\(viewId) init")
  }

  deinit {
    tickerLog("view v\(viewId) deinit")
  }

  func onTick(tickerId: Double, count: Int) {
    DispatchQueue.main.async { [weak self] in
      guard let self, self.attached?.id == tickerId else { return }
      self.view.text = "ticker #\(Int(tickerId))\n\(count)"
    }
  }

  func beforeUpdate() { tickerLog("view v\(viewId) beforeUpdate") }

  func afterUpdate() { tickerLog("view v\(viewId) afterUpdate") }

  func onDropView() {
    tickerLog("view v\(viewId) onDropView")
    attach(nil)
  }

  func prepareForRecycle() {
    tickerLog("view v\(viewId) prepareForRecycle")
    attach(nil)
  }

  private func attach(_ next: HybridTicker?) {
    if attached === next { return }
    if let attached { attached.detach(self) }
    attached = next
    next?.attach(self)
    view.text = next.map { "ticker #\(Int($0.id))\n\(Int($0.count))" } ?? "no ticker"
  }

  private func describe(_ ticker: (any HybridTickerSpec)?) -> String {
    guard let ticker else { return "nil" }
    return ticker is HybridTicker ? "#\(Int(ticker.id))" : "foreign \(type(of: ticker))"
  }
}
