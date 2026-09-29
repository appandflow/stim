#!/bin/sh
set -eu
cd "$(dirname "$0")/.."

if [ "${1:-}" = --check ]; then
  exec xcrun swift-format lint --strict --parallel --recursive --configuration .swift-format Sources Tests
fi
exec xcrun swift-format format --in-place --parallel --recursive --configuration .swift-format Sources Tests
