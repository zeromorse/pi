#!/usr/bin/env node
/**
 * pi-dashboard — 全局看板:扫描正在运行的 pi 进程与 ~/.pi/agent/sessions 会话文件,
 * 显示每个进程的当前状态(运行中 / 等待输入 / 最后回复摘要)。
 *
 * 用法:
 *   node pi-dashboard.mjs           单次输出(末尾附带定时任务摘要)
 *   node pi-dashboard.mjs -w        watch 模式,每 2s 刷新;会话完成/出错/卡死时发 macOS 通知
 *                                 (安装 terminal-notifier 后点击通知可跳回 dashboard 所在终端:
 *                                  激活宿主 app;tmux 内精确切回 dashboard 的 window/pane)
 *
 * watch 按键: ↑↓/jk 选择 · Enter/e 详情 · t 跳转终端 · x 停止会话进程(二次确认) · c 定时任务 · q 退出
 *   node pi-dashboard.mjs -w -n 5   watch 模式,每 5s 刷新
 *   node pi-dashboard.mjs --all     不依赖进程,列出最近 24h 内有活动的所有会话
 *   node pi-dashboard.mjs --all --hours 72
 *   node pi-dashboard.mjs --no-notify  关闭 watch 模式的系统通知
 *   node pi-dashboard.mjs --demo     渲染一段样例 markdown,预览详情视图高亮配色
 *   node pi-dashboard.mjs --cron    只看定时任务视图(pi 相关的 launchd/cron)
 *
 * 原理:
 *   1. ps + lsof 找到所有 pi 进程及其工作目录
 *   2. 每个工作目录对应 ~/.pi/agent/sessions/--编码路径--/ 下 mtime 最新的 .jsonl
 *   3. 读该文件尾部,按最后一条会话 entry 判定状态:
 *      - 最后是 user 消息 / toolResult / 带 toolCall 的 assistant → 运行中
 *      - 最后是纯文本 assistant → 等待输入(已回复,等你)
 *   4. 每个进程沿 ppid 链识别所在终端(tty / tmux pane / 宿主 app 如 VS Code),
 *      并把进程与会话行配对:
 *      - 第 0 轮(精确): 扩展 pid-registry.ts 在每次 session_start 时写
 *        <agentDir>/runtime/<pid>.json = {pid,file,ts},直接按 pid 配对;
 *        注册缺失(扩展未装/老进程)回退启发式。死 pid 的注册文件顺手清理。
 *      - 第 1 轮(新会话): |文件创建时间 - 进程启动| <= 5s 强绑定
 *      - 第 2 轮(resume): 文件创建早于进程启动 + 5s,且进程启动后(容差 5s)
 *        写入过(在续写);取 mtime 最新。已知局限: 进程 resume 后长期零写入
 *        时 mtime 停留旧值,而死会话可能因重名(session_info)mtime 很新 → 错配,
 *        这正是第 0 轮注册表要解决的。
 *   零依赖,只用 Node 内置模块。
 */

import { execFileSync } from "node:child_process";
import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const SESSIONS_DIR = join(homedir(), ".pi/agent/sessions");
const RUNTIME_DIR = join(homedir(), ".pi/agent/runtime");
const LAUNCHAGENTS_DIR = join(homedir(), "Library/LaunchAgents");
const TAIL_BYTES = 64 * 1024;
const HEAD_BYTES = 32 * 1024;
const STALE_RUNNING_SEC = 300; // 运行中但超过 5 分钟无写入 → 视为疑似卡死/已退出
const LONG_WAIT_SEC = 600; // 等待输入超过 10 分钟 → 红色高亮

// ---------- 定时任务(pi 相关的 launchd / cron) ----------

// 独立的 pi 词(前后非字母数字下划线),不会误匹配 pilot/pin 等
const PI_WORD_RE = /(^|[^A-Za-z0-9_])pi([^A-Za-z0-9_]|$)/;
// 日志行首时间戳: 2026-09-07 10:00:03 或 [2026-09-07 16:10:22]
const LOG_TS_RE = /^\[?(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\]?/;
const DOW_CN = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
// 命令含 match 子串的 cron 任务显式指定证据日志(命令行无重定向/需按 agent 过滤时);
// filter = 只保留含该子串的日志行(共享 cron.log 区分各 agent);尾部 exit=N / ERROR 行据此判定上次运行结果
const FRONTIER_CRON_LOG = "~/catpaw-desk-workspace/frontier-radar/logs/agents/cron.log";
const CRON_EVIDENCE = [
	{ match: "cron_ccmp_cost.sh", logs: ["~/.ccmp/logs/cron.log"] },
	{ match: "run_agent.sh doctor", logs: [FRONTIER_CRON_LOG], filter: "agent=doctor" },
	{ match: "run_agent.sh engineer", logs: [FRONTIER_CRON_LOG], filter: "agent=engineer" },
	{ match: "run_agent.sh scout", logs: [FRONTIER_CRON_LOG], filter: "agent=scout" },
	{ match: "run_agent.sh curator", logs: [FRONTIER_CRON_LOG], filter: "agent=curator" },
	{ match: "run_agent.sh critic", logs: [FRONTIER_CRON_LOG], filter: "agent=critic" },
	{ match: "run_agent.sh planner", logs: [FRONTIER_CRON_LOG], filter: "agent=planner" },
];
const CRON_CACHE_SEC = 60; // crontab/plutil/launchctl 是外部命令,不值得每 2s 刷

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

// header 的 parentSession(fork 分支指向被 fork 的文件路径),按 mtime 缓存
const headerCache = new Map(); // path -> { mtimeMs, parent }
function headerParentOf(path, mtimeMs) {
	const c = headerCache.get(path);
	if (c && c.mtimeMs === mtimeMs) return c.parent;
	let parent = null;
	try {
		for (const line of readSlice(path, 0, 2048).split("\n")) {
			if (!line) continue;
			try {
				const e = JSON.parse(line);
				if (e?.type === "session") {
					parent = typeof e.parentSession === "string" ? e.parentSession : null;
					break;
				}
			} catch {}
		}
	} catch {}
	headerCache.set(path, { mtimeMs, parent });
	return parent;
}

function listSessionFiles(dir) {
	// 按 mtime 降序列出全部会话文件;createMs 取文件名里的创建时间,解析失败退回 mtime;
	// parent 取 header 的 parentSession(进程运行中 fork 的分支指向原文件,配对接管用)
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
			out.push({
				path,
				mtimeMs: st.mtimeMs,
				createMs: sessionFileCreateMs(f) ?? st.mtimeMs,
				parent: headerParentOf(path, st.mtimeMs),
			});
		} catch {}
	}
	out.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return out;
}

