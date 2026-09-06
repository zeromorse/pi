#!/usr/bin/env node
/**
 * pi-pacer-revive.mjs — 【pi 配速员的手】参数化会话复活脚本
 * 由 pi-pacer.sh 在会话「已终止」首轮恢复时调用，也可单独使用。
 *
 * 流程（单条 RPC 连接内完成）：
 *   1. compact  — 对目标会话触发一次上下文压缩
 *   2. prompt 复活消息 — 等 agent_settled（agent 已回复）
 *   3. prompt 确认消息 — agent 确认后自主干活至 settled 或超时
 *
 * 用法:
 *   node pi-pacer-revive.mjs <session-file> [--no-confirm]
 *
 * 环境变量:
 *   PROJECT_DIR    pi 的工作目录（默认 cwd）
 *   TIMEOUT_SEC    整体超时（默认 14400 = 4h）
 *   PI_BIN         pi 可执行文件（默认 "pi"）
 *   PI_PROVIDER    provider（默认 meituan-aigc）
 *   PI_MODEL       model（默认 glm-5.3）
 *   REVIVE_MSG     复活消息（默认见下）
 *   CONFIRM_MSG    确认消息（默认见下）
 *
 * 协议参考: ~/agent/pi/packages/coding-agent/docs/rpc.md
 */

import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const noConfirm = args.includes("--no-confirm");
const sessionFile = args.find((a) => !a.startsWith("--"));
if (!sessionFile) {
	console.error("用法: node pi-pacer-revive.mjs <session-file> [--no-confirm]");
	process.exit(2);
}

const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();
const TIMEOUT_SEC = parseInt(process.env.TIMEOUT_SEC || "14400", 10);
const PI_BIN = process.env.PI_BIN || "pi";
const PI_PROVIDER = process.env.PI_PROVIDER || "meituan-aigc";
const PI_MODEL = process.env.PI_MODEL || "glm-5.3";

const MSG_REVIVE =
	process.env.REVIVE_MSG ||
	"继续优化迭代当前项目。请先阅读 AGENTS.md / FEEDBACK.md（如有）及最近的任务书或报告，" +
	"结合 git log 近况，选择下一个高价值优化点（缺陷修复 > 测试补齐 > 性能 > 文档），" +
	"小步快跑，每完成一项即 git 提交并简述成果。";

const MSG_CONFIRM =
	process.env.CONFIRM_MSG ||
	"确认执行。按你的计划推进，完成当前单元后继续自主选择下一个优化点迭代，无需等待人工确认。";

const sessionShort = sessionFile.split("/").pop()?.replace(".jsonl", "") || sessionFile;

const ts = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const log = (m) => console.log(`[${ts()}] ${m}`);

let reqId = 0;
let proc;

function send(cmd) {
	cmd.id = `req-${++reqId}`;
	proc.stdin.write(JSON.stringify(cmd) + "\n");
	return cmd.id;
}

const waiters = { response: new Map(), settled: [] };
let fatal = null;
let agentBusy = false;

const routes = {
	response: (ev) => {
		const w = waiters.response.get(ev.id);
		if (w) {
			waiters.response.delete(ev.id);
			w(ev);
		}
	},
	agent_start: () => {
		agentBusy = true;
	},
	agent_settled: () => {
		// 只在确实有 agent 运行过的情况下唤醒（过滤连接建立时的杂散 settled）
		if (!agentBusy) return;
		agentBusy = false;
		for (const w of waiters.settled.splice(0)) w();
	},
};

function startAgent() {
	proc = spawn(PI_BIN, [
		"--mode", "rpc",
		"--session", sessionFile,
		"--provider", PI_PROVIDER, "--model", PI_MODEL,
	], { cwd: PROJECT_DIR, stdio: ["pipe", "pipe", "pipe"] });

	let buf = "";
	proc.stdout.on("data", (chunk) => {
		buf += chunk;
		let i;
		while ((i = buf.indexOf("\n")) !== -1) {
			const line = buf.slice(0, i);
			buf = buf.slice(i + 1);
			if (!line.trim()) continue;
			let ev;
			try {
				ev = JSON.parse(line.endsWith("\r") ? line.slice(0, -1) : line);
			} catch {
				continue;
			}
			const r = routes[ev.type];
			if (r) r(ev);
			if (ev.type === "message_update") {
				const d = ev.assistantMessageEvent;
				if (d && d.type === "text_delta") process.stdout.write(d.delta);
			}
			if (ev.type === "message_end") process.stdout.write("\n");
		}
	});
	proc.stderr.on("data", (c) => process.stderr.write(c));
	proc.on("exit", (code) => {
		fatal = `pi 进程退出 (code=${code})`;
		for (const w of waiters.settled.splice(0)) w();
	});

	setTimeout(() => {
		log(`⏱ 达到整体超时 ${TIMEOUT_SEC}s，终止（进展已保留在会话文件）`);
		proc.kill("SIGTERM");
		setTimeout(() => proc.kill("SIGKILL"), 5000);
	}, TIMEOUT_SEC * 1000).unref();
}

