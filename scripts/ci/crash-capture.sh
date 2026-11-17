#!/usr/bin/env bash
# Native crash capture for the Linux Node 24 test job (issue 5791).
#   enable            set kernel.core_pattern and record the Node build
#   report            print a backtrace of every core file, write crash-report/
#   loop N SCOPE      repeat the integration suite N times, stop at the first core
# The caller raises the core size limit with `ulimit -c unlimited` in the shell
# that runs the tests; a limit does not survive into another step.
set -uo pipefail

CORE_DIR=/var/tmp/stim-cores
OUT_DIR="${CRASH_REPORT_DIR:-crash-report}"

cmd=${1:-}
shift || true

case "$cmd" in
  enable)
    sudo mkdir -p "$CORE_DIR"
    sudo chmod 1777 "$CORE_DIR"
    sudo sysctl -w kernel.core_pattern="$CORE_DIR/core.%e.%p.%t" || echo "core_pattern not set"
    echo "core_pattern: $(cat /proc/sys/kernel/core_pattern)"
    echo "hard core limit: $(ulimit -Hc)"
    mkdir -p "$OUT_DIR"
    node -p "JSON.stringify({version: process.version, execPath: process.execPath, versions: process.versions, release: process.release}, null, 2)" > "$OUT_DIR/node.json"
    ;;
  report)
    mkdir -p "$OUT_DIR"
    cores=$(find "$CORE_DIR" -maxdepth 1 -name 'core.*' 2>/dev/null)
    {
      echo "kernel segfault lines:"
      sudo dmesg 2>/dev/null | grep -iE 'segfault|general protection|core dumped' | tail -n 20
    } > "$OUT_DIR/dmesg.txt" 2>&1
    if [ -z "$cores" ]; then
      echo "No core files in $CORE_DIR."
      cat "$OUT_DIR/dmesg.txt"
      exit 0
    fi
    node_bin=$(node -p process.execPath)
    {
      echo "node: $("$node_bin" -v) at $node_bin"
      uname -a
      ls -l $cores
      grep -h 'Worker exited unexpectedly' "$OUT_DIR"/*.log 2>/dev/null
    } > "$OUT_DIR/meta.txt" 2>&1
    sudo apt-get install -y --no-install-recommends gdb > "$OUT_DIR/apt.log" 2>&1 || { echo "gdb install failed"; tail -n 20 "$OUT_DIR/apt.log"; }
    for core in $cores; do
      {
        echo "=== $core"
        gdb -batch -nx \
          -ex 'set pagination off' \
          -ex 'info threads' \
          -ex 'thread apply all bt' \
          -ex 'info sharedlibrary' \
          "$node_bin" "$core" 2>&1
      } > "$OUT_DIR/backtrace-$(basename "$core").txt"
    done
    echo "crashed=true" >> "${GITHUB_OUTPUT:-/dev/null}"
    cat "$OUT_DIR"/meta.txt "$OUT_DIR"/dmesg.txt
    head -n 80 "$OUT_DIR"/backtrace-*.txt
    {
      echo "### Native crash captured"
      echo '```'
      head -n 60 "$OUT_DIR"/backtrace-*.txt
      echo '```'
    } >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
    ;;
  loop)
    iterations=${1:-20}
    scope=${2:-stimd}
    deadline=$((SECONDS + 33 * 60))
    mkdir -p "$OUT_DIR"
    filters=()
    if [ "$scope" = stimd ]; then
      filters=(stimd-log-stream stimd.integration stimd-log-worker-crash stimd-windows-stream-stop)
    fi
    ulimit -c unlimited
    for i in $(seq 1 "$iterations"); do
      echo "::group::iteration $i"
      pnpm run test:integration "${filters[@]}" 2>&1 | tee "$OUT_DIR/loop-$i.log"
      status=${PIPESTATUS[0]}
      echo "::endgroup::"
      echo "iteration $i exit $status"
      if find "$CORE_DIR" -maxdepth 1 -name 'core.*' 2>/dev/null | grep -q .; then
        echo "core file found after iteration $i"
        exit 1
      fi
      if grep -q 'exited unexpectedly with signal' "$OUT_DIR/loop-$i.log"; then
        echo "worker died after iteration $i without a core file"
        exit 1
      fi
      if [ "$SECONDS" -gt "$deadline" ]; then
        echo "time budget used after $i iterations"
        break
      fi
    done
    ;;
  *)
    echo "usage: crash-capture.sh enable|report|loop" >&2
    exit 2
    ;;
esac
