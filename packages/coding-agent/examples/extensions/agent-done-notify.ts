/**
 * Agent-done notify
 *
 * Sends a system notification when pi finishes processing a request and is
 * waiting for input again. Clicking the notification activates the terminal
 * app pi runs in, so you jump back to the console that shows the finished run.
 *
 * - macOS + pi-notify (recommended): native UNUserNotification tool with a
 *   click handler that activates the terminal app. Source and build script
 *   live in the pi repo at local/pi-notify/ (run build.sh after changes);
 *   ~/.pi/agent/pi-notify/ is kept as a fallback location.
 *   NOTE: ad-hoc re-signing after a rebuild can reset notification permission;
 *   if notifications stop showing, re-allow "pi" in System Settings.
 * - macOS without pi-notify: plain osascript notification (no click-to-activate).
 * - Windows Terminal (WSL): toast via powershell.exe.
 * - Others: OSC 777 terminal escape (Ghostty, iTerm2, WezTerm, rxvt-unicode).
 */

import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** TERM_PROGRAM value -> macOS bundle id of the terminal application. */
const TERM_BUNDLE_IDS: Record<string, string> = {
	vscode: "com.microsoft.VSCode",
	"vscode-insiders": "com.microsoft.VSCodeInsiders",
	vscodium: "com.vscodium",
	Apple_Terminal: "com.apple.Terminal",
	"iTerm.app": "com.googlecode.iterm2",
	iTerm2: "com.googlecode.iterm2",
	ghostty: "com.mitchellh.ghostty",
	WezTerm: "com.github.wez.wezterm",
	Hyper: "co.zeit.hyper",
};

function findPiNotify(): string | undefined {
	const candidates = process.env.HOME
		? [
				`${process.env.HOME}/Applications/pi-notify.app/Contents/MacOS/pi-notify`,
				`${process.env.HOME}/.pi/agent/pi-notify/build/pi-notify.app/Contents/MacOS/pi-notify`,
			]
		: [];
	for (const p of candidates) {
		try {
			accessSync(p, constants.X_OK);
			return p;
		} catch {
			// not built yet
		}
	}
	return undefined;
}

const piNotify = findPiNotify();

function escapeAppleScript(s: string): string {
	return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function windowsToastScript(title: string, body: string): string {
	const type = "Windows.UI.Notifications";
	const mgr = `[${type}.ToastNotificationManager, ${type}, ContentType = WindowsRuntime]`;
	const template = `[${type}.ToastTemplateType]::ToastText01`;
	const toast = `[${type}.ToastNotification]::new($xml)`;
	return [
		`${mgr} > $null`,
		`$xml = [${type}.ToastNotificationManager]::GetTemplateContent(${template})`,
		`$xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode('${body}')) > $null`,
		`[${type}.ToastNotificationManager]::CreateToastNotifier('${title}').Show(${toast})`,
	].join("; ");
}

interface NotifyOptions {
	/** Replace previous notifications with the same identifier. */
	identifier?: string;
	/** macOS bundle id to activate when the notification is clicked. */
	activate?: string;
}

function notify(title: string, message: string, opts: NotifyOptions = {}): void {
	if (process.platform === "darwin") {
		if (piNotify) {
			const args = ["send", title, message, opts.activate ?? "", opts.identifier ?? "pi-agent-done"];
			execFile(piNotify, args);
			return;
		}
		execFile("osascript", [
			"-e",
			`display notification "${escapeAppleScript(message)}" with title "${escapeAppleScript(title)}"`,
		]);
		return;
	}
	if (process.env.WT_SESSION) {
		execFile("powershell.exe", ["-NoProfile", "-Command", windowsToastScript(title, message)]);
		return;
	}
	// OSC 777: Ghostty, iTerm2, WezTerm, rxvt-unicode
	process.stdout.write(`\x1b]777;notify;${title};${message}\x07`);
}

export default function (pi: ExtensionAPI) {
	// `agent_end` fires after each low-level run; Pi may still retry, compact,
	// or continue with queued follow-ups. Notify only after the full run settles.
	pi.on("agent_settled", async (_event, ctx) => {
		// Skip `-p` / `--mode json` / `--mode rpc` invocations.
		if (ctx.mode !== "tui") return;
		const dir = ctx.cwd.split(/[\\/]/).filter(Boolean).pop() ?? ctx.cwd;
		notify("pi", `处理完成，等待输入 (${dir})`, {
			identifier: `pi-agent-done-${dir}`,
			activate: TERM_BUNDLE_IDS[process.env.TERM_PROGRAM ?? ""],
		});
	});
}
