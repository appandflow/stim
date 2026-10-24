#!/usr/bin/env bash
# Set up an Ubuntu 22.04 or 24.04 x86_64 machine as a Stim Linux worker that
# takes offloaded Android debug builds. Run it as the user that will own the
# service, not as root; it calls sudo where it needs it. Safe to run again.
#
#   scripts/linux-worker/setup.sh [options] [sdkmanager-package ...]
#
# Docs: website/docs/remote-machines.md, "Linux worker".
set -euo pipefail

DEFAULT_SDK_PACKAGES=(
  "platforms;android-37.0"
  "build-tools;37.0.0"
  "ndk;27.1.12297006"
  "cmake;3.22.1"
)
EMULATOR_SDK_PACKAGES=(
  "emulator"
  "system-images;android-36;google_apis;x86_64"
)
CMDLINE_TOOLS_BUILD="${CMDLINE_TOOLS_BUILD:-13114758}"
NODE_MAJOR=22
MIN_NODE="22.12.0"
JAVA_HOME_DIR="/usr/lib/jvm/java-17-openjdk-amd64"
ANDROID_HOME_DIR="${ANDROID_HOME:-$HOME/Android/Sdk}"

emulator=0
server_version="latest"
hostname=""
tailscale_step=1
service_step=1
sdk_packages=()

usage() {
  cat <<'USAGE'
Usage: setup.sh [options] [sdkmanager-package ...]

Installs or verifies Node 22.12+ with Corepack (pnpm and yarn), JDK 17, the
Android command-line tools in ~/Android/Sdk, Tailscale, @stim-cli/server, and
the stim-server systemd user service with a tailnet-only route.

Packages named on the command line replace the default list
(platforms;android-37.0, build-tools;37.0.0, ndk;27.1.12297006, cmake;3.22.1).
platform-tools is always installed. Read the versions your app needs from its
React Native gradle/libs.versions.toml. Running this script accepts the Android
SDK licenses.

Options:
  --emulator               Add the user to the kvm group and install the Android
                           emulator and an x86_64 API 36 system image.
  --server-version V       @stim-cli/server version to install (default: latest).
  --hostname NAME          Tailscale machine name for a new login.
  --no-tailscale           Skip installing and logging in to Tailscale.
  --no-service             Skip the server install and the systemd service.
                           For containers and CI images.
  -h, --help               Show this help.

This script never takes a Tailscale auth key. It runs `tailscale up`, which
prints a login URL for you to open.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --emulator) emulator=1 ;;
    --server-version)
      [ $# -ge 2 ] || { echo "--server-version needs a value" >&2; exit 2; }
      server_version="$2"
      shift
      ;;
    --hostname)
      [ $# -ge 2 ] || { echo "--hostname needs a value" >&2; exit 2; }
      hostname="$2"
      shift
      ;;
    --no-tailscale) tailscale_step=0 ;;
    --no-service) service_step=0 ;;
    -h | --help)
      usage
      exit 0
      ;;
    -*)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
    *) sdk_packages+=("$1") ;;
  esac
  shift
