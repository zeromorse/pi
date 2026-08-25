#!/usr/bin/env node
/**
 * pi-dashboard — 全局看板:扫描正在运行的 pi 进程与 ~/.pi/agent/sessions 会话文件,
 * 显示每个进程的当前状态(运行中 / 等待输入 / 最后回复摘要)。
 *
 * 用法:
 *   node pi-dashboard.mjs           单次输出
 *   node pi-dashboard.mjs -w        watch 模式,每 2s 刷新
 *   node pi-dashboard.mjs -w -n 5   watch 模式,每 5s 刷新
 *   node pi-dashboard.mjs --all     不依赖进程,列出最近 24h 内有活动的所有会话
 *   node pi-dashboard.mjs --all --hours 72
 *
 * 原理:
 *   1. ps + lsof 找到所有 pi 进程及其工作目录
 *   2. 每个工作目录对应 ~/.pi/agent/sessions/--编码路径--/ 下 mtime 最新的 .jsonl
 *   3. 读该文件尾部,按最后一条会话 entry 判定状态:
 *      - 最后是 user 消息 / toolResult / 带 toolCall 的 assistant → 运行中
 *      - 最后是纯文本 assistant → 等待输入(已回复,等你)
 *   零依赖,只用 Node 内置模块。
 */

import { execFileSync } from "node:child_process";
import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const SESSIONS_DIR = join(homedir(), ".pi/agent/sessions");
const TAIL_BYTES = 64 * 1024;
const HEAD_BYTES = 32 * 1024;
const STALE_RUNNING_SEC = 300; // 运行中但超过 5 分钟无写入 → 视为疑似卡死/已退出
const LONG_WAIT_SEC = 600; // 等待输入超过 10 分钟 → 红色高亮

// ---------- 进程发现 ----------

function findPiProcesses() {
	let out;
	try {
		out = execFileSync("ps", ["-axo", "pid=,comm="], {
			encoding: "utf8",
			maxBuffer: 16 * 1024 * 1024,
		});
	} catch {
		return [];
	}
	const pids = [];
	for (const line of out.split("\n")) {
		const m = line.trim().match(/^(\d+)\s+(\S+)/);
		if (m && basename(m[2]) === "pi") pids.push(m[1]);
	}
	if (pids.length === 0) return [];
	const cwdByPid = new Map();
	try {
		const lsof = execFileSync("lsof", ["-w", "-a", "-d", "cwd", "-p", pids.join(",")], {
			encoding: "utf8",
			maxBuffer: 16 * 1024 * 1024,
		});
		for (const line of lsof.split("\n").slice(1)) {
			const cols = line.trim().split(/\s+/);
			if (cols.length >= 2 && /^\d+$/.test(cols[1])) cwdByPid.set(cols[1], cols[cols.length - 1]);
		}
	} catch {
		// lsof 失败则只知道 pid,不知道 cwd
	}
	return pids.map((pid) => ({ pid, cwd: cwdByPid.get(pid) ?? null }));
}

function cwdToSessionDir(cwd) {
	// /Users/x/agent/pi -> --Users-x-agent-pi--
	return join(SESSIONS_DIR, `--${cwd.replace(/^\//, "").split("/").join("-")}--`);
}

function activeSessionFiles(dir, k) {
	// 同工程多 session:取 mtime 最新的 k 个(k = 进程数),
	// 外加所有仍在写入(5 分钟内有 mtime 更新)的文件
	let files;
	try {
		files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
	} catch {
		return [];
	}
	const withMtime = [];
	for (const f of files) {
		try {
			withMtime.push({ path: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs });
		} catch {}
	}
	withMtime.sort((a, b) => b.mtime - a.mtime);
	const cutoff = Date.now() - STALE_RUNNING_SEC * 1000;
	const picked = [];
	for (const f of withMtime) {
		if (picked.length < k || f.mtime >= cutoff) picked.push(f);
		else break;
	}
	return picked.map((x) => x.path);
}

// ---------- 会话文件解析 ----------