// ---------- pid 注册表 ----------

// 扩展 ~/.pi/agent/extensions/pid-registry.ts 在每次 session_start 时写
// <agentDir>/runtime/<pid>.json = {pid,file,ts};进程正常退出时自删,
// SIGKILL/崩溃残留由本函数按进程存活兜底清理。
// 纯启发式(mtime/createMs)无法区分"resume 后零写入的活会话"与"被重命名 touch 的死会话",
// 注册表提供进程侧的精确映射。
function readPidRegistry(startMsByPid) {
	// pid -> { file, ts }
	const reg = new Map();
	let names;
	try {
		names = readdirSync(RUNTIME_DIR);
	} catch {
		return reg;
	}
	for (const name of names) {
		if (!/^\d+\.json$/.test(name)) continue;
		const path = join(RUNTIME_DIR, name);
		let data = null;
		try {
			data = JSON.parse(readFileSync(path, "utf8"));
		} catch {}
		const pid = typeof data?.pid === "number" ? String(data.pid) : null;
		const startMs = pid ? startMsByPid.get(pid) : undefined;
		// pid 不在存活 pi 进程表(进程已死或被非 pi 进程复用),
		// 或注册时间早于该进程启动(pid 被新 pi 进程复用读到旧注册) → 陈旧,清理
		if (
			!pid ||
			startMs === undefined ||
			typeof data.file !== "string" ||
			typeof data.ts !== "number" ||
			data.ts < startMs - 5000
		) {
			try {
				unlinkSync(path);
			} catch {}
			continue;
		}
		reg.set(pid, { file: data.file, ts: data.ts });
	}
	return reg;
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

// ---------- 定时任务收集 ----------

// plist → JSON(plutil 为 macOS 自带);失败返回 null(stderr 静默,损坏 plist 不刷屏)
function parsePlist(path) {
	try {
		return JSON.parse(
			execFileSync("plutil", ["-convert", "json", "-o", "-", path], {
				encoding: "utf8",
				maxBuffer: 1024 * 1024,
				stdio: ["ignore", "pipe", "ignore"],
			}),
		);
	} catch {
		return null;
	}
}

function fileHeadText(path, bytes = 16 * 1024) {
	// 只读文本脚本头部;二进制/不存在返回 null
	if (!/\.(z?sh|bash)$/.test(path)) return null;
	try {
		return readSlice(path, 0, bytes);
	} catch {
		return null;
	}
}

// 命令行里的绝对路径 .sh 脚本 token(去掉引号)
function scriptTokens(cmd) {
	const out = [];
	for (const m of cmd.matchAll(/["']?([^\s;&|'"]+\.sh)\b/g)) {
		if (m[1].startsWith("/")) out.push(m[1]);
	}
	return out;
}

// launchctl list 全表 → label -> {pid, status}(status 为上次退出码,"-" 表示未记录)
function launchctlList() {
	const m = new Map();
	try {
		const out = execFileSync("launchctl", ["list"], {
			encoding: "utf8",
			maxBuffer: 4 * 1024 * 1024,
		});
		for (const line of out.split("\n").slice(1)) {
			const c = line.split("\t");
			if (c.length >= 3) m.set(c[2].trim(), { pid: c[0].trim(), status: c[1].trim() });
		}
	} catch {}
	return m;
}

