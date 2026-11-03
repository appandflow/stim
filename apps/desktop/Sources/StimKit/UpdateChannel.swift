import Foundation

/// Sparkle channels for Stim Desktop's appcast. Items without a channel are stable and always allowed;
/// `.github/workflows/desktop-next.yml` publishes the items of the `next` channel.
public enum UpdateChannel {
  public static let prerelease = "next"

  /// A prerelease build was installed from the `next` channel, so it keeps receiving that channel until
  /// the user turns it off. Stable builds default to stable updates only.
  public static func prereleaseUpdatesDefault(bundleVersion: String?) -> Bool {
    bundleVersion?.contains("-\(prerelease).") ?? false
  }
}