function readSlice(path, start, length) {
	const st = statSync(path);
	if (start >= st.size) return "";
	const len = Math.min(length, st.size - start);
	const fd = openSync(path, "r");
	try {
		const buf = Buffer.alloc(len);
		readSync(fd, buf, 0, len, start);
		return buf.toString("utf8");
	} finally {
		closeSync(fd);
	}
}

function readTailEntries(path) {
	const st = statSync(path);
	const text = readSlice(path, Math.max(0, st.size - TAIL_BYTES), TAIL_BYTES);
	const lines = text.split("\n");
	if (st.size > TAIL_BYTES && lines.length > 0) lines.shift(); // 丢弃不完整首行
	const entries = [];
	for (const line of lines) {
		if (!line) continue;
		try {
			entries.push(JSON.parse(line));
		} catch {}
	}
	return entries;
}

function textOfContent(content) {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((c) => c?.type === "text" && typeof c.text === "string")
			.map((c) => c.text)
			.join(" ");
	}
	return "";
}

function firstLine(s) {
	s = String(s ?? "").trim();
	const i = s.indexOf("\n");
	if (i >= 0) s = s.slice(0, i);
	return s.replace(/^#+\s*/, "").replace(/[*`_]/g, "").trim();
}

function toolCallDetail(tc) {
	const a = tc.arguments ?? {};
	switch (tc.name) {
		case "bash":
			return `bash: ${firstLine(a.command)}`;
		case "read":
		case "edit":
		case "write":
			return `${tc.name}: ${basename(String(a.path ?? ""))}`;
		default:
			return tc.name;
	}
}

const CONV_TYPES = new Set(["message", "compaction", "branch_summary", "custom_message"]);

function analyzeSession(path) {
	const entries = readTailEntries(path);
	// header 总在文件第一行;大文件尾部读不到,单独读头部
	let header = null;
	try {
		for (const line of readSlice(path, 0, 4096).split("\n")) {
			if (!line) continue;
			try {
				const e = JSON.parse(line);
				if (e?.type === "session") header = e;
			} catch {}
		}
	} catch {}

	// 会话名:尾部找最近的 session_info;找不到再读文件头取首条 user 消息
	let name = null;
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i]?.type === "session_info" && entries[i].name) {
			name = entries[i].name;
			break;
		}
	}
	let firstUser = null;
	if (!name) {
		try {
			const head = readSlice(path, 0, HEAD_BYTES);
			for (const line of head.split("\n")) {
				if (!line) continue;
				try {
					const e = JSON.parse(line);
					if (e?.type === "message" && e.message?.role === "user") {
						const t = firstLine(textOfContent(e.message.content));
						if (!t) continue;
						// 跳过 skill/XML 注入类首消息,取可读的那条
						if (!firstUser || firstUser.startsWith("<")) firstUser = t;
						if (!t.startsWith("<")) break;
					}
				} catch {}
			}
		} catch {}
	}

	// 最后一条会话 entry
	let lastConv = null;
	for (let i = entries.length - 1; i >= 0; i--) {
		if (CONV_TYPES.has(entries[i]?.type)) {
			lastConv = entries[i];
			break;
		}
	}

	// 当前工具调用(运行中显示)
	let currentTool = null;
	for (let i = entries.length - 1; i >= 0 && !currentTool; i--) {
		const e = entries[i];
		if (e?.type !== "message" || e.message?.role !== "assistant") continue;
		const tcs = (e.message.content ?? []).filter((c) => c?.type === "toolCall");
		if (tcs.length > 0) currentTool = tcs[tcs.length - 1];
	}

	const now = Date.now();
	let status = "empty";
	let detail = "";
	let ts = null;

	if (!lastConv) {
		// 空会话(只有 header),用文件 mtime
		try {
			ts = statSync(path).mtimeMs;
		} catch {}
		status = "idle";
	} else {
		ts = Date.parse(lastConv.timestamp) || null;
		const msg = lastConv.message;
		const role = msg?.role;
		if (role === "user") {
			status = "running";
			detail = `>> ${firstLine(textOfContent(msg.content))}`;
		} else if (role === "toolResult") {
			status = "running";
			detail = currentTool ? toolCallDetail(currentTool) : "…";
		} else if (role === "assistant") {
			const hasToolCall = (msg.content ?? []).some((c) => c?.type === "toolCall");
			if (hasToolCall && msg.stopReason === "toolUse") {
				status = "running";
				detail = currentTool ? toolCallDetail(currentTool) : "…";
			} else if (msg.stopReason === "error") {
				status = "error";
				detail = firstLine(textOfContent(msg.content)) || firstLine(msg.errorMessage) || "error";
			} else {
				status = "waiting";
				detail = firstLine(textOfContent(msg.content));
			}
		} else if (role === "bashExecution") {
			status = "waiting";
			detail = `! ${firstLine(msg.command)}`;
		} else if (lastConv.type === "compaction") {
			status = "waiting";
			detail = "compaction done";
		} else if (lastConv.type === "branch_summary") {
			status = "waiting";
			detail = "branch summary";
		} else {
			status = "waiting";
		}
	}

	const ageSec = ts ? Math.max(0, (now - ts) / 1000) : null;
	if (status === "running" && ageSec !== null && ageSec > STALE_RUNNING_SEC) {
		status = "stalled";
	}

	// 详情视图用的完整数据(从尾部往前找)
	let lastReply = null;
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		if (e?.type !== "message" || e.message?.role !== "assistant") continue;
		const texts = (e.message.content ?? []).filter((c) => c?.type === "text" && c.text);
		if (texts.length > 0) {
			lastReply = texts.map((c) => c.text).join("\n\n");
			break;
		}
	}
	let lastUser = null;
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		if (e?.type === "message" && e.message?.role === "user") {
			lastUser = textOfContent(e.message.content);
			break;
		}
	}
	let model = null;
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i]?.type === "model_change") {
			model = `${entries[i].provider}/${entries[i].modelId}`;
			break;
		}
	}

	return {
		file: path,
		cwd: header?.cwd ?? null,
		sessionId: header?.id ?? null,
		name: name || firstUser,
		status,
		detail,
		ageSec,
		model,
		stopReason: lastConv?.type === "message" ? (lastConv.message?.stopReason ?? null) : null,
		lastReply,
		lastUser,
		toolCall: currentTool ? { name: currentTool.name, arguments: currentTool.arguments } : null,
	};
}