// cron 5 字段 → 中文调度描述
function cronScheduleText(min, hour, dom, mon, dow) {
	if (min.startsWith("@")) return min; // @reboot / @daily 等
	const time = `${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
	if (dom === "*" && mon === "*") {
		if (dow === "*") return `每天 ${time}`;
		const days = dow
			.split(",")
			.map((d) => DOW_CN[+d % 7] ?? d)
			.join("");
		return `${days} ${time}`;
	}
	return `${min} ${hour} ${dom} ${mon} ${dow}`;
}

// cron 任务的证据日志: 显式配置优先(可带 filter 行过滤),否则解析命令里的 >> / > 重定向
// (相对路径按 cd 目录展开;2>&1 / /dev/null 忽略)
function evidenceLogsOfCron(cmd) {
	for (const ev of CRON_EVIDENCE) {
		if (cmd.includes(ev.match)) {
			return {
				logs: ev.logs.map((p) => p.replace(/^~(?=\/)/, homedir())),
				filter: ev.filter ?? null,
			};
		}
	}
	const logs = [];
	const cd = cmd.match(/(?:^|[;&]|&&|\s)cd\s+(\S+)/);
	const base = cd ? cd[1].replace(/[;)]$/, "") : null;
	const seen = new Set();
	for (const m of cmd.matchAll(/>>?\s*([^\s;&|)]+)/g)) {
		let p = m[1].replace(/^["']|["']$/g, "");
		if (!p || p === "&1" || p === "&2" || p === "/dev/null") continue;
		if (!p.startsWith("/")) {
			if (!base) continue;
			p = p.startsWith("./") ? join(base, p.slice(2)) : join(base, p);
		}
		if (!seen.has(p)) {
			seen.add(p);
			logs.push(p);
		}
	}
	return { logs, filter: null };
}

// 日志尾部 16KB: 最后一条时间戳行之后视为"最近一次运行"窗口,
// 窗口内 ERROR / exit=N>0 / FAILED 判定失败;无时间戳行时退回尾部 30 行;
// filter 非空时只保留含该子串的行(共享 cron.log 区分各 agent),过滤后无匹配则 empty
function analyzeJobLog(path, filter = null) {
	let st;
	try {
		st = statSync(path);
	} catch {
		return null;
	}
	const WIN = 16 * 1024;
	const text = readSlice(path, Math.max(0, st.size - WIN), WIN);
	let lines = text.split("\n");
	if (st.size > WIN && lines.length > 0) lines.shift(); // 丢弃不完整首行
	if (filter) lines = lines.filter((l) => l.includes(filter));
	if (lines.filter((l) => l.trim()).length === 0) {
		return { mtimeMs: st.mtimeMs, lastRunMs: null, failed: false, window: [], tail: [], empty: true };
	}
	let tsIdx = -1;
	let lastRunMs = null;
	for (let i = lines.length - 1; i >= 0; i--) {
		const m = LOG_TS_RE.exec(lines[i]);
		if (m) {
			tsIdx = i;
			lastRunMs = Date.parse(`${m[1]}T${m[2]}`);
			break;
		}
	}
	const window = tsIdx >= 0 ? lines.slice(tsIdx) : lines.slice(-30);
	const failed = window.some((l) => /ERROR|FAILED|exit=[1-9]\d*/.test(l));
	return {
		mtimeMs: st.mtimeMs,
		lastRunMs: Number.isFinite(lastRunMs) ? lastRunMs : st.mtimeMs,
		failed,
		window,
		tail: lines.slice(-200),
		empty: false,
	};
}

// cron 任务名: 上方注释冒号/逗号前的一段,否则主脚本名 + 首参数
function cronJobName(cmd, desc) {
	if (desc) {
		const head = desc.split(/[:：，,]/)[0].trim();
		if (head) return head;
	}
	const shMatch = cmd.match(/([^\s\/]+\.(?:z?sh|bash))\s+([^-\s]\S*)?/);
	if (shMatch) {
		const arg = shMatch[2] && !shMatch[2].startsWith("-") ? ` ${shMatch[2]}` : "";
		return `${shMatch[1]}${arg}`;
	}
	return truncate(cmd.split(/\s+/)[0], 24);
}

let schedCache = null; // { ts, jobs }

// 发现 pi 相关定时任务(launchd LaunchAgents + crontab):
// 判定规则 = 命令行含独立 pi 词,或引用的 .sh 脚本内容调 pi
// (ccmp/frontier-radar 都是脚本内间接调 pi 的形态)。结果 60s 缓存。
function collectScheduledJobs() {
	const now = Date.now();
	if (schedCache && now - schedCache.ts < CRON_CACHE_SEC * 1000) return schedCache.jobs;
	const jobs = [];
	// ---- launchd ----
	let plists = [];
	try {
		plists = readdirSync(LAUNCHAGENTS_DIR).filter((f) => f.endsWith(".plist"));
	} catch {}
	const lc = launchctlList();
	for (const f of plists) {
		const pl = parsePlist(join(LAUNCHAGENTS_DIR, f));
		if (!pl) continue;
		const label = typeof pl.Label === "string" ? pl.Label : f.replace(/\.plist$/, "");
		const args = Array.isArray(pl.ProgramArguments) ? pl.ProgramArguments.map(String) : [];
		const program = String(pl.Program ?? args[0] ?? "");
		const cmdText = args.join(" ") || program;
		// pi 相关判定: Label 含独立 pi 词(如 com.zeromorse.pi-sync)、
		// args[0] 恰为 pi 二进制(直接调 pi),或命令行中任一 .sh 脚本(含 zsh xxx.sh 包装形态,
		// program 本体是 /bin/zsh)内容调 pi。
		// 不看 program 路径本身: pi 仓库里的其他工具(如 caffeinebar)路径都含 /agent/pi/,会误匹配
		let related = PI_WORD_RE.test(label);
		if (!related && basename(program) === "pi") related = true;
		if (!related) {
			for (const s of scriptTokens(cmdText)) {
				const head = fileHeadText(s);
				if (head && PI_WORD_RE.test(head)) {
					related = true;
					break;
				}
			}
		}
		if (!related) continue;
		const sci = Array.isArray(pl.StartCalendarInterval) ? pl.StartCalendarInterval[0] : pl.StartCalendarInterval;
		let schedule = "-";
		if (sci && typeof sci.Hour === "number") {
			const hm = `${String(sci.Hour).padStart(2, "0")}:${String(sci.Minute ?? 0).padStart(2, "0")}`;
			schedule = sci.Weekday === undefined ? `每天 ${hm}` : `${DOW_CN[sci.Weekday % 7]} ${hm}`;
		} else if (typeof pl.StartInterval === "number") {
			const s = pl.StartInterval;
			schedule = s % 3600 === 0 ? `每 ${s / 3600} 小时` : s % 60 === 0 ? `每 ${s / 60} 分钟` : `每 ${s} 秒`;
		}
		const st = lc.get(label) ?? {};
		const running = st.pid !== undefined && st.pid !== "" && st.pid !== "-";
		const exit = st.status !== undefined && /^-?\d+$/.test(st.status) ? parseInt(st.status, 10) : null;
		// 证据日志: 先查 CRON_EVIDENCE(命令子串匹配,适用于迁到 launchd 的原 cron 任务,
		// cron.log 仍由脚本自己写,结构化记录比 stdout 重定向精确);
		// 否则用 plist 的 StandardOutPath
		const ev = evidenceLogsOfCron(cmdText);
		const logPath = ev.logs.length > 0 ? ev.logs[0] : typeof pl.StandardOutPath === "string" ? pl.StandardOutPath : null;
		const log = logPath ? analyzeJobLog(logPath, ev.filter) : null;
		const logs = ev.logs.length > 0 ? ev.logs : logPath ? [logPath] : [];
		// 状态优先级: 运行中 > 上次退出码;退出码未记录时看日志窗口。
		// 注意 launchd 的 exit 0 也可能表示"从未运行过"(默认值):
		// exit 0 且证据日志无任何记录 → unknown,避免周任务迁移后未到调度日被误报 ok
		let status = "unknown";
		if (running) status = "running";
		else if (exit !== null) status = exit === 0 ? (log?.empty ? "unknown" : "ok") : "failed";
		else if (log) status = log.failed ? "failed" : log.empty ? "unknown" : "ok";
		jobs.push({
			id: `launchd:${label}`,
			source: "launchd",
			label,
			name: label.split(".").pop() ?? label,
			desc: typeof pl.Comment === "string" ? pl.Comment : null,
			schedule,
			cmd: cmdText,
			exitCode: exit,
			running,
			logs,
			log,
			lastRunMs: log?.lastRunMs ?? null,
			status,
		});
	}
	// ---- cron ----
	let crontab = null;
	try {
		crontab = execFileSync("crontab", ["-l"], { encoding: "utf8", maxBuffer: 1024 * 1024 });
	} catch {}
	if (crontab) {
		const commentBuf = [];
		let cronIdx = 0;
		for (const raw of crontab.split("\n")) {
			const line = raw.trim();
			if (!line) {
				commentBuf.length = 0;
				continue;
			}
			if (line.startsWith("#")) {
				commentBuf.push(line.replace(/^#+\s*/, ""));
				continue;
			}
			const m = line.match(/^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.+)$/);
			if (!m) {
				commentBuf.length = 0;
				continue;
			}
			cronIdx++;
			const cmd = m[6];
			let related = PI_WORD_RE.test(cmd);
			if (!related) {
				for (const s of scriptTokens(cmd)) {
					const head = fileHeadText(s);
					if (head && PI_WORD_RE.test(head)) {
						related = true;
						break;
					}
				}
			}
			if (related) {
				const ev = evidenceLogsOfCron(cmd);
				const log = ev.logs.length > 0 ? analyzeJobLog(ev.logs[0], ev.filter) : null;
			jobs.push({
					id: `cron:${cronIdx}`,
					source: "cron",
					label: null,
					name: cronJobName(cmd, commentBuf.join(" ")),
					desc: commentBuf.join(" ") || null,
					schedule: cronScheduleText(m[1], m[2], m[3], m[4], m[5]),
					cmd,
					exitCode: null,
					running: false,
					logs: ev.logs,
					log,
					lastRunMs: log?.lastRunMs ?? null,
					status: log ? (log.failed ? "failed" : log.empty ? "unknown" : "ok") : "unknown",
				});
			}
			commentBuf.length = 0;
		}
	}
	const order = { running: 0, failed: 1, unknown: 2, ok: 3 };
	jobs.sort(
		(a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || (b.lastRunMs ?? 0) - (a.lastRunMs ?? 0),
	);
	schedCache = { ts: now, jobs };
	return jobs;
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
// 先 SIGTERM(pi 注册了处理器做优雅退出);但 TUI 主线程可能已死锁在同步 write()
// (如 pty 缓冲满、读端不消费),事件循环阻塞 → JS 信号处理器永远不执行,SIGTERM 无效。
// 所以发送后短轮询,进程仍存活则升级 SIGKILL(内核级,必杀;会话文件已落盘不受影响)。
function stopSession(row, onKill) {
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
	} catch {
		return `停止失败: kill -${sig === "SIGKILL" ? 9 : 15} ${pid}`;
	}
	const label = basename(row.cwd ?? "") || "pi";
	if (sig === "SIGKILL") return `已发送 SIGKILL → pid ${pid} (${label})`;
	// SIGTERM 后异步升级:最多等 8s(500ms x 16),仍存活则 SIGKILL
	let tries = 0;
	const timer = setInterval(() => {
		tries++;
		let alive = true;
		try {
			process.kill(pid, 0);
		} catch {
			alive = false;
		}
		if (!alive || tries >= 16) {
			clearInterval(timer);
			if (alive) {
				try {
					process.kill(pid, "SIGKILL");
					onKill?.(`pid ${pid} 未响应 SIGTERM(主线程疑似卡死),已升级 SIGKILL`);
				} catch {}
			}
		}
	}, 500);
	return `已发送 SIGTERM → pid ${pid} (${label})`;
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
		`${ANSI.dim}↑↓/jk 选择 · Enter/e 展开 · t 跳转终端 · x 停止 · c 定时任务 · q/Ctrl+C 退出${ANSI.reset}`,
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

// ---------- 定时任务渲染 ----------

function fmtDateTime(ms) {
	if (ms === null || ms === undefined) return "-";
	const d = new Date(ms);
	const now = new Date();
	const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
	if (d.toDateString() === now.toDateString()) return `今天 ${hm}`;
	if (d.getFullYear() === now.getFullYear())
		return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${hm}`;
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function jobStatusLabel(job) {
	switch (job.status) {
		case "running":
			return "RUNNING";
		case "failed":
			return "FAILED";
		case "ok":
			return "OK";
		default:
			return "UNKNOWN";
	}
}

function jobStatusColor(job) {
	switch (job.status) {
		case "running":
			return ANSI.cyan;
		case "failed":
			return ANSI.red;
		case "ok":
			return ANSI.dim;
		default:
			return ANSI.yellow;
	}
}

// NOTE 列: 失败时展示错误首行,其余展示简短说明
function jobNote(job) {
	if (job.status === "failed") {
		const line = (job.log?.window ?? []).find((l) => /ERROR|FAILED|exit=[1-9]/.test(l));
		if (line) return truncate(firstLine(line), 60);
		return job.exitCode !== null ? `exit ${job.exitCode}` : "-";
	}
	if (job.status === "running") return "运行中…";
	if (job.status === "unknown")
		return job.log?.empty ? "日志无该任务记录" : job.logs.length > 0 ? "无日志" : "无日志(未配置重定向)";
	return "ok";
}

function buildCronLines(jobs, selectedId, notice, pendingTrigger) {
	const cols = process.stdout.columns || 120;
	const lines = [];
	lines.push(
		`${ANSI.bold}pi dashboard${ANSI.reset}${ANSI.dim} — 定时任务  ${new Date().toLocaleTimeString()}  (c/Esc 返回列表)${ANSI.reset}`,
	);
	if (jobs.length === 0) {
		lines.push(`${ANSI.dim}(未发现 pi 相关定时任务: ~/Library/LaunchAgents 与 crontab)${ANSI.reset}`);
		lines.push(`${ANSI.dim}q 退出${ANSI.reset}`);
		return lines;
	}
	const W_STAT = 8;
	const W_JOB = 22;
	const W_SCH = 13;
	const W_RUN = 13;
	const W_SRC = 8;
	const W_NOTE = Math.max(20, cols - 2 - 2 - W_JOB - W_SCH - W_RUN - W_STAT - W_SRC - 5);
	const head =
		"  " +
		pad("JOB", W_JOB) +
		" " +
		pad("SCHEDULE", W_SCH) +
		" " +
		pad("LAST RUN", W_RUN) +
		" " +
		pad("STATUS", W_STAT) +
		" " +
		pad("SOURCE", W_SRC) +
		" " +
		pad("NOTE", W_NOTE);
	lines.push(`${ANSI.dim}${head}${ANSI.reset}`);
	lines.push(ANSI.dim + "  " + "-".repeat(dispWidth(head) - 2) + ANSI.reset);
	for (const job of jobs) {
		const sel = selectedId !== null && selectedId !== undefined && job.id === selectedId;
		const marker = sel ? `${ANSI.bold}> ${ANSI.reset}` : "  ";
		const stat = jobStatusLabel(job);
		const color = jobStatusColor(job);
		lines.push(
			marker +
				(sel ? ANSI.bold : "") +
				pad(truncate(job.name, W_JOB), W_JOB) +
				(sel ? ANSI.reset : "") +
				" " +
				pad(job.schedule, W_SCH) +
				" " +
				pad(fmtDateTime(job.lastRunMs), W_RUN) +
				" " +
				color +
				pad(stat, W_STAT) +
				ANSI.reset +
				" " +
				ANSI.dim +
				pad(job.source, W_SRC) +
				ANSI.reset +
				" " +
				color +
				pad(truncate(jobNote(job), W_NOTE), W_NOTE) +
				ANSI.reset,
		);
	}
	const counts = { running: 0, failed: 0, unknown: 0, ok: 0 };
	for (const j of jobs) counts[j.status]++;
	lines.push("");
	lines.push(
		`${ANSI.dim}${jobs.length} 个任务:${ANSI.reset}` +
			(counts.running ? `${ANSI.cyan} ${counts.running} running${ANSI.reset}` : "") +
			(counts.failed ? `${ANSI.red} ${counts.failed} failed${ANSI.reset}` : "") +
			(counts.unknown ? `${ANSI.yellow} ${counts.unknown} unknown${ANSI.reset}` : "") +
			`${ANSI.dim} ${counts.ok} ok${ANSI.reset}`,
	);
	if (pendingTrigger) {
		const job = jobs.find((j) => j.id === pendingTrigger.id);
		if (job) {
			lines.push(
				`${ANSI.yellow}  立即执行 ${job.name}? 再按 r 确认 (10s 内)${ANSI.reset}`,
			);
		}
	}
	if (notice) lines.push(`${ANSI.dim}  ${notice}${ANSI.reset}`);
	lines.push(
		`${ANSI.dim}↑↓/jk 选择 · Enter/e 日志 · r 立即执行(launchd) · c/Esc 返回 · q/Ctrl+C 退出${ANSI.reset}`,
	);
	return lines;
}

// 定时任务详情: 信息区 + 日志尾部(可滚动);返回 { lines, bodyCount }
function buildCronDetailLines(job) {
	const cols = process.stdout.columns || 120;
	const lines = [];
	lines.push(
		`${ANSI.bold}pi dashboard${ANSI.reset}${ANSI.dim} — cron job detail (Esc/q 返回)${ANSI.reset}`,
	);
	const exitText =
		job.exitCode === null ? "-" : job.exitCode === 0 ? "0 (成功)" : `${job.exitCode} (失败)`;
	const info = [
		["状态", `${jobStatusLabel(job)}${job.running ? " (正在运行)" : ""}`],
		["任务", job.name],
		["调度", job.schedule],
		["来源", job.source === "launchd" ? `launchd ${job.label}` : "crontab"],
		["退出码", exitText],
		["上次运行", fmtDateTime(job.lastRunMs)],
		["描述", job.desc ?? "-"],
		["命令", job.cmd],
		["日志", job.logs.length > 0 ? job.logs.map((l) => l.replace(homedir(), "~")).join("\n     ") : "无"],
	];
	for (const [k, v] of info) {
		lines.push(`${ANSI.dim}${pad(k, 4)}${ANSI.reset} ${truncate(String(v), cols - 8)}`);
	}
	lines.push(ANSI.dim + "─".repeat(Math.max(20, cols - 1)) + ANSI.reset);
	const body = [];
	if (job.log) {
		body.push(`${ANSI.bold}── 日志尾部 ──${ANSI.reset}`);
		for (const raw of job.log.tail) {
			const l = raw.replace(/\t/g, "   ").trimEnd();
			if (!l) continue;
			const isErr = /ERROR|FAILED|exit=[1-9]/.test(l);
			body.push(isErr ? `${ANSI.red}  ${truncate(l, cols - 4)}${ANSI.reset}` : `  ${truncate(l, cols - 4)}`);
		}
	} else {
		body.push(`${ANSI.dim}  (无日志)${ANSI.reset}`);
	}
	lines.push(...body);
	return { lines, bodyCount: body.length };
}

// 手动触发: 仅 launchd(kickstart 干净且由 launchd 托管);cron 任务给出手动命令
function triggerJob(job) {
	if (job.source === "launchd") {
		try {
			execFileSync("launchctl", ["kickstart", `gui/${process.getuid()}`, job.label]);
			return `已触发 ${job.label} (launchctl kickstart,后台运行)`;
		} catch {
			return `触发失败: launchctl kickstart gui/$(id -u)/${job.label}`;
		}
	}
	return `cron 任务请手动执行: ${truncate(job.cmd, 100)}`;
}

// 单次模式末尾的定时任务摘要区块
function cronSummaryLines() {
	const jobs = collectScheduledJobs();
	if (jobs.length === 0) return [];
	const counts = { running: 0, failed: 0, unknown: 0, ok: 0 };
	for (const j of jobs) counts[j.status]++;
	const lines = [
		"",
		`${ANSI.bold}定时任务${ANSI.reset}${ANSI.dim}  ${jobs.length} 个: ${counts.failed} failed / ${counts.unknown} unknown / ${counts.ok} ok${ANSI.reset}`,
	];
	for (const j of jobs) {
		const color = jobStatusColor(j);
		const label =
			j.status === "running" ? "RUN" : j.status === "failed" ? "FAIL" : j.status === "ok" ? "ok" : "?";
		lines.push(
			`  ${color}${pad(label, 4)}${ANSI.reset} ${pad(truncate(j.name, 26), 26)} ${ANSI.dim}${pad(j.schedule, 13)} 上次 ${fmtDateTime(j.lastRunMs)}  ${truncate(jobNote(j), 40)}${ANSI.reset}`,
		);
	}
	lines.push(`${ANSI.dim}  详情: node local/pi-dashboard.mjs -w 后按 c,或 --cron${ANSI.reset}`);
	return lines;
}

// ---------- 主流程 ----------

function collectActive() {
	const procs = findPiProcesses();
	// pid 注册表(读一次,死 pid 注册文件顺手清理)
	const registry = readPidRegistry(new Map(procs.map((p) => [p.pid, p.startMs])));
	const byCwd = new Map();
	for (const p of procs) {
		if (!p.cwd) continue;
		if (!byCwd.has(p.cwd)) byCwd.set(p.cwd, []);
		byCwd.get(p.cwd).push(p);
	}
	const rows = [];
	for (const [cwd, cwdProcs] of byCwd) {
		const files = listSessionFiles(cwdToSessionDir(cwd));
		// 进程 <-> 会话文件配对。第 0 轮是注册表精确配对;第 1/2/3 轮是启发式
		// (pi 写完即关不持有句柄,也没有锁文件),覆盖注册缺失(扩展未装/老进程)的场景:
		// 会话文件名时间戳 = 会话开始时刻 ≈ 进程启动时间,但文件落盘延迟到首条 assistant 回复。
		// 第 1 轮(新会话): |文件创建时间 - 进程启动| <= 5s,进程启动时新建的会话,强绑定。
		// 第 2 轮(resume): 文件创建早于进程启动 + 5s,且进程启动后(容差 5s)写入过(在续写);
		//        候选取 mtime 最新(最近被写的最可能是该进程在续写的),平手取 createMs 最大。
		//        已知局限: 进程 resume 后长期零写入时 mtime 停在旧值,会被排除;而死会话可能因
		//        重名(session_info)mtime 很新反而胜出 → 错配。装了 pid-registry 扩展则由第 0 轮解决。
		// 各轮都跳过已占用文件,继续找次优。
		// 注意不能按 mtime 降序取第一个满足"createMs <= 启动+5s"的文件: 已退出进程留下的死文件
		// mtime 常仍是目录最新,活进程会错配到死会话 → 死会话一直显示"存活"(带活进程的 pid,
		// 按 x 停止还会误杀无辜进程),真正在跑的会话反而不显示(已踩坑)。
		// fork 接管: 进程运行中 /fork 会创建新分支文件(header.parentSession 指向原文件)并转过去写,
		// 按启动时间配会停在父文件上 → 沿未占用的子分支链把进程改配到最新分支。
		const procsDesc = [...cwdProcs].sort((a, b) => b.startMs - a.startMs);
		const procByFile = new Map();
		const fileOfProc = new Map();
		const pair = (f, p) => {
			procByFile.set(f.path, p);
			fileOfProc.set(p, f);
		};
		// 第 0 轮(注册表精确配对): 扩展 pid-registry 写的 pid→会话文件映射,
		// 无条件优先于启发式。注册的文件可能不在本 cwd 的默认会话目录下
		// (如 --session / 跨目录 fork),补进文件列表参与分析。
		for (const p of procsDesc) {
			const r = registry.get(p.pid);
			if (!r) continue;
			let f = files.find((x) => x.path === r.file);
			if (!f) {
				try {
					const st = statSync(r.file);
					f = {
						path: r.file,
						mtimeMs: st.mtimeMs,
						createMs: sessionFileCreateMs(basename(r.file)) ?? st.mtimeMs,
						parent: headerParentOf(r.file, st.mtimeMs),
					};
					files.push(f);
				} catch {
					continue; // 注册指向的文件已不存在
				}
			}
			if (procByFile.has(f.path)) continue; // 同一会话文件被多进程 resume,先到先得
			pair(f, p);
		}
		for (const p of procsDesc) {
			if (fileOfProc.has(p)) continue; // 已被第 0/前一轮配对
			for (const f of files) {
				if (procByFile.has(f.path)) continue;
				if (Math.abs(f.createMs - p.startMs) <= 5000) {
					pair(f, p);
					break;
				}
			}
		}
		for (const p of procsDesc) {
			if (fileOfProc.has(p)) continue;
			let cand = null;
			for (const f of files) {
				if (procByFile.has(f.path)) continue;
				if (f.createMs > p.startMs + 5000) continue;
				if (f.mtimeMs < p.startMs - 5000) continue; // 进程启动后没写过 → 不是它在续写
				if (!cand || f.mtimeMs > cand.mtimeMs || (f.mtimeMs === cand.mtimeMs && f.createMs > cand.createMs)) cand = f;
			}
			if (cand) pair(cand, p);
		}
		for (const p of procsDesc) {
			let f = fileOfProc.get(p);
			if (!f) continue;
			for (let i = 0; i < files.length; i++) {
				let child = null;
				for (const c of files) {
					if (c.parent !== f.path || procByFile.has(c.path)) continue;
					if (c.createMs <= p.startMs + 5000) continue; // 非本进程启动后的 fork 产物
					if (!child || c.createMs > child.createMs) child = c;
				}
				if (!child || child.mtimeMs < f.mtimeMs) break; // 没有更新的子分支
				procByFile.delete(f.path);
				pair(child, p);
				f = child;
			}
		}
		// 显示哪些行:
		// 1) 配上进程的会话文件(带 pid/term)
		// 2) 未配上文件的进程 → 合成行(带 pid/term,可停止);不抓 mtime 最新的文件冒充,
		//    那多半是已退出进程留下的死会话,会把死会话"顶活"(已踩坑)
		// 3) 15 秒内仍在写入的文件兜底(新会话刚落盘/时钟误差,短暂显示)
		const chosen = new Set(procByFile.keys());
		const freshCutoff = Date.now() - 15000;
		for (const f of files) {
			if (f.mtimeMs >= freshCutoff) chosen.add(f.path);
		}
		const picked = files.filter((f) => chosen.has(f.path));
		for (const f of picked) {
			const row = analyzeSession(f.path);
			row.term = procByFile.get(f.path)?.term ?? null;
			row.pid = procByFile.get(f.path)?.pid ?? null;
			rows.push(row);
		}
		for (const p of procsDesc) {
			if (fileOfProc.has(p)) continue;
			rows.push({
				file: `(pid ${p.pid})`,
				cwd,
				sessionId: null,
				name: null,
				status: "idle",
				detail: "会话文件未落盘或 resume 后无写入",
				ageSec: null,
				model: null,
				stopReason: null,
				lastReply: null,
				lastUser: null,
				toolCall: null,
				term: p.term,
				pid: p.pid,
			});
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

if (args.includes("--cron")) {
	// 只看定时任务视图
	process.stdout.write(buildCronLines(collectScheduledJobs(), null, null, null).join("\n") + "\n");
	process.exit(0);
}

if (!watch) {
	const lines = tick();
	lines.push(...cronSummaryLines()); // 末尾追加定时任务摘要
	process.stdout.write(lines.join("\n") + "\n");
} else {
	// 隐藏光标,首次清屏一次;后续增量重绘不再清屏,避免闪烁
	process.stdout.write("\x1b[?25l\x1b[H\x1b[2J");
	const state = {
		mode: "list", // list | detail | cron | cronDetail
		rows: [],
		meta: { desc: "", procs: 0, cwds: 0 },
		selected: 0,
		selectedFile: null,
		scroll: 0,
		maxScroll: 0,
		notice: null, // { text, ts } 跳转等操作的结果提示
		prevStatus: new Map(), // file -> status,状态转变检测基线
		pendingKill: null, // { file, ts } x 键二次确认状态
		cronJobs: [],
		cronSelected: 0,
		cronSelectedId: null,
		pendingTrigger: null, // { id, ts } r 键二次确认状态
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
		if (state.mode === "cron") {
			return buildCronLines(state.cronJobs, state.cronSelectedId, notice, state.pendingTrigger);
		}
		if (state.mode === "cronDetail") {
			const job = state.cronJobs[state.cronSelected];
			if (job) {
				const { lines, bodyCount } = buildCronDetailLines(job);
				const window = (process.stdout.rows || 40) - 2; // 标题 1 行 + 底部提示 1 行
				const visibleBody = Math.max(1, window - (lines.length - bodyCount));
				state.maxScroll = Math.max(0, bodyCount - visibleBody);
				state.scroll = Math.max(0, Math.min(state.scroll, state.maxScroll));
				const head = lines.slice(0, lines.length - bodyCount);
				const body = lines.slice(lines.length - bodyCount);
				const foot = [];
				if (notice) foot.push(`${ANSI.dim}  ${notice}${ANSI.reset}`);
				foot.push(
					`${ANSI.dim}↑↓/jk 滚动 · PgUp/PgDn 翻页 · g/G 首/尾 · r 立即执行 · Esc/q 返回 · Ctrl+C 退出${ANSI.reset}`,
				);
				return [...head, ...body.slice(state.scroll, state.scroll + visibleBody), ...foot];
			}
			state.mode = "cron"; // 选中任务被刷掉(如缓存重建),退回列表
			return buildCronLines(state.cronJobs, state.cronSelectedId, notice, state.pendingTrigger);
		}
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

	const syncCronSelection = () => {
		if (state.cronJobs.length === 0) {
			state.cronSelected = 0;
			state.cronSelectedId = null;
			return;
		}
		state.cronSelected = Math.max(0, Math.min(state.cronSelected, state.cronJobs.length - 1));
		state.cronSelectedId = state.cronJobs[state.cronSelected]?.id ?? null;
	};

	const restoreCronSelection = () => {
		if (state.cronJobs.length === 0) {
			state.cronSelected = 0;
			state.cronSelectedId = null;
			return;
		}
		if (state.cronSelectedId !== null) {
			const idx = state.cronJobs.findIndex((j) => j.id === state.cronSelectedId);
			if (idx >= 0) state.cronSelected = idx;
		}
		syncCronSelection();
	};

	const refresh = () => {
		const { rows, meta } = collect();
		if (notifyEnabled) detectTransitions(rows, state.prevStatus);
		sortRows(rows);
		state.rows = rows;
		state.meta = meta;
		state.cronJobs = collectScheduledJobs();
		restoreSelection();
		restoreCronSelection();
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
							state.notice = { text: stopSession(row, (msg) => { state.notice = { text: msg, ts: Date.now() }; }), ts: now };
						} else if (row.pid) {
							state.pendingKill = { file: row.file, ts: now };
							const label = truncate(`${basename(row.cwd ?? "") || "pi"} / ${row.name ?? basename(row.file)}`, 60);
							state.notice = { text: `停止 pid=${row.pid} (${label})? 再按 x 确认`, ts: now };
						} else {
							state.notice = { text: stopSession(row, (msg) => { state.notice = { text: msg, ts: Date.now() }; }), ts: now };
						}
					return true;
				}
				case "c":
					if (state.cronJobs.length > 0) {
						state.mode = "cron";
						syncCronSelection();
						state.pendingTrigger = null;
					}
					return true;
				case "q":
					cleanup();
					return false;
				default:
					return false; // 无关按键,不重绘
			}
		} else if (state.mode === "cron") {
			switch (key) {
				case "\x1b[A":
				case "k":
					state.cronSelected--;
					return true;
				case "\x1b[B":
				case "j":
					state.cronSelected++;
					return true;
				case "g":
					state.cronSelected = 0;
					return true;
				case "G":
					state.cronSelected = state.cronJobs.length - 1;
					return true;
				case "\r":
				case "e":
				case " ": {
					const job = state.cronJobs[state.cronSelected];
					if (job) {
						state.mode = "cronDetail";
						state.scroll = 0;
						return true;
					}
					return false;
				}
				case "r": {
					const job = state.cronJobs[state.cronSelected];
					if (!job) return false;
					const now = Date.now();
					if (state.pendingTrigger && state.pendingTrigger.id === job.id && now - state.pendingTrigger.ts <= 10000) {
						state.pendingTrigger = null;
						state.notice = { text: triggerJob(job), ts: now };
					} else {
						state.pendingTrigger = { id: job.id, ts: now };
						state.notice = null;
					}
					return true;
				}
				case "c":
				case "\x1b":
				case "q":
					state.mode = "list";
					state.pendingTrigger = null;
					return true;
				default:
					return false; // 无关按键,不重绘
			}
		} else if (state.mode === "cronDetail") {
			switch (key) {
				case "\x1b":
				case "q":
					state.mode = "cron";
					return true;
				case "r": {
					const job = state.cronJobs[state.cronSelected];
					if (!job) return false;
					const now = Date.now();
					if (state.pendingTrigger && state.pendingTrigger.id === job.id && now - state.pendingTrigger.ts <= 10000) {
						state.pendingTrigger = null;
						state.notice = { text: triggerJob(job), ts: now };
					} else {
						state.pendingTrigger = { id: job.id, ts: now };
						state.notice = null;
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
							state.notice = { text: stopSession(row, (msg) => { state.notice = { text: msg, ts: Date.now() }; }), ts: now };
						} else if (row.pid) {
							state.pendingKill = { file: row.file, ts: now };
							const label = truncate(`${basename(row.cwd ?? "") || "pi"} / ${row.name ?? basename(row.file)}`, 60);
							state.notice = { text: `停止 pid=${row.pid} (${label})? 再按 x 确认`, ts: now };
						} else {
							state.notice = { text: stopSession(row, (msg) => { state.notice = { text: msg, ts: Date.now() }; }), ts: now };
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
			syncCronSelection();
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