done
[ ${#sdk_packages[@]} -gt 0 ] || sdk_packages=("${DEFAULT_SDK_PACKAGES[@]}")
sdk_packages=("platform-tools" "${sdk_packages[@]}")
if [ "$emulator" = 1 ]; then sdk_packages+=("${EMULATOR_SDK_PACKAGES[@]}"); fi

step() { printf '\n==> %s\n' "$*"; }
ok() { printf '    ok: %s\n' "$*"; }
warn() { printf '    warning: %s\n' "$*" >&2; }
die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

version_at_least() {
  [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" = "$2" ]
}

preflight() {
  step "Checking this machine"
  [ "$(id -u)" -ne 0 ] || die "run this as the user that will own the service, not as root; it uses sudo where needed"
  [ "$(uname -s)" = Linux ] || die "this script is for Ubuntu Linux"
  [ "$(uname -m)" = x86_64 ] || die "this script supports x86_64 only (found $(uname -m))"
  [ -r /etc/os-release ] || die "cannot read /etc/os-release"
  # shellcheck disable=SC1091
  . /etc/os-release
  case "${ID:-}:${VERSION_ID:-}" in
    ubuntu:22.04 | ubuntu:24.04) ok "Ubuntu $VERSION_ID ($VERSION_CODENAME) x86_64" ;;
    *) die "this script supports Ubuntu 22.04 and 24.04 (found ${PRETTY_NAME:-unknown})" ;;
  esac
  command -v sudo >/dev/null || die "sudo is required"
  sudo -n true 2>/dev/null || sudo -v
}

apt_install() {
  sudo env DEBIAN_FRONTEND=noninteractive NEEDRESTART_SUSPEND=1 apt-get install -y --no-install-recommends "$@" >/dev/null
}

install_base() {
  step "Installing base packages"
  sudo apt-get update -qq
  apt_install ca-certificates curl gnupg unzip git
  ok "ca-certificates curl gnupg unzip git"
}

install_node() {
  step "Node $MIN_NODE or later with Corepack"
  local current=""
  if command -v node >/dev/null; then current="$(node -p 'process.versions.node')"; fi
  if [ -n "$current" ] && version_at_least "$current" "$MIN_NODE"; then
    ok "Node $current is already installed"
  else
    if [ -n "$current" ]; then echo "    Node $current is older than $MIN_NODE; installing Node $NODE_MAJOR from NodeSource"; fi
    sudo install -d -m 0755 /etc/apt/keyrings
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key |
      sudo gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" |
      sudo tee /etc/apt/sources.list.d/nodesource.list >/dev/null
    sudo apt-get update -qq
    apt_install nodejs
    hash -r
    ok "Node $(node -p 'process.versions.node')"
  fi
  command -v corepack >/dev/null ||
    die "this Node has no corepack; install pnpm and yarn yourself (sudo npm install --global pnpm yarn)"
  local bin
  bin="$(dirname "$(readlink -f "$(command -v node)")")"
  if [ -w "$bin" ]; then
    corepack enable pnpm yarn
  else
    sudo env "PATH=$PATH" corepack enable pnpm yarn
  fi
  ok "corepack shims for pnpm and yarn (versions follow each project's packageManager field)"
}

install_jdk() {
  step "JDK 17"
  if [ ! -x "$JAVA_HOME_DIR/bin/javac" ]; then apt_install openjdk-17-jdk-headless; fi
  [ -x "$JAVA_HOME_DIR/bin/javac" ] || die "JDK 17 is not at $JAVA_HOME_DIR"
  ok "$("$JAVA_HOME_DIR/bin/javac" -version 2>&1)"
}

install_android_sdk() {
  step "Android SDK in $ANDROID_HOME_DIR"
  local sdkmanager="$ANDROID_HOME_DIR/cmdline-tools/latest/bin/sdkmanager"
  if [ -x "$sdkmanager" ]; then
    ok "command-line tools are already installed"
  else
    local tmp
    tmp="$(mktemp -d)"
    curl -fsSL -o "$tmp/clt.zip" "https://dl.google.com/android/repository/commandlinetools-linux-${CMDLINE_TOOLS_BUILD}_latest.zip"
    unzip -q "$tmp/clt.zip" -d "$tmp"
    mkdir -p "$ANDROID_HOME_DIR/cmdline-tools"
    rm -rf "$ANDROID_HOME_DIR/cmdline-tools/latest"
    mv "$tmp/cmdline-tools" "$ANDROID_HOME_DIR/cmdline-tools/latest"
    rm -rf "$tmp"
    ok "command-line tools build $CMDLINE_TOOLS_BUILD"
  fi
  export JAVA_HOME="$JAVA_HOME_DIR"
  echo "    accepting the Android SDK licenses"
  "$sdkmanager" --sdk_root="$ANDROID_HOME_DIR" --licenses >/dev/null < <(yes)
  echo "    sdkmanager: ${sdk_packages[*]}"
  "$sdkmanager" --sdk_root="$ANDROID_HOME_DIR" --install "${sdk_packages[@]}" >/dev/null
  ok "SDK packages installed"
}

setup_kvm() {
  step "KVM for the Android emulator"
  apt_install cpu-checker
  if [ ! -e /dev/kvm ]; then
    warn "/dev/kvm is missing. On a cloud VM, choose an instance type with nested virtualization."
    return
  fi
  if id -nG "$USER" | tr ' ' '\n' | grep -qx kvm; then
    ok "$USER is in the kvm group"
  else
    sudo usermod -aG kvm "$USER"
    ok "added $USER to the kvm group; log out and in again before the emulator can use KVM"
  fi
}

tailscale_field() {
  tailscale status --json 2>/dev/null | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const j = JSON.parse(s || "{}");
      process.stdout.write(process.argv[1] === "state" ? (j.BackendState ?? "") : String((j.Self?.DNSName ?? "").split(".")[0]));
    });
  ' "$1" || true
}