// ---------- 渲染 ----------

const ANSI = {
	reset: "\x1b[0m",
	dim: "\x1b[2m",
	bold: "\x1b[1m",
	red: "\x1b[31m",
	yellow: "\x1b[33m",
	magenta: "\x1b[35m",
	cyan: "\x1b[36m",
};

function dispWidth(s) {
	let w = 0;
	for (const ch of s) {
		const c = ch.codePointAt(0);
		w +=
			c >= 0x1100 &&
			(c <= 0x115f ||
				c === 0x2329 ||
				c === 0x232a ||
				(c >= 0x2e80 && c <= 0xa4cf) ||
				(c >= 0xac00 && c <= 0xd7a3) ||
				(c >= 0xf900 && c <= 0xfaff) ||
				(c >= 0xfe30 && c <= 0xfe4f) ||
				(c >= 0xff00 && c <= 0xff60) ||
				(c >= 0xffe0 && c <= 0xffe6) ||
				(c >= 0x20000 && c <= 0x2fffd) ||
				(c >= 0x30000 && c <= 0x3fffd))
				? 2
				: 1;
	}
	return w;
}

function truncate(s, w) {
	if (dispWidth(s) <= w) return s;
	let out = "";
	let ow = 0;
	for (const ch of s) {
		const cw = dispWidth(ch);
		if (ow + cw > w - 1) break;
		out += ch;
		ow += cw;
	}
	return out + "…";
}

function pad(s, w) {
	const d = w - dispWidth(s);
	return d > 0 ? s + " ".repeat(d) : s;
}

