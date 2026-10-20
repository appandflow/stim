import SwiftUI

@main
struct NativeAcceptance: App {
    var body: some Scene {
        WindowGroup { AcceptanceView() }
    }
}

struct AcceptanceView: View {
    @State private var count = 0
    private let revision = "native-revision-one"

    var body: some View {
        VStack(spacing: 24) {
            Text(revision).accessibilityIdentifier("revision")
            Text("Count: \(count)").accessibilityIdentifier("counter")
            Button("Increment") {
                count += 1
                NSLog("native-acceptance-click:%@:%d", revision, count)
            }
            .accessibilityIdentifier("increment")
        }
        .padding()
        .onAppear { NSLog("native-acceptance-ready:%@", revision) }
    }
}
