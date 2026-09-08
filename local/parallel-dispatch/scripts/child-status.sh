#!/usr/bin/env bash
# child-status.sh — 列出指定父 session 的所有子 session 及各自最新 assistant 消息
# 用法: child-status.sh <父session的ID或文件名片段>
# 依赖: jq

set -euo pipefail

parent="${1:?用法: child-status.sh <父session的ID或文件名片段>}"
sessions_dir="${PI_SESSIONS_DIR:-$HOME/.pi/agent/sessions}"

if ! command -v jq >/dev/null 2>&1; then
	echo "错误: 需要 jq (brew install jq)" >&2
	exit 1
fi

if [ ! -d "$sessions_dir" ]; then
	echo "错误: sessions 目录不存在: $sessions_dir" >&2
	exit 1
fi

# parentSession 字段存父文件的绝对路径，按片段匹配反查子 session
matches=$(grep -l "\"parentSession\":\"[^\"]*${parent}" "$sessions_dir"/*/*.jsonl 2>/dev/null || true)

if [ -z "$matches" ]; then
	echo "未找到 parentSession 匹配 '${parent}' 的子 session"
	exit 0
fi

for f in $matches; do
	# 取最后一条 session_info 的 name（若无命名则用文件名）
	name=$(grep '"type":"session_info"' "$f" | tail -1 | jq -r '.name // empty' 2>/dev/null || true)
	label="${name:-$(basename "$f")}"

	msg_count=$(grep -c '"type":"message"' "$f" || true)
	age=$(stat -f '%Sm' -t '%m-%d %H:%M' "$f" 2>/dev/null || stat -c '%y' "$f" 2>/dev/null | cut -d. -f1)

	echo "═══ ${label}  (${msg_count} msgs, ${age}) ═══"
	# 全文件流式过滤，取最后的 assistant 文本
	jq -r 'select(.type=="message" and .message.role=="assistant") | [.message.content[]? | select(.type=="text") | .text] | join("\n")' "$f" 2>/dev/null | tail -15
	echo
done
