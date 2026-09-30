import Foundation
import Testing

@testable import WebFrames

struct DevToolsMessageTests {
  private func decode(_ json: String) -> DevToolsMessage? {
    DevToolsMessage(Data(json.utf8))
  }

  @Test func decodesAReplyByItsIdWithTheResult() throws {
    guard case .reply(let id, let result)? = decode(#"{"id":7,"result":{"frameId":"F1","n":2}}"#) else {
      Issue.record("not a reply")
      return
    }
    let value = try result.get()
    #expect(id == 7)
    #expect(value["frameId"] as? String == "F1" && value["n"] as? Int == 2)
  }

  @Test func aReplyWithoutAResultIsEmptyNotAFailure() throws {
    guard case .reply(_, let result)? = decode(#"{"id":1}"#) else {
      Issue.record("not a reply")
      return
    }
    #expect(try result.get().isEmpty)
  }

  @Test func aReplyErrorCarriesChromesMessageElseADefault() {
    for (json, message) in [
      (#"{"id":3,"error":{"code":-32000,"message":"No target with given id"}}"#, "No target with given id"),
      (#"{"id":3,"error":{"code":-32000}}"#, "DevTools command failed."),
    ] {
      guard case .reply(let id, .failure(let failure))? = decode(json) else {
        Issue.record("not a failed reply: \(json)")
        continue
      }
      #expect(id == 3 && failure.description == message)
    }
  }

  @Test func decodesAnEventWithItsSessionAndParams() {
    guard
      case .event(let event)? = decode(
        #"{"method":"Page.screencastFrame","params":{"sessionId":5,"data":"abc"},"sessionId":"S1"}"#)
    else {
      Issue.record("not an event")
      return
    }
    #expect(event.method == "Page.screencastFrame")
    #expect(event.sessionId == "S1")
    #expect(event.params["data"] as? String == "abc")
  }

  @Test func anEventWithoutParamsOrSessionHasNone() {
    guard case .event(let event)? = decode(#"{"method":"Inspector.detached"}"#) else {
      Issue.record("not an event")
      return
    }
    #expect(event.params.isEmpty && event.sessionId == nil)
  }

  @Test func aMessageWithAnIdIsAReplyEvenWhenItNamesAMethod() {
    guard case .reply(let id, _)? = decode(#"{"id":9,"method":"Page.enable"}"#) else {
      Issue.record("not a reply")
      return
    }
    #expect(id == 9)
  }

  @Test func ignoresWhatIsNotAReplyOrAnEvent() {
    #expect(decode("not json") == nil)
    #expect(decode("[1,2]") == nil)
    #expect(decode(#"{"result":{}}"#) == nil)
    #expect(decode(#"{"id":"7","result":{}}"#) == nil)
  }
}