function fmtAge(sec) {
	if (sec === null) return "-";
	if (sec < 60) return `${Math.floor(sec)}s`;
	if (sec < 3600) return `${Math.floor(sec / 60)}m`;
	return `${Math.floor(sec / 3600)}h${Math.floor((sec % 3600) / 60)}m`;
}

function statusLabel(row) {
	switch (row.status) {
		case "running":
			return "RUNNING";
		case "waiting":
			return "WAITING";
		case "stalled":
			return "STALLED";
		case "error":
			return "ERROR";
		default:
			return "IDLE";
	}
}

function statusColor(row) {
	switch (row.status) {
		case "running":
			return ANSI.cyan;
		case "waiting":
			return row.ageSec !== null && row.ageSec > LONG_WAIT_SEC ? ANSI.red : ANSI.yellow;
		case "stalled":
			return ANSI.magenta;
		case "error":
			return ANSI.red;
		default:
			return ANSI.dim;
	}
}

const ORDER = { running: 0, stalled: 1, error: 2, waiting: 3, idle: 4, empty: 4 };

function sortRows(rows) {
	rows.sort((a, b) => {
		const d = (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9);
		if (d !== 0) return d;
		// 同状态内按项目分组,组内按等待时长降序
		if (a.cwd !== b.cwd) return (a.cwd ?? "") < (b.cwd ?? "") ? -1 : 1;
		return (b.ageSec ?? 0) - (a.ageSec ?? 0);
	});
}

function buildLines(rows, meta, selectedFile) {
	const cols = process.stdout.columns || 120;
	const lines = [];
	const now = new Date();
	lines.push(
		`${ANSI.bold}pi dashboard${ANSI.reset}${ANSI.dim}  ${now.toLocaleTimeString()}  |  ${meta.desc}${ANSI.reset}`,
	);
	if (rows.length === 0) {
		lines.push(`${ANSI.dim}(no sessions)${ANSI.reset}`);
		lines.push(`${ANSI.dim}q 退出${ANSI.reset}`);
		return lines;
	}
	sortRows(rows);

	// 列宽分档:宽终端给 PROJECT/SESSION 更多空间,DETAIL 拿剩余
	const W_STAT = 8;
	const W_AGE = 6;
	const total = Math.max(80, cols) - 2 - 4 - W_STAT - W_AGE; // marker + 4 个列间空格
	let W_PROJ;
	let W_SESS;
	if (total >= 200) {
		W_PROJ = 26;
		W_SESS = 36;
	} else if (total >= 150) {
		W_PROJ = 22;
		W_SESS = 30;
	} else if (total >= 110) {
		W_PROJ = 18;
		W_SESS = 24;
	} else {
		W_PROJ = 14;
		W_SESS = 18;
	}
	let W_DET = total - W_PROJ - W_SESS;
	if (W_DET < 24) {
		W_DET = 24;
		W_SESS = Math.max(12, total - W_PROJ - W_DET);
		if (W_PROJ + W_SESS + W_DET > total) W_PROJ = Math.max(10, total - W_SESS - W_DET);
	}
	const head =
		"  " +
		pad("PROJECT", W_PROJ) +
		" " +
		pad("SESSION", W_SESS) +
		" " +
		pad("STATUS", W_STAT) +
		" " +
		pad("DETAIL", W_DET) +
		" " +
		pad("AGE", W_AGE);
	lines.push(`${ANSI.dim}${head}${ANSI.reset}`);
	lines.push(ANSI.dim + "  " + "-".repeat(dispWidth(head) - 2) + ANSI.reset);

	for (const row of rows) {
		const sel = selectedFile !== null && selectedFile !== undefined && row.file === selectedFile;
		const marker = sel ? `${ANSI.bold}> ${ANSI.reset}` : "  ";
		const proj = truncate(basename(row.cwd ?? "") || row.file, W_PROJ);
		const sess = truncate(row.name ?? basename(row.file), W_SESS);
		const det = truncate(row.detail ?? "", W_DET);
		const age = pad(fmtAge(row.ageSec), W_AGE);
		const stat = statusLabel(row);
		const color = statusColor(row);
		lines.push(
			marker +
				(sel ? ANSI.bold : "") +
				pad(proj, W_PROJ) +
				(sel ? ANSI.reset : "") +
				" " +
				pad(sess, W_SESS) +
				" " +
				color +
				pad(stat, W_STAT) +
				ANSI.reset +
				" " +
				pad(det, W_DET) +
				" " +
				ANSI.dim +
				age +
				ANSI.reset,
		);
	}

	const counts = { running: 0, waiting: 0, stalled: 0, error: 0 };
	for (const r of rows) if (counts[r.status] !== undefined) counts[r.status]++;
	lines.push("");
	lines.push(
		`${ANSI.dim}${meta.procs} proc(s), ${meta.cwds} project(s): ${ANSI.reset}` +
			`${ANSI.cyan}${counts.running} running${ANSI.reset}${ANSI.dim}, ${ANSI.reset}` +
			`${ANSI.yellow}${counts.waiting} waiting${ANSI.reset}` +
			(counts.stalled ? `${ANSI.dim},${ANSI.reset}${ANSI.magenta} ${counts.stalled} stalled${ANSI.reset}` : "") +
			(counts.error ? `${ANSI.dim},${ANSI.reset}${ANSI.red} ${counts.error} error${ANSI.reset}` : ""),
	);
	lines.push(
		`${ANSI.dim}↑↓/jk 选择 · Enter/e 展开 · q/Ctrl+C 退出${ANSI.reset}`,
	);
	return lines;
}

