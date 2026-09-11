#!/usr/bin/env bash
# child-status.sh — 列出当前项目下某分派组的所有子 session 及各自最新 assistant 消息
# 用法: child-status.sh <分派组名> [项目目录]
#   组名 = 父 session 名；子 session 命名为 <组名>-task<N>
#   项目目录默认当前目录（用于定位 ~/.pi/agent/sessions/ 下的项目 session 目录）
# 依赖: jq

set -euo pipefail

group="${1:?用法: child-status.sh <分派组名> [项目目录]}"
project_dir="${2:-$PWD}"
sessions_dir="${PI_SESSIONS_DIR:-$HOME/.pi/agent/sessions}"

if ! command -v jq >/dev/null 2>&1; then
	echo "错误: 需要 jq (brew install jq)" >&2
	exit 1
fi

# 符号链接解析为物理路径（与 pi 落盘行为一致，如 macOS /tmp → /private/tmp）
resolved=$(cd "$project_dir" 2>/dev/null && pwd -P) && project_dir="$resolved"

# 项目目录名规则与 pi SessionManager 一致:
# --<cwd 去掉开头斜杠、其余 / \ : 替换为 ->--
stripped="${project_dir#/}"
stripped="${stripped//[:\\]/-}"
stripped="${stripped//\//-}"
encoded="--${stripped}--"
project_sessions="$sessions_dir/$encoded"

if [ ! -d "$project_sessions" ]; then
	echo "错误: 项目 session 目录不存在: $project_sessions" >&2
	exit 1
fi

prefix="${group}-task"
found=0
for f in "$project_sessions"/*.jsonl; do
	[ -e "$f" ] || continue
	name=$(grep '"type":"session_info"' "$f" | tail -1 | jq -r '.name // empty' 2>/dev/null || true)
	# 精确前缀匹配 <组名>-task*，父 session 本身（组名无后缀）自然排除
	if [ -z "$name" ] || [ "${name#"$prefix"}" = "$name" ]; then
		continue
	fi
	found=1
	msg_count=$(grep -c '"type":"message"' "$f" || true)
	age=$(stat -f '%Sm' -t '%m-%d %H:%M' "$f" 2>/dev/null || stat -c '%y' "$f" 2>/dev/null | cut -d. -f1)

	echo "═══ ${name}  (${msg_count} msgs, ${age}) ═══"
	# 全文件流式过滤，取最后的 assistant 文本
	jq -r 'select(.type=="message" and .message.role=="assistant") | [.message.content[]? | select(.type=="text") | .text] | join("\n")' "$f" 2>/dev/null | tail -15
	echo
done

if [ "$found" -eq 0 ]; then
	echo "未找到组名 '${group}' 的子 session（子 session 应命名为 ${group}-task<N>）"
fi
