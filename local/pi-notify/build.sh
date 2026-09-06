#!/bin/bash
# Build pi-notify.app (ad-hoc signed) into ./build/
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p build/pi-notify.app/Contents/MacOS
swiftc -O -o build/pi-notify.app/Contents/MacOS/pi-notify main.swift
cp Info.plist build/pi-notify.app/Contents/Info.plist
codesign --force --sign - build/pi-notify.app
echo "Built: $(pwd)/build/pi-notify.app"
