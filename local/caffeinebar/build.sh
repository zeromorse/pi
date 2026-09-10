#!/bin/bash
# Build CaffeineBar.app (ad-hoc signed) into ~/Applications/
# 仓库只留源码;产物是本机构建输出,不纳入 git。
set -euo pipefail
cd "$(dirname "$0")"

DEST="$HOME/Applications/CaffeineBar.app"
mkdir -p "$DEST/Contents/MacOS"
swiftc -O -o "$DEST/Contents/MacOS/CaffeineBar" main.swift
cp Info.plist "$DEST/Contents/Info.plist"
codesign --force --sign - "$DEST"
echo "Built: $DEST"