function waitResponse(id, timeoutMs = 120000) {
	return new Promise((resolve) => {
		const t = setTimeout(() => resolve({ timeout: true }), timeoutMs);
		waiters.response.set(id, (ev) => {
			clearTimeout(t);
			resolve(ev);
		});
	});
}

function waitSettled(timeoutMs) {
	return new Promise((resolve) => {
		const t = setTimeout(() => resolve("timeout"), timeoutMs);
		waiters.settled.push(() => {
			clearTimeout(t);
			resolve("ok");
		});
		if (fatal) {
			clearTimeout(t);
			resolve(fatal);
		}
	});
}

async function main() {
	log(`启动 RPC 恢复: session=${sessionShort}`);
	log(`cwd=${PROJECT_DIR} model=${PI_PROVIDER}/${PI_MODEL} confirm=${!noConfirm} timeout=${TIMEOUT_SEC}s`);
	startAgent();

	// 0) 探活
	const sid = send({ type: "get_state" });
	const alive = await waitResponse(sid, 60000);
	if (alive.timeout || !alive.success) {
		log(`❌ RPC 未就绪: ${JSON.stringify(alive).slice(0, 200)}`);
		proc.kill("SIGKILL");
		process.exit(1);
	}
	log("RPC 就绪");

	// 1) 上下文压缩（发复活消息之前）
	log("触发上下文压缩 (compact)…");
	const cid = send({ type: "compact" });
	const cres = await waitResponse(cid, 10 * 60000);
	if (cres.timeout || !cres.success) {
		log(`⚠ compact 失败: ${JSON.stringify(cres).slice(0, 300)} — 继续原流程（不阻塞）`);
	} else {
		const d = cres.data || {};
		log(
			`✅ 压缩完成: tokensBefore=${d.tokensBefore ?? "?"} → estimatedAfter=${d.estimatedTokensAfter ?? "?"}`,
		);
	}

	// 2) 复活消息，等 agent 回复
	log(`发送复活消息: ${MSG_REVIVE.slice(0, 60)}…`);
	const pid1 = send({ type: "prompt", message: MSG_REVIVE });
	const p1res = await waitResponse(pid1, 60000);
	if (p1res.timeout || !p1res.success) {
		log(`❌ prompt 被拒绝: ${JSON.stringify(p1res).slice(0, 200)}`);
		proc.kill("SIGKILL");
		process.exit(1);
	}
	log("已接受，等待 agent 回复（可能包含大量自主工作）…");
	const r1 = await waitSettled(TIMEOUT_SEC * 1000);
	if (r1 !== "ok") {
		log(`⚠ 第一轮未正常结束: ${r1} — 退出，进展已保留`);
		proc.kill("SIGKILL");
		process.exit(1);
	}
	log("agent 已回复第一轮");

	// 3) 确认执行
	if (!noConfirm) {
		log("发送确认消息…");
		const pid2 = send({ type: "prompt", message: MSG_CONFIRM });
		await waitResponse(pid2, 60000);
		log("已接受，等待 agent 执行（可能持续数小时）…");
		const r2 = await waitSettled(TIMEOUT_SEC * 1000);
		log(`第二轮结束: ${r2}`);
	}

	log("恢复流程完成，退出");
	proc.kill("SIGTERM");
	setTimeout(() => proc.kill("SIGKILL"), 5000);
	process.exit(0);
}

main().catch((e) => {
	log(`❌ 异常: ${e?.stack || e}`);
	if (proc) proc.kill("SIGKILL");
	process.exit(1);
});
