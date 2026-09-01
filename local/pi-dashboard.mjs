#!/usr/bin/env node
/**
 * pi-dashboard — 全局看板:扫描正在运行的 pi 进程与 ~/.pi/agent/sessions 会话文件,
 * 显示每个进程的当前状态(运行中 / 等待输入 / 最后回复摘要)。
 *
 * 用法:
 *   node pi-dashboard.mjs           单次输出
 *   node pi-dashboard.mjs -w        watch 模式,每 2s 刷新;会话完成/出错/卡死时发 macOS 通知
 *                                 (安装 terminal-notifier 后点击通知可跳回 dashboard 所在终端:
 *                                  激活宿主 app;tmux 内精确切回 dashboard 的 window/pane)
 *
 * watch 按键: ↑↓/jk 选择 · Enter/e 详情 · t 跳转终端 · x 停止会话进程(二次确认) · q 退出
 *   node pi-dashboard.mjs -w -n 5   watch 模式,每 5s 刷新
 *   node pi-dashboard.mjs --all     不依赖进程,列出最近 24h 内有活动的所有会话
 *   node pi-dashboard.mjs --all --hours 72
 *   node pi-dashboard.mjs --no-notify  关闭 watch 模式的系统通知
 *   node pi-dashboard.mjs --demo     渲染一段样例 markdown,预览详情视图高亮配色
 *
 * 原理:
 *   1. ps + lsof 找到所有 pi 进程及其工作目录
 *   2. 每个工作目录对应 ~/.pi/agent/sessions/--编码路径--/ 下 mtime 最新的 .jsonl
 *   3. 读该文件尾部,按最后一条会话 entry 判定状态:
 *      - 最后是 user 消息 / toolResult / 带 toolCall 的 assistant → 运行中
 *      - 最后是纯文本 assistant → 等待输入(已回复,等你)
 *   4. 每个进程沿 ppid 链识别所在终端(tty / tmux pane / 宿主 app 如 VS Code),
 *      并按"会话文件创建时间 <= 进程启动时间 + 5s 的最新文件"把进程与会话行配对
 *   零依赖,只用 Node 内置模块。
 */

import { execFileSync } from "node:child_process";
import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const SESSIONS_DIR = join(homedir(), ".pi/agent/sessions");
const TAIL_BYTES = 64 * 1024;
const HEAD_BYTES = 32 * 1024;
const STALE_RUNNING_SEC = 300; // 运行中但超过 5 分钟无写入 → 视为疑似卡死/已退出
const LONG_WAIT_SEC = 600; // 等待输入超过 10 分钟 → 红色高亮

// ---------- 进程发现 ----------

const APP_SHORT_NAMES = {
	"Visual Studio Code": "VS Code",
	iTerm2: "iTerm",
	"IntelliJ IDEA": "IDEA",
};

function parseEtime(s) {
	// ps etime: [dd-]hh:mm:ss | mm:ss | ss
	let days = 0;
	let rest = s;
	const d = s.indexOf("-");
	if (d >= 0) {
		days = parseInt(s.slice(0, d), 10) || 0;
		rest = s.slice(d + 1);
	}
	const parts = rest.split(":").map((x) => parseInt(x, 10) || 0);
	let sec = 0;
	if (parts.length === 3) sec = parts[0] * 3600 + parts[1] * 60 + parts[2];
	else if (parts.length === 2) sec = parts[0] * 60 + parts[1];
	else sec = parts[0];
	return days * 86400 + sec;
}

