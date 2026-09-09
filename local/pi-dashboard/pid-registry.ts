/**
 * pid-registry — 进程↔会话文件映射注册表,供 pi-dashboard 精确配对。
 *
 * 问题: pi resume 会话后若用户未发消息,会话文件零写入(mtime 停留在旧值);
 * 而已退出进程留下的死会话可能因重命名(session_info 写入)mtime 很新。
 * dashboard 纯靠 mtime/创建时间启发式配对进程↔会话文件,两者叠加时必然错配
 * (死会话被"顶活",真正在跑的会话反而丢失)。
 *
 * 本扩展在每次 session_start(startup/new/resume/fork/import 全覆盖)时原子写
 *   <agentDir>/runtime/<pid>.json   内容 {"pid","file","ts"}
 * 进程正常退出时删除自己的注册;SIGKILL/崩溃残留由 dashboard 按进程存活兜底清理。
 * 纯本地元数据,不触碰会话文件本身。
 */

import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const dir = join(getAgentDir(), "runtime");
	const file = join(dir, `${process.pid}.json`);
	const tmp = join(dir, `.${process.pid}.tmp`);

	const write = (sessionFile: string): void => {
		try {
			mkdirSync(dir, { recursive: true });
			writeFileSync(tmp, `${JSON.stringify({ pid: process.pid, file: sessionFile, ts: Date.now() })}\n`);
			renameSync(tmp, file);
		} catch {
			// 注册表只是 dashboard 的辅助数据,写失败静默
		}
	};

	const remove = (): void => {
		try {
			rmSync(file, { force: true });
			rmSync(tmp, { force: true });
		} catch {}
	};

	pi.on("session_start", (_event, ctx) => {
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (sessionFile) write(sessionFile);
		else remove(); // in-memory session: 撤销本进程先前的注册
	});

	// 全局只装一次 exit handler: session 替换会重载扩展模块,
	// 每次都 process.on("exit") 会无限累积 listener
	const g = globalThis as { __pidRegistryExitInstalled?: boolean };
	if (!g.__pidRegistryExitInstalled) {
		g.__pidRegistryExitInstalled = true;
		process.on("exit", () => {
			try {
				rmSync(file, { force: true });
				rmSync(tmp, { force: true });
			} catch {}
		});
	}
}
