import Foundation
import NitroModules

protocol TickerConsumer: AnyObject {
  func onTick(tickerId: Double, count: Int)
}

func tickerLog(_ message: String) {
  let thread = Thread.isMainThread ? "main" : String(cString: __dispatch_queue_get_label(nil))
  NSLog("[TickerSpike] %@ (thread=%@)", message, thread)
}

final class HybridTicker: HybridTickerSpec {
  private static var nextId = 0.0

  let id: Double
  private let queue = DispatchQueue(label: "stim.ticker")
  private var timer: DispatchSourceTimer?
  private var ticks = 0
  private weak var consumer: TickerConsumer?

  override init() {
    HybridTicker.nextId += 1
    id = HybridTicker.nextId
    super.init()
    tickerLog("ticker #\(Int(id)) init")
  }

  deinit {
    timer?.cancel()
    tickerLog("ticker #\(Int(id)) deinit")
  }

  var count: Double { queue.sync { Double(ticks) } }

  var hasConsumer: Bool { queue.sync { consumer != nil } }

  func start() throws {
    queue.async { [weak self] in
      guard let self, self.timer == nil else { return }
      let timer = DispatchSource.makeTimerSource(queue: self.queue)
      timer.schedule(deadline: .now(), repeating: .milliseconds(33))
      timer.setEventHandler { [weak self] in self?.tick() }
      timer.resume()
      self.timer = timer
    }
  }

  func stop() throws {
    queue.async { [weak self] in
      self?.timer?.cancel()
      self?.timer = nil
    }
  }

  func attach(_ next: TickerConsumer) {
    queue.sync { consumer = next }
    tickerLog("ticker #\(Int(id)) attached consumer")
  }

  func detach(_ previous: TickerConsumer) {
    queue.sync { if consumer === previous { consumer = nil } }
    tickerLog("ticker #\(Int(id)) detached consumer")
  }

  private func tick() {
    ticks += 1
    if ticks == 1 || ticks % 150 == 0 {
      tickerLog("ticker #\(Int(id)) tick \(ticks) consumer=\(consumer != nil)")
    }
    consumer?.onTick(tickerId: id, count: ticks)
  }
}