setup_tailscale() {
  step "Tailscale"
  if ! command -v tailscale >/dev/null; then
    sudo install -d -m 0755 /usr/share/keyrings
    curl -fsSL "https://pkgs.tailscale.com/stable/ubuntu/${VERSION_CODENAME}.noarmor.gpg" |
      sudo tee /usr/share/keyrings/tailscale-archive-keyring.gpg >/dev/null
    curl -fsSL "https://pkgs.tailscale.com/stable/ubuntu/${VERSION_CODENAME}.tailscale-keyring.list" |
      sudo tee /etc/apt/sources.list.d/tailscale.list >/dev/null
    sudo apt-get update -qq
    apt_install tailscale
    sudo systemctl enable --now tailscaled >/dev/null 2>&1 || true
  fi
  ok "$(tailscale version | head -n1)"
  if [ "$(tailscale_field state)" != Running ]; then
    echo "    Open the login URL below in a browser and approve this machine."
    if [ -n "$hostname" ]; then sudo tailscale up --hostname "$hostname"; else sudo tailscale up; fi
  fi
  [ "$(tailscale_field state)" = Running ] || die "Tailscale is not running; run 'sudo tailscale up', then run this script again"
  sudo tailscale set --operator="$USER"
  ok "signed in as $(tailscale_field name); $USER can run tailscale serve"
}

install_server() {
  step "stim-server $server_version"
  local installed=""
  if command -v stim-server >/dev/null; then installed="$(stim-server --version 2>/dev/null | head -n1 || true)"; fi
  if [ "$server_version" != latest ] && [ "$installed" = "$server_version" ]; then
    ok "stim-server $installed is already installed"
  else
    local sudo_npm=()
    [ -w "$(npm root -g)" ] || sudo_npm=(sudo env "PATH=$PATH")
    "${sudo_npm[@]}" npm install --global --no-fund --no-audit --update-notifier=false "@stim-cli/server@$server_version" >/dev/null
    hash -r
    ok "stim-server $(stim-server --version 2>/dev/null | head -n1 || true)"
  fi
  sudo loginctl enable-linger "$USER"
  ok "linger is on for $USER, so the service survives logout"
  local serve=()
  if [ "$tailscale_step" = 1 ]; then serve=(--serve); fi
  stim-server service install "${serve[@]}" \
    --env "JAVA_HOME=$JAVA_HOME_DIR" --env "ANDROID_HOME=$ANDROID_HOME_DIR"
  stim-server service status || warn "stim-server service status reported a problem; see the output above"
}

next_steps() {
  local name
  name="$(tailscale_field name)"
  [ -n "$name" ] || name="<this-machine-name>"
  cat <<EOF

==> Next steps, on your main machine

  1. Add this machine to remote.machines (a JSON array; keep existing entries):

       stim settings set remote.machines '["$name"]'

  2. Ask for build access. This prints a one-time setup command:

       stim doctor --fix

  3. Run that setup command here, on this machine. Add --yes to it when you
     run it over a non-interactive SSH session.

  4. Run 'stim doctor --fix' on your main machine again to finish the pairing,
     then try a build:

       stim android --remote-build $name --no-build-cache
EOF
  if [ "$emulator" = 1 ]; then
    echo
    echo "An emulator needs an x86_64 build. 16 GB of memory is tight for an emulator and a warm Gradle daemon; see the Linux worker docs."
  fi
}

preflight
install_base
install_node
install_jdk
install_android_sdk
if [ "$emulator" = 1 ]; then setup_kvm; fi
if [ "$tailscale_step" = 1 ]; then setup_tailscale; fi
if [ "$service_step" = 1 ]; then install_server; fi
if [ "$service_step" = 1 ] && [ "$tailscale_step" = 1 ]; then next_steps; fi
step "Done"
