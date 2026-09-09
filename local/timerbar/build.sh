#!/bin/bash
# Build TimerBar.app (ad-hoc signed) into ./build/
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p build/TimerBar.app/Contents/MacOS
swiftc -O -o build/TimerBar.app/Contents/MacOS/TimerBar main.swift
cp Info.plist build/TimerBar.app/Contents/Info.plist
codesign --force --sign - build/TimerBar.app
echo "Built: $(pwd)/build/TimerBar.app"
