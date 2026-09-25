cask "stim" do
  version "@VERSION@"
  sha256 "@SHA256@"

  url "https://github.com/appandflow/stim/releases/download/desktop-v#{version}/Stim-#{version}.dmg"
  name "Stim"
  desc "Watch and control the simulators and emulators Stim runs"
  homepage "https://stim.appandflow.com/"

  livecheck do
    url "https://github.com/appandflow/stim/releases/download/desktop-latest/appcast.xml"
    strategy :sparkle
  end

  depends_on macos: ">= :sonoma"

  app "Stim.app"

  zap trash: "~/Library/Preferences/dev.stim.desktop.plist"
end
