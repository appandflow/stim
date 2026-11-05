import AppKit

#if !DEBUG
  if ProcessInfo.processInfo.arguments.contains("--playground") {
    fputs("The SwiftUI playground requires a DEBUG build.\n", stderr)
    exit(1)
  }
#endif

_ = StimApplication.shared
#if DEBUG
  if ProcessInfo.processInfo.arguments.contains("--playground") {
    ScreenPlaygroundApp.main()
  } else {
    StimDesktopApp.main()
  }
#else
  StimDesktopApp.main()
#endif