function statusText(row) {
	const label = statusLabel(row);
	const color = statusColor(row);
	let t = label;
	if (row.status === "running" || row.status === "stalled") t += ` ${fmtAge(row.ageSec)}`;
	else if (row.status === "waiting" || row.status === "error") t += ` — 已等待 ${fmtAge(row.ageSec)}`;
	if (row.stopReason && row.stopReason !== "stop" && row.stopReason !== "toolUse") t += ` (stop: ${row.stopReason})`;
	return `${color}${t}${ANSI.reset}`;
}

function indentBlock(text, cols, maxLines) {
	const out = [];
	for (const raw of String(text ?? "").split("\n")) {
		if (out.length >= maxLines) {
			out.push(`${ANSI.dim}  … (truncated)${ANSI.reset}`);
			break;
		}
		out.push(`  ${truncate(raw, cols - 4)}`);
	}
	return out;
}

function toolCallBlock(tc, cols) {
	if (!tc) return [];
	const a = tc.arguments ?? {};
	let body;
	if (tc.name === "bash" && typeof a.command === "string") body = a.command;
	else body = JSON.stringify(a, null, 2);
	return [`${ANSI.bold}  ${tc.name}${ANSI.reset}`, ...indentBlock(body, cols, 50)];
}

// 返回 { lines, maxScroll }:lines 含标题与信息区,body 为可滚动内容
function buildDetailLines(row) {
	const cols = process.stdout.columns || 120;
	const lines = [];
	lines.push(
		`${ANSI.bold}pi dashboard${ANSI.reset}${ANSI.dim} — session detail (Esc/q 返回)${ANSI.reset}`,
	);
	const info = [
		["状态", statusText(row)],
		["项目", row.cwd ?? "-"],
		["会话", row.name ?? "-"],
		["模型", row.model ?? "-"],
		["文件", String(row.file).replace(homedir(), "~")],
	];
	for (const [k, v] of info) {
		lines.push(`${ANSI.dim}${pad(k, 4)}${ANSI.reset} ${truncate(String(v), cols - 8)}`);
	}
	// 信息区与正文区分隔线(填满整行)
	lines.push(ANSI.dim + "─".repeat(Math.max(20, cols - 1)) + ANSI.reset);

	const body = [];
	if (row.status === "running" || row.status === "stalled") {
		if (row.lastUser) {
			body.push(`${ANSI.bold}── 当前任务 ──${ANSI.reset}`);
			body.push(...indentBlock(row.lastUser, cols, 30));
			body.push("");
		}
		if (row.toolCall) {
			body.push(`${ANSI.bold}── 当前工具调用 ──${ANSI.reset}`);
			body.push(...toolCallBlock(row.toolCall, cols));
			body.push("");
		}
	}
	if (row.lastReply) {
		body.push(`${ANSI.bold}── 最后回复 ──${ANSI.reset}`);
		body.push(...indentBlock(row.lastReply, cols, 500));
		body.push("");
	}
	if (row.status !== "running" && row.status !== "stalled" && row.lastUser) {
		body.push(`${ANSI.bold}── 最后用户消息 ──${ANSI.reset}`);
		body.push(...indentBlock(row.lastUser, cols, 30));
		body.push("");
	}
	if (body.length === 0) body.push(`${ANSI.dim}  (无内容)${ANSI.reset}`);
	lines.push(...body);
	return { lines, bodyCount: body.length };
}

