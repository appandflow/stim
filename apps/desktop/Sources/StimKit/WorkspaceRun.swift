extension Workspace {
  public func hostedMachine(platform: String, slot: String = DeviceRef.defaultSlot) -> String? {
    devices.first { $0.platform == platform && $0.slot == slot }?.hostedMachine
  }

  public func runCommand(platform: String) -> StimCommand {
    let remote = hostedMachine(platform: platform).map { ["--remote", $0] } ?? []
    let arguments = [platform] + (["ios", "android"].contains(platform) ? remote : [])
    return StimCommand(arguments, cwd: path)
  }
}
