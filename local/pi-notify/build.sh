#!/bin/bash
# Build pi-notify.app (ad-hoc signed) into ~/Applications/
# 仓库只留源码;产物是本机构建输出,不纳入 git。
# 注意:重新编译后 ad-hoc 重签可能重置通知权限,通知不弹时到系统设置重新允许 "pi"。
set -euo pipefail
cd "$(dirname "$0")"

DEST="$HOME/Applications/pi-notify.app"
mkdir -p "$DEST/Contents/MacOS"
swiftc -O -o "$DEST/Contents/MacOS/pi-notify" main.swift
cp Info.plist "$DEST/Contents/Info.plist"
codesign --force --sign - "$DEST"
echo "Built: $DEST"