// ---------- 主流程 ----------

function collectActive() {
	const procs = findPiProcesses();
	const byCwd = new Map();
	for (const p of procs) {
		if (!p.cwd) continue;
		if (!byCwd.has(p.cwd)) byCwd.set(p.cwd, []);
		byCwd.get(p.cwd).push(p.pid);
	}
	const rows = [];
	for (const [cwd, pids] of byCwd) {
		const k = Math.max(1, pids.length);
		const files = activeSessionFiles(cwdToSessionDir(cwd), k);
		if (files.length === 0) {
			rows.push({ file: "(no session file)", cwd, name: null, status: "idle", detail: "", ageSec: null });
			continue;
		}
		for (const f of files) {
			rows.push(analyzeSession(f));
		}
	}
	// 有 pid 但 lsof 没拿到 cwd 的进程,单独提示
	const orphan = procs.filter((p) => !p.cwd).length;
	return { rows, procs: procs.length, cwds: byCwd.size, orphan };
}

function collectAll(hours) {
	const cutoff = Date.now() - hours * 3600 * 1000;
	let dirs;
	try {
		dirs = readdirSync(SESSIONS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory());
	} catch {
		return { rows: [], procs: 0, cwds: 0, orphan: 0 };
	}
	const rows = [];
	for (const d of dirs) {
		const dir = join(SESSIONS_DIR, d.name);
		let files;
		try {
			files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
		} catch {
			continue;
		}
		for (const f of files) {
			const p = join(dir, f);
			try {
				if (statSync(p).mtimeMs < cutoff) continue;
			} catch {
				continue;
			}
			try {
				rows.push(analyzeSession(p));
			} catch {}
		}
	}
	// 防刷屏:保留最近活动的 50 个
	rows.sort((a, b) => (b.ageSec ?? 0) - (a.ageSec ?? 0));
	const limited = rows.slice(0, 50);
	return { rows: limited, procs: findPiProcesses().length, cwds: new Set(limited.map((r) => r.cwd)).size, orphan: 0 };
}

const args = process.argv.slice(2);
let watch = false;
let interval = 2;
let all = false;
let hours = 24;
for (let i = 0; i < args.length; i++) {
	const a = args[i];
	if (a === "-w" || a === "--watch") watch = true;
	else if (a === "-n" || a === "--interval") interval = Math.max(1, parseInt(args[++i], 10) || 2);
	else if (a === "--all") all = true;
	else if (a === "--hours") hours = Math.max(1, parseFloat(args[++i]) || 24);
}

function collect() {
	let data;
	let desc;
	if (all) {
		data = collectAll(hours);
		desc = `all sessions active within ${hours}h`;
	} else {
		data = collectActive();
		desc = "live processes";
	}
	if (data.orphan > 0) desc += ` (${data.orphan} proc without cwd)`;
	return { rows: data.rows, meta: { desc, procs: data.procs, cwds: data.cwds } };
}

function tick() {
	const { rows, meta } = collect();
	return buildLines(rows, meta, null);
}