function appNameFromComm(comm) {
	// /Applications/Visual Studio Code.app/Contents/MacOS/Code Helper -> "Visual Studio Code"
	// 返回完整 app 名(open -a 可用);简称映射仅用于展示
	const m = comm.match(/([^/]+)\.app\//);
	return m ? m[1] : null;
}

function tmuxPaneMap() {
	// pane 顶层进程 pid -> tmux 位置;tmux 不存在时返回空 Map
	const m = new Map();
	try {
		const out = execFileSync(
			"tmux",
			["list-panes", "-a", "-F", "#{pane_pid}\t#{session_name}\t#{window_index}\t#{pane_index}"],
			{ encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
		);
		for (const line of out.split("\n")) {
			const c = line.split("\t");
			if (c.length >= 4 && /^\d+$/.test(c[0])) m.set(c[0], { session: c[1], window: c[2], pane: c[3] });
		}
	} catch {}
	return m;
}

function terminalInfo(rec, table, panes) {
	// 沿 ppid 链向上识别: tmux pane / 宿主终端 app / ssh
	let tmuxPane = null;
	let inTmux = false;
	let app = null;
	let appPath = null;
	let ssh = false;
	let cur = rec;
	for (let i = 0; i < 24 && cur; i++) {
		if (tmuxPane === null && panes.has(cur.pid)) tmuxPane = panes.get(cur.pid);
		const base = basename(cur.comm);
		if (!inTmux && base === "tmux") inTmux = true;
		if (!app) app = appNameFromComm(cur.comm);
		if (!appPath) {
			// 最外层 .app 根目录(非贪婪,避免嵌套 bundle 如 Code Helper.app)
			const m = cur.comm.match(/^(.+?\.app)\//);
			if (m) appPath = m[1];
		}
		if (!ssh && base === "sshd") ssh = true;
		const ppid = parseInt(cur.ppid, 10);
		if (!Number.isFinite(ppid) || ppid <= 1) break;
		cur = table.get(String(ppid));
	}
	return { tty: rec.tty, app, appPath, ssh, tmux: tmuxPane ?? (inTmux ? true : null) };
}

function psAll() {
	// 一次 ps 拿全表(pid/ppid/tty/etime/comm),并筛出 pi 进程
	let out;
	try {
		out = execFileSync("ps", ["-axo", "pid=,ppid=,tty=,etime=,comm="], {
			encoding: "utf8",
			maxBuffer: 16 * 1024 * 1024,
		});
	} catch {
		return { table: new Map(), piRecs: [] };
	}
	const table = new Map();
	const piRecs = [];
	for (const line of out.split("\n")) {
		const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+)$/);
		if (!m) continue;
		const rec = { pid: m[1], ppid: m[2], tty: m[3] === "??" ? null : m[3], etime: m[4], comm: m[5] };
		table.set(rec.pid, rec);
		if (basename(rec.comm) === "pi") piRecs.push(rec);
	}
	return { table, piRecs };
}

function findPiProcesses() {
	const { table, piRecs } = psAll();
	if (piRecs.length === 0) return [];
	const cwdByPid = new Map();
	try {
		const lsof = execFileSync("lsof", ["-w", "-a", "-d", "cwd", "-p", piRecs.map((r) => r.pid).join(",")], {
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
	const panes = tmuxPaneMap();
	const now = Date.now();
	return piRecs.map((rec) => ({
		pid: rec.pid,
		cwd: cwdByPid.get(rec.pid) ?? null,
		startMs: now - parseEtime(rec.etime) * 1000,
		term: terminalInfo(rec, table, panes),
	}));
}

function cwdToSessionDir(cwd) {
	// /Users/x/agent/pi -> --Users-x-agent-pi--
	return join(SESSIONS_DIR, `--${cwd.replace(/^\//, "").split("/").join("-")}--`);
}

function sessionFileCreateMs(name) {
	// 2026-08-25T03-00-42-840Z_<uuid>.jsonl -> UTC ms;文件名不带时间则返回 null
	const m = name.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/);
	if (!m) return null;
	return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]);
}

function listSessionFiles(dir) {
	// 按 mtime 降序列出全部会话文件;createMs 取文件名里的创建时间,解析失败退回 mtime
	let files;
	try {
		files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
	} catch {
		return [];
	}
	const out = [];
	for (const f of files) {
		const path = join(dir, f);
		try {
			const st = statSync(path);
			out.push({ path, mtimeMs: st.mtimeMs, createMs: sessionFileCreateMs(f) ?? st.mtimeMs });
		} catch {}
	}
	out.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return out;
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

// 详情视图 markdown 配色,对齐 pi 消息区默认主题(dark.json 的 md* token)
const MD = {
	heading: (t) => `\x1b[1;38;5;179m${t}\x1b[0m`, // #f0c674
	link: (t) => `\x1b[38;5;110;4m${t}\x1b[24;38;5;110m`, // #81a2be + 下划线
	linkUrl: (t) => `\x1b[38;5;245m${t}\x1b[0m`,
	code: (t) => `\x1b[38;5;109m${t}\x1b[0m`, // accent #8abeb7
	codeBlock: (t) => `\x1b[38;5;71m${t}\x1b[0m`, // green
	codeBlockBorder: (t) => `\x1b[38;5;245m${t}\x1b[0m`, // gray
	quote: (t) => `\x1b[38;5;245m${t}\x1b[0m`,
	listBullet: (t) => `\x1b[38;5;109m${t}\x1b[0m`,
	bold: (t) => `\x1b[1m${t}\x1b[22m`,
	italic: (t) => `\x1b[3m${t}\x1b[23m`,
	hr: (t) => `\x1b[38;5;245m${t}\x1b[0m`,
	// 代码块内轻量语法高亮
	kw: (t) => `\x1b[38;5;140m${t}\x1b[0m`,
	str: (t) => `\x1b[38;5;150m${t}\x1b[0m`,
	num: (t) => `\x1b[38;5;179m${t}\x1b[0m`,
	cmt: (t) => `\x1b[38;5;245;3m${t}\x1b[0m`,
};

const MD_KEYWORDS = new Set([
	// js/ts
	"const", "let", "var", "function", "return", "if", "else", "for", "while", "do", "switch",
	"case", "break", "continue", "class", "extends", "new", "import", "export", "from", "as",
	"async", "await", "try", "catch", "finally", "throw", "typeof", "interface", "type", "enum",
	"null", "undefined", "true", "false", "this", "super", "static", "default", "of", "in",
	// shell
	"echo", "export", "set", "local", "if", "then", "fi", "else", "elif", "for", "do", "done",
	"while", "function", "return", "case", "esac", "source",
	// python
	"def", "lambda", "print", "pass", "with", "yield", "not", "and", "or", "None", "True", "False",
	// git / 通用
	"git", "npm", "node", "npx",
]);

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
				(c >= 0x30000 && c <= 0x3fffd) ||
				(c >= 0x1f000 && c <= 0x1faff) || // emoji 区,终端占 2 列
				(c >= 0x2600 && c <= 0x27bf) || // 杂项符号: ✅ ✱ 等
				(c >= 0x2b00 && c <= 0x2bff) || // ⭐ ⚡ 等
				(c >= 0x23e9 && c <= 0x23fa)) // ⏸ ⏱ 等
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

// ANSI 感能版:跳过转义序列计宽,截断时不切断序列,行尾补 reset
function truncateAnsi(s, w) {
	let out = "";
	let vis = 0;
	let hasStyle = false;
	let i = 0;
	while (i < s.length) {
		if (s[i] === "\x1b") {
			const m = /^\x1b\[[0-9;?]*[A-Za-z]/.exec(s.slice(i));
			if (m) {
				out += m[0];
				hasStyle = true;
				i += m[0].length;
				continue;
			}
		}
		const ch = s[i];
		const cw = dispWidth(ch);
		if (vis + cw > w - 1) return out + "…" + (hasStyle ? ANSI.reset : "");
		out += ch;
		vis += cw;
		i++;
	}
	return out;
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

function fmtTokens(n) {
	if (n === null || n === undefined) return "-";
	if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
	if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
	return String(n);
}

function fmtCost(usd) {
	if (usd === null || usd === undefined) return "-";
	return `$${usd < 1 ? usd.toFixed(3) : usd.toFixed(2)}`;
}

function termLabel(row) {
	// 列表用的短标签
	const t = row?.term;
	if (!t) return "-";
	if (t.tmux) return t.tmux === true ? "tmux" : `tmux:${t.tmux.session}`;
	if (t.app) return APP_SHORT_NAMES[t.app] ?? t.app;
	if (t.ssh) return "ssh";
	return t.tty ?? "-";
}

function termDetail(row) {
	const t = row?.term;
	if (!t) return "-";
	const parts = [];
	if (t.tmux) parts.push(t.tmux === true ? "tmux" : `tmux ${t.tmux.session}:${t.tmux.window}.${t.tmux.pane}`);
	if (t.app) parts.push(APP_SHORT_NAMES[t.app] ?? t.app);
	if (t.ssh) parts.push("ssh");
	if (t.tty) parts.push(t.tty);
	return parts.length > 0 ? parts.join(" · ") : "-";
}

// 跳转到选中会话所在终端;返回结果消息(显示在 footer 上方)
function jumpToTerminal(row) {
	const t = row?.term;
	if (!t) return "无终端信息(仅 live 模式可跳转)";
	if (t.tmux) {
		if (t.tmux === true) return "在 tmux 内但 pane 未知(tmux 命令不可用),无法跳转";
		if (!process.env.TMUX) return "dashboard 不在 tmux 内,switch-client 不可用";
		const target = `${t.tmux.session}:${t.tmux.window}.${t.tmux.pane}`;
		try {
			execFileSync("tmux", ["switch-client", "-t", target]);
			return `已跳转 → ${target}`;
		} catch {
			return `跳转失败: tmux switch-client -t ${target}`;
		}
	}
	if (t.app) {
		try {
			execFileSync("open", ["-a", t.app]);
			return `已激活 ${APP_SHORT_NAMES[t.app] ?? t.app}(无法定位具体窗口)`;
		} catch {
			return `跳转失败: open -a ${t.app}`;
		}
	}
	return "该会话在纯 tty/ssh,无法跳转";
}

// 停止选中会话的 pi 进程(只杀进程,不改会话文件;tmux 下保留 pane/shell)
function stopSession(row) {
	const pid = row?.pid;
	if (!pid) return "无进程信息(仅 live 模式可停止)";
	try {
		process.kill(pid, 0); // 存在性检查
	} catch {
		return `进程 ${pid} 已退出`;
	}
	const sig = row.status === "stalled" ? "SIGKILL" : "SIGTERM";
	try {
		process.kill(pid, sig);
		return `已发送 ${sig} → pid ${pid} (${basename(row.cwd ?? "") || "pi"})`;
	} catch {
		return `停止失败: kill -${sig === "SIGKILL" ? 9 : 15} ${pid}`;
	}
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

function buildLines(rows, meta, selectedFile, notice) {
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
	const W_TERM = 10; // VS Code / IDEA / tmux:xx / ttys005
	const W_AGE = 8; // 最长如 122h59m 为 7 字符,留余量
	// 额外 -2 安全余量:个别字符宽度误差(emoji 变体等)不致末列折行
	const total = Math.max(80, cols) - 2 - 5 - W_STAT - W_TERM - W_AGE - 2; // marker + 5 个列间空格
	let W_PROJ;
	let W_SESS;
	if (total >= 200) {
		W_PROJ = 26;
		W_SESS = 34;
	} else if (total >= 150) {
		W_PROJ = 22;
		W_SESS = 28;
	} else if (total >= 110) {
		W_PROJ = 18;
		W_SESS = 22;
	} else {
		W_PROJ = 14;
		W_SESS = 16;
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
		pad("TERM", W_TERM) +
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
		const term = truncate(termLabel(row), W_TERM);
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
				pad(term, W_TERM) +
				ANSI.reset +
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
		if (notice) lines.push(`${ANSI.dim}  ${notice}${ANSI.reset}`);
	lines.push(
		`${ANSI.dim}↑↓/jk 选择 · Enter/e 展开 · t 跳转终端 · x 停止 · q/Ctrl+C 退出${ANSI.reset}`,
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

// ---------- 详情视图 markdown 高亮(轻量版,模仿 pi 消息区) ----------

const CODE_TOKEN_RE =
	/(\/\/[^\n]*|#[^\n]*|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\b\d[\d._]*\b|[A-Za-z_$][\w$]*)/g;

function highlightCodeLine(line, codePrefix) {
	// 轻量语法高亮: 注释/字符串/数字/关键字;其余为代码底色。
	// 连续的普通段合并后一次性加前缀,避免冗余转义序列。
	let out = "";
	let plainBuf = "";
	let last = 0;
	const flushPlain = () => {
		if (plainBuf) {
			out += codePrefix + plainBuf;
			plainBuf = "";
		}
	};
	for (const m of line.matchAll(CODE_TOKEN_RE)) {
		const tok = m[0];
		const idx = m.index ?? 0;
		// "//" 前是 ":" 时是 URL,不算注释
		const isComment = (tok.startsWith("//") && line[idx - 1] !== ":") || tok.startsWith("#");
		plainBuf += line.slice(last, idx);
		if (isComment) {
			flushPlain();
			out += MD.cmt(tok);
		} else if (/^["'`]/.test(tok)) {
			flushPlain();
			out += MD.str(tok);
		} else if (/^\d/.test(tok)) {
			flushPlain();
			out += MD.num(tok);
		} else if (MD_KEYWORDS.has(tok)) {
			flushPlain();
			out += MD.kw(tok);
		} else {
			plainBuf += tok; // 普通标识符并入普通段,避免冗余前缀
		}
		last = idx + tok.length;
	}
	plainBuf += line.slice(last);
	flushPlain();
	return out;
}

// 代码块: 围栏 + 缩进 + 逐行高亮,返回已含样式的行数组
function renderCodeBlock(code, lang) {
	const codePrefix = "\x1b[38;5;71m";
	const lines = [MD.codeBlockBorder(`\`\`\`${lang || ""}`)];
	for (const raw of code.split("\n")) {
		lines.push(`  ${highlightCodeLine(raw.replace(/\t/g, "   ").trimEnd(), codePrefix)}`);
	}
	lines.push(MD.codeBlockBorder("```"));
	return lines;
}

const INLINE_RE = /(\*\*([^*]+)\*\*|\*([^\s*][^*]*?)\*|`([^`\n]+)`|\[([^\]\n]+)\]\(([^)\s]+)\))/g;

// 行内 markdown: 粗体/斜体/行内代码/链接。basePrefix 用于嵌套样式后恢复外层颜色。
function renderInline(text, basePrefix) {
	const plain = (t) => (basePrefix ? `${basePrefix}${t}` : t);
	let out = "";
	let last = 0;
	for (const m of text.matchAll(INLINE_RE)) {
		const idx = m.index ?? 0;
		out += plain(text.slice(last, idx));
		if (m[2] !== undefined) out += MD.bold(renderInline(m[2], "")) + (basePrefix ? ANSI.reset + basePrefix : "");
		else if (m[3] !== undefined) out += MD.italic(m[3]) + (basePrefix ? ANSI.reset + basePrefix : "");
		else if (m[4] !== undefined) out += MD.code(m[4]) + (basePrefix ? ANSI.reset + basePrefix : "");
		else if (m[5] !== undefined)
			out += MD.link(m[5]) + MD.linkUrl(` (${m[6]})`) + (basePrefix ? ANSI.reset + basePrefix : "");
		last = idx + m[0].length;
	}
	out += plain(text.slice(last));
	return out;
}

// 块级 markdown → 已含 ANSI 的行数组(不含统一缩进,由 indentLines 补)
function renderMarkdown(text) {
	const lines = String(text ?? "").split("\n");
	const out = [];
	let inFence = false;
	let fenceLang = "";
	let fenceBuf = [];
	const flushFence = () => {
		if (fenceBuf.length > 0) out.push(...renderCodeBlock(fenceBuf.join("\n"), fenceLang));
		else out.push(MD.codeBlockBorder(`\`\`\`${fenceLang}`), MD.codeBlockBorder("```"));
		fenceBuf = [];
	};
	for (const raw of lines) {
		const line = raw.replace(/\t/g, "   ");
		const fence = /^\s*(`{3,}|~{3,})\s*(\S*)/.exec(line);
		if (fence) {
			if (!inFence) {
				inFence = true;
				fenceLang = fence[2] || "";
				fenceBuf = [];
			} else {
				inFence = false;
				flushFence();
			}
			continue;
		}
		if (inFence) {
			fenceBuf.push(raw);
			continue;
		}
		if (line.trim() === "") {
			out.push("");
			continue;
		}
		const heading = /^(#{1,6})\s+(.*)$/.exec(line);
		if (heading) {
			const depth = heading[1].length;
			const prefix = depth >= 3 ? `${"#".repeat(depth)} ` : "";
			const body = renderInline(heading[2].trim(), "");
			out.push(MD.heading(prefix + body));
			continue;
		}
		const hr = /^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.exec(line);
		if (hr) {
			out.push(MD.hr("─".repeat(48)));
			continue;
		}
		const quote = /^ {0,3}>\s?(.*)$/.exec(line);
		if (quote) {
			const content = renderInline(quote[1].trim(), "");
			out.push(`${MD.codeBlockBorder("│ ")}${MD.italic(content)}`);
			continue;
		}
		const list = /^ {0,3}([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(line);
		if (list) {
			const marker = `${list[1]} `;
			const indent = " ".repeat(raw.length - raw.trimStart().length);
			out.push(`${indent}${MD.listBullet(marker)}${renderInline(list[2], "")}`);
			continue;
		}
		out.push(renderInline(line, ""));
	}
	if (inFence) flushFence(); // 未闭合的围栏(流式中)
	return out;
}

// 已含 ANSI 的行数组 → 加统一缩进 + 截断 + 行数上限
function indentLines(lines, cols, maxLines) {
	const out = [];
	for (const raw of lines) {
		if (out.length >= maxLines) {
			out.push(`${ANSI.dim}  … (truncated)${ANSI.reset}`);
			break;
		}
		out.push(`  ${truncateAnsi(raw, cols - 4)}`);
	}
	return out;
}

function toolCallBlock(tc) {
	if (!tc) return [];
	const a = tc.arguments ?? {};
	const code =
		tc.name === "bash" && typeof a.command === "string" ? a.command : JSON.stringify(a, null, 2);
	return [
		`${ANSI.bold}  ${tc.name}${ANSI.reset}`,
		...renderCodeBlock(code, tc.name === "bash" ? "bash" : "json"),
	];
}

// ---------- macOS 通知 ----------

function appleQuote(s) {
	return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// terminal-notifier 路径检测(缓存);支持点击通知时激活 app/执行命令
let notifierCmdCache;
function terminalNotifierPath() {
	if (notifierCmdCache !== undefined) return notifierCmdCache;
	notifierCmdCache = null;
	try {
		const out = execFileSync("sh", ["-c", "command -v terminal-notifier"], { encoding: "utf8" });
		if (out.trim()) notifierCmdCache = out.trim();
	} catch {}
	return notifierCmdCache;
}

// app 根目录(如 /Applications/Visual Studio Code.app) -> bundle id(如 com.microsoft.VSCode)
const bundleIdCache = new Map();
function bundleIdForApp(appPath) {
	if (bundleIdCache.has(appPath)) return bundleIdCache.get(appPath);
	let id = null;
	try {
		id = execFileSync("plutil", ["-extract", "CFBundleIdentifier", "raw", `${appPath}/Contents/Info.plist`], {
			encoding: "utf8",
		})
			.trim();
	} catch {}
	if (!id || !/^[a-zA-Z0-9.-]+$/.test(id)) id = null;
	bundleIdCache.set(appPath, id);
	return id;
}

// dashboard 自身所在终端的信息(点击通知后跳回这里)
let selfTerm = null;
function computeSelfTerm() {
	try {
		const { table } = psAll();
		const rec = table.get(String(process.pid));
		if (!rec) return null;
		const info = terminalInfo(rec, table, tmuxPaneMap());
		return {
			bundleId: info.appPath ? bundleIdForApp(info.appPath) : null,
			clientTty: rec.tty, // tmux client 标识(switch-client -c 用)
			tmuxPane: info.tmux && info.tmux !== true ? info.tmux : null,
		};
	} catch {
		return null;
	}
}

function notifyUser(title, body, group) {
	// 仅 darwin;失败静默(通知被拒绝/命令缺失不影响主流程)
	if (process.platform !== "darwin") return;
	const cmd = terminalNotifierPath();
	if (cmd) {
		const args = ["-title", title, "-message", body, "-group", group ?? "pi-dashboard"];
		// 点击通知:激活 dashboard 所在宿主 app;在 tmux 内再精确切回 dashboard 的 window/pane
		if (selfTerm?.bundleId) args.push("-activate", selfTerm.bundleId);
		if (selfTerm?.tmuxPane && selfTerm?.clientTty) {
			const p = selfTerm.tmuxPane;
			args.push(
				"-execute",
				`tmux switch-client -c ${selfTerm.clientTty} -t '${p.session}:${p.window}.${p.pane}'`,
		);
		}
		try {
			execFileSync(cmd, args);
			return;
		} catch {}
	}
	try {
		execFileSync("osascript", [
			"-e",
			`display notification "${appleQuote(body)}" with title "${appleQuote(title)}"`,
		]);
	} catch {}
}

// 会话用量统计:累计成本(全部 assistant 消息 cost.total 之和) + 当前上下文(最后一条 usage.totalTokens)
// 按 mtime 缓存,避免 watch 模式反复全量读大文件
const sessionStatsCache = new Map(); // file -> { mtimeMs, stats }

function sessionStats(path) {
	let st;
	try {
		st = statSync(path);
	} catch {
		return null;
	}
	const cached = sessionStatsCache.get(path);
	if (cached && cached.mtimeMs === st.mtimeMs) return cached.stats;
	let text;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return null;
	}
	let cost = 0;
	let ctxTokens = null;
	let replies = 0;
	for (const line of text.split("\n")) {
		if (!line) continue;
		try {
			const e = JSON.parse(line);
			if (e?.type !== "message" || e.message?.role !== "assistant") continue;
			const u = e.message.usage;
			if (!u) continue;
			replies++;
			if (typeof u.cost?.total === "number") cost += u.cost.total;
			if (typeof u.totalTokens === "number") ctxTokens = u.totalTokens;
		}
		catch {}
	}
	const stats = { cost, ctxTokens, replies };
	sessionStatsCache.set(path, { mtimeMs: st.mtimeMs, stats });
	return stats;
}

// 检测状态转变并发通知;维护 prevStatus 基线(首次 collect 只建基线不通知)
function detectTransitions(rows, prevStatus) {
	const seen = new Set();
	for (const row of rows) {
		seen.add(row.file);
		const was = prevStatus.get(row.file);
		prevStatus.set(row.file, row.status);
		if (was !== "running") continue;
		const proj = basename(row.cwd ?? "") || "pi";
		const name = row.name ?? basename(row.file);
		if (row.status === "waiting") notifyUser(`pi 已完成: ${proj}`, `${name} 已回复,等待输入`, row.file);
		else if (row.status === "error") notifyUser(`pi 出错: ${proj}`, truncate(`${name} ${row.detail ?? ""}`, 80), row.file);
		else if (row.status === "stalled") notifyUser(`pi 疑似卡死: ${proj}`, `${name} 超 5 分钟无输出`, row.file);
	}
	for (const key of [...prevStatus.keys()]) {
		if (!seen.has(key)) prevStatus.delete(key);
	}
}

// 返回 { lines, maxScroll }:lines 含标题与信息区,body 为可滚动内容
function buildDetailLines(row) {
	const cols = process.stdout.columns || 120;
	const lines = [];
	lines.push(
		`${ANSI.bold}pi dashboard${ANSI.reset}${ANSI.dim} — session detail (Esc/q 返回)${ANSI.reset}`,
	);
	const stats = sessionStats(row.file);
	const info = [
		["状态", statusText(row)],
		["项目", row.cwd ?? "-"],
		["会话", row.name ?? "-"],
		["模型", row.model ?? "-"],
		["上下文", stats ? `${fmtTokens(stats.ctxTokens)} tokens · ${stats.replies} 次回复` : "-"],
		["成本", stats ? `${fmtCost(stats.cost)} 累计` : "-"],
		["终端", termDetail(row)],
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
			body.push(...indentLines(renderMarkdown(row.lastUser), cols, 30));
			body.push("");
		}
		if (row.toolCall) {
			body.push(`${ANSI.bold}── 当前工具调用 ──${ANSI.reset}`);
			body.push(...toolCallBlock(row.toolCall));
			body.push("");
		}
	}
	if (row.lastReply) {
		body.push(`${ANSI.bold}── 最后回复 ──${ANSI.reset}`);
		body.push(...indentLines(renderMarkdown(row.lastReply), cols, 500));
		body.push("");
	}
	if (row.status !== "running" && row.status !== "stalled" && row.lastUser) {
		body.push(`${ANSI.bold}── 最后用户消息 ──${ANSI.reset}`);
		body.push(...indentLines(renderMarkdown(row.lastUser), cols, 30));
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
		byCwd.get(p.cwd).push(p);
	}
	const rows = [];
	for (const [cwd, cwdProcs] of byCwd) {
		const files = listSessionFiles(cwdToSessionDir(cwd));
		// 进程 <-> 会话文件配对:取"创建时间 <= 进程启动 + 5s"的最新文件
		// (新会话文件在进程启动后立刻创建;resume 时配到被继续的旧文件)。
		// 多进程按启动时间降序处理,更新的进程优先占用文件。
		const procByFile = new Map();
		for (const p of [...cwdProcs].sort((a, b) => b.startMs - a.startMs)) {
			const cand = files.find((f) => f.createMs <= p.startMs + 5000);
			if (cand && !procByFile.has(cand.path)) procByFile.set(cand.path, p);
		}
		// 显示哪些文件:
		// 1) 有活进程配对的必选(主依据,配对 = 文件创建时间 <= 进程启动+5s 的最新文件)
		// 2) 未配对进程各补一个 mtime 最新的未占用文件(配对失败时的兑底)
		// 3) 15 秒内仍在写入的文件兑底(进程刚启动/时钟误差)
		// 注意不用"mtime 前 k 个无条件入选":被 kill 的进程留下的文件 mtime 常仍是目录最新,
		// 会永久顶替活会话的行(已踩坑)。
		const chosen = new Set();
		for (const f of files) {
			if (procByFile.has(f.path)) chosen.add(f.path);
		}
		let unmatched = cwdProcs.length - procByFile.size;
		for (const f of files) {
			if (unmatched <= 0) break;
			if (chosen.has(f.path)) continue;
			chosen.add(f.path);
			unmatched--;
		}
		const freshCutoff = Date.now() - 15000;
		for (const f of files) {
			if (f.mtimeMs >= freshCutoff && !chosen.has(f.path)) chosen.add(f.path);
		}
		const picked = files.filter((f) => chosen.has(f.path));
		if (picked.length === 0) {
			rows.push({ file: "(no session file)", cwd, name: null, status: "idle", detail: "", ageSec: null, term: null });
			continue;
		}
		for (const f of picked) {
			const row = analyzeSession(f.path);
			row.term = procByFile.get(f.path)?.term ?? null;
			row.pid = procByFile.get(f.path)?.pid ?? null;
			rows.push(row);
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
let notifyEnabled = true;
for (let i = 0; i < args.length; i++) {
	const a = args[i];
	if (a === "-w" || a === "--watch") watch = true;
	else if (a === "-n" || a === "--interval") interval = Math.max(1, parseInt(args[++i], 10) || 2);
	else if (a === "--all") all = true;
	else if (a === "--hours") hours = Math.max(1, parseFloat(args[++i]) || 24);
	else if (a === "--no-notify") notifyEnabled = false;
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

if (args.includes("--demo")) {
	const demo = [
		"## 标题 Heading",
		"",
		"普通文本，含 **粗体**、*斜体*、`行内代码` 和 [链接](https://github.com)。",
		"",
		"- 列表项 one",
		"- 列表项 two，带 `code`",
		"1. 有序列表",
		"",
		"> 引用行:quote 内容灰色斜体",
		"> 第二行引用",
		"",
		"---",
		"",
		"```ts",
		"const name = \"pi\"; // 行注释",
		"function greet(who: string): number {",
		"\treturn who.length + 42;",
		"}",
		"```",
		"",
		"```bash",
		"# 查找 pi 进程",
		"ps -axo pid=,comm= | grep ' pi$' || echo 'not found'",
		"```",
		"",
		"未闭合围栏(流式中):",
		"```js",
		"const x = 1;",
	].join("\n");
	const cols = process.stdout.columns || 100;
	process.stdout.write(indentLines(renderMarkdown(demo), cols, 100).join("\n") + "\n");
	process.exit(0);
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
		notice: null, // { text, ts } 跳转等操作的结果提示
		prevStatus: new Map(), // file -> status,状态转变检测基线
		pendingKill: null, // { file, ts } x 键二次确认状态
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
		const notice = state.notice ? state.notice.text : null;
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
				const foot = [];
				if (notice) foot.push(`${ANSI.dim}  ${notice}${ANSI.reset}`);
				foot.push(
					`${ANSI.dim}↑↓/jk 滚动 · PgUp/PgDn 翻页 · g/G 首/尾 · t 跳转 · x 停止 · Esc/q 返回 · Ctrl+C 退出${ANSI.reset}`,
				);
				return [...head, ...body.slice(state.scroll, state.scroll + visibleBody), ...foot];
			}
		}
		return buildLines(state.rows, state.meta, state.selectedFile, notice);
	};

	const draw = () => {
		// 过期提示(10s)清除
		if (state.notice && Date.now() - state.notice.ts > 10000) state.notice = null;
		if (state.pendingKill && Date.now() - state.pendingKill.ts > 10000) state.pendingKill = null;
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
		if (notifyEnabled) detectTransitions(rows, state.prevStatus);
		sortRows(rows);
		state.rows = rows;
		state.meta = meta;
		restoreSelection();
		draw();
	};

	// 计算自身终端信息(点击通知跳回用);失败不影响主流程
	selfTerm = computeSelfTerm();

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
				case "t": {
					const row = state.rows[state.selected];
					if (row) state.notice = { text: jumpToTerminal(row), ts: Date.now() };
					return true;
				}
				case "x": {
					const row = state.rows[state.selected];
					if (!row) return false;
					const now = Date.now();
						if (state.pendingKill && state.pendingKill.file === row.file && now - state.pendingKill.ts <= 10000) {
							state.pendingKill = null;
							state.notice = { text: stopSession(row), ts: now };
						} else if (row.pid) {
							state.pendingKill = { file: row.file, ts: now };
							const label = truncate(`${basename(row.cwd ?? "") || "pi"} / ${row.name ?? basename(row.file)}`, 60);
							state.notice = { text: `停止 pid=${row.pid} (${label})? 再按 x 确认`, ts: now };
						} else {
							state.notice = { text: stopSession(row), ts: now };
						}
					return true;
				}
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
				case "t": {
					const row = state.rows[state.selected];
					if (row) state.notice = { text: jumpToTerminal(row), ts: Date.now() };
					return true;
				}
				case "x": {
					const row = state.rows[state.selected];
					if (!row) return false;
					const now = Date.now();
						if (state.pendingKill && state.pendingKill.file === row.file && now - state.pendingKill.ts <= 10000) {
							state.pendingKill = null;
							state.notice = { text: stopSession(row), ts: now };
						} else if (row.pid) {
							state.pendingKill = { file: row.file, ts: now };
							const label = truncate(`${basename(row.cwd ?? "") || "pi"} / ${row.name ?? basename(row.file)}`, 60);
							state.notice = { text: `停止 pid=${row.pid} (${label})? 再按 x 确认`, ts: now };
						} else {
							state.notice = { text: stopSession(row), ts: now };
						}
					return true;
				}
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