if (!watch) {
	process.stdout.write(tick().join("\n") + "\n");
} else {
	// 隐藏光标,首次清屏一次;后续增量重绘不再清屏,避免闪烁
	process.stdout.write("\x1b[?25l\x1b[H\x1b[2J");
	const state = {
		mode: "list", // list | detail
		rows: [],
		meta: { desc: "", procs: 0, cwds: 0 },
		selected: 0,
		selectedFile: null,
		scroll: 0,
		maxScroll: 0,
	};
	let prevCount = 0;
	const cleanup = () => {
		clearEscTimer();
		if (process.stdin.isTTY) {
			try {
				process.stdin.setRawMode(false);
			} catch {}
		}
		process.stdout.write("\x1b[?2026l\x1b[?25h\n");
		process.exit(0);
	};
	process.on("SIGINT", cleanup);
	process.on("SIGTERM", cleanup);

	const pageSize = () => Math.max(5, (process.stdout.rows || 40) - 10);

	const buildFrame = () => {
		if (state.mode === "detail") {
			const row = state.rows[state.selected];
			if (row) {
				const { lines, bodyCount } = buildDetailLines(row);
				const window = (process.stdout.rows || 40) - 2; // 标题 1 行 + 底部提示 1 行
			const visibleBody = Math.max(1, window - (lines.length - bodyCount));
			state.maxScroll = Math.max(0, bodyCount - visibleBody);
			state.scroll = Math.max(0, Math.min(state.scroll, state.maxScroll));
			const head = lines.slice(0, lines.length - bodyCount);
			const body = lines.slice(lines.length - bodyCount);
			return [
				...head,
				...body.slice(state.scroll, state.scroll + visibleBody),
				`${ANSI.dim}↑↓/jk 滚动 · PgUp/PgDn 翻页 · g/G 首/尾 · Esc/q 返回 · Ctrl+C 退出${ANSI.reset}`,
			];
			// eslint-disable-next-line no-unreachable
		}
		}
		return buildLines(state.rows, state.meta, state.selectedFile);
	};

	const draw = () => {
		let lines = buildFrame();
		// 超出终端高度时截断,防止滚动导致重绘错位
		const maxLines = (process.stdout.rows || 40) - 1;
		let overflow = 0;
		if (lines.length > maxLines) {
			overflow = lines.length - maxLines;
			lines = [...lines.slice(0, maxLines - 1), `${ANSI.dim}… ${overflow} more line(s), widen terminal${ANSI.reset}`];
		}
		// 同步输出(2026)整帧绘制,不支持的终端会忽略该序列
		let frame = "\x1b[?2026h\x1b[H" + lines.map((l) => `${l}\x1b[K`).join("\n");
		if (prevCount > lines.length) frame += "\x1b[J"; // 本次行数变少,清掉残留
		frame += "\x1b[?2026l";
		process.stdout.write(frame);
		prevCount = lines.length;
	};

	// 按键移动后:仅按索引 clamp 并同步 selectedFile(不按 file 找回)
	const syncSelection = () => {
		if (state.rows.length === 0) {
			state.selected = 0;
			state.selectedFile = null;
			return;
		}
		state.selected = Math.max(0, Math.min(state.selected, state.rows.length - 1));
		state.selectedFile = state.rows[state.selected]?.file ?? null;
	};

	// 数据刷新后:按 selectedFile 记忆找回(显示顺序可能变化),再 clamp
	const restoreSelection = () => {
		if (state.rows.length === 0) {
			state.selected = 0;
			state.selectedFile = null;
			return;
		}
		if (state.selectedFile !== null) {
			const idx = state.rows.findIndex((r) => r.file === state.selectedFile);
			if (idx >= 0) state.selected = idx;
		}
		syncSelection();
	};

	const refresh = () => {
		const { rows, meta } = collect();
		sortRows(rows);
		state.rows = rows;
		state.meta = meta;
		restoreSelection();
		draw();
	};

	if (process.stdin.isTTY) process.stdin.setRawMode(true);
	process.stdin.resume();

	// 单键处理,返回是否需要重绘
	const handleKey = (key) => {
		if (key === "\x03") {
			cleanup();
			return false;
		}
		if (state.mode === "list") {
			switch (key) {
				case "\x1b[A":
				case "k":
					state.selected--;
					return true;
				case "\x1b[B":
				case "j":
					state.selected++;
					return true;
				case "g":
					state.selected = 0;
					return true;
				case "G":
					state.selected = state.rows.length - 1;
					return true;
				case "\r":
				case "e":
				case " ":
					if (state.rows.length > 0) {
						state.mode = "detail";
						state.scroll = 0;
						return true;
					}
					return false;
				case "q":
					cleanup();
					return false;
				default:
					return false; // 无关按键,不重绘
			}
		} else {
			switch (key) {
				case "\x1b":
				case "q":
					state.mode = "list";
					return true;
				case "\x1b[A":
				case "k":
					state.scroll--;
					return true;
				case "\x1b[B":
				case "j":
					state.scroll++;
					return true;
				case "\x1b[5~":
					state.scroll -= pageSize();
					return true;
				case "\x1b[6~":
					state.scroll += pageSize();
					return true;
				case "g":
					state.scroll = 0;
					return true;
				case "G":
					state.scroll = state.maxScroll;
					return true;
				default:
					return false; // 无关按键,不重绘
			}
		}
	};

	// 键盘输入:转义序列可能拆成多个 data chunk(\x1b 与 [B 分开到达),
	// 需要组装缓冲;超时(100ms)未续完则当作单独 Esc
	let escBuf = null;
	let escTimer = null;

	const clearEscTimer = () => {
		if (escTimer) {
			clearTimeout(escTimer);
			escTimer = null;
		}
	};

	const dispatch = (key) => {
		if (handleKey(key)) {
			syncSelection();
			state.scroll = Math.max(0, state.scroll);
			draw();
		}
	};

	const flushEsc = () => {
		const buf = escBuf;
		escBuf = null;
		clearEscTimer();
		if (buf === null) return;
		dispatch("\x1b");
		for (const ch of buf.slice(1)) dispatch(ch);
	};

	const feedChar = (ch) => {
		if (escBuf === null) {
			if (ch === "\x1b") {
				escBuf = "\x1b";
				clearEscTimer();
				escTimer = setTimeout(flushEsc, 100);
			} else {
				dispatch(ch);
			}
			return;
		}
		// 正在组装转义序列
		clearEscTimer();
		escBuf += ch;
		const buf = escBuf;
		if (buf.length === 2 && buf[1] !== "[" && buf[1] !== "O") {
			// Esc + 普通字符(Alt 组合):拆成 Esc 和该字符分别处理
			escBuf = null;
			dispatch("\x1b");
			dispatch(ch);
			return;
		}
		if (buf.length === 3 && buf[1] === "O") {
			// SS3 形式方向键(应用光标模式):\x1bOA/B 归一化为 CSI
			escBuf = null;
			if (ch === "A" || ch === "B") dispatch(`\x1b[${ch}`);
			return;
		}
		if (buf.length >= 3 && buf[1] === "[") {
			const code = ch.charCodeAt(0);
			if (code >= 64 && code <= 126) {
				// CSI 终结:解析参数,忽略修饰符(Shift+方向等同方向)
				escBuf = null;
				const m = buf.match(/^\x1b\[([0-9;]*)(.)$/);
				if (m) {
					const fin = m[2];
					if (fin === "A" || fin === "B") dispatch(`\x1b[${fin}`);
					else if (fin === "~" && m[1] === "5") dispatch("\x1b[5~");
					else if (fin === "~" && m[1] === "6") dispatch("\x1b[6~");
					// 其他 CSI 序列忽略
				}
				return;
			}
		}
		escTimer = setTimeout(flushEsc, 100);
	};

	process.stdin.on("data", (buf) => {
		for (const ch of buf.toString("utf8")) feedChar(ch);
	});

	refresh();
	setInterval(refresh, interval * 1000);
}
