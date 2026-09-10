// TimerBar — macOS 菜单栏倒计时器
//
// 状态栏常驻图标：未开始/已暂停 ⌛️ / 运行中 ⏳（每 5 秒缓慢淡出淡入一次）/ 结束闪 ✅。
// 剩余时间不上状态栏，展示在点开菜单的状态行与悬停 tooltip 中。
// 时长默认 5 分钟，菜单里选预设或自定义，选择后立即开始。
// 时间到调用 pi-notify 发系统通知（找不到二进制时回退 osascript）。
//
// 启动参数：
//   TimerBar                正常启动（待开始，使用上次时长）
//   TimerBar --start <秒>   启动并立即开始指定秒数的倒计时（仅本次生效，不落盘）

import Cocoa

final class AppDelegate: NSObject, NSApplicationDelegate {
	private var statusItem: NSStatusItem!
	private var tickTimer: Timer?

	/// 预设时长（秒）。选时长会重置倒计时。
	private var durationSeconds: TimeInterval = 300
	/// 运行中的结束时刻；非 nil 即运行中。存绝对时刻，避免累计漂移。
	private var endAt: Date?
	/// 暂停时的剩余秒数；非 nil 即已暂停。
	private var pausedRemaining: TimeInterval?
	/// 倒计时结束后状态栏闪 ✅，5 秒后恢复。
	private var flashReset: DispatchWorkItem?
	private var flashing = false
	/// 菜单第一行（状态/剩余时间），tick 里实时刷新。
	private var statusMenuItem: NSMenuItem?

	private enum State {
		case idle
		case running
		case paused
	}

	private var state: State {
		if endAt != nil { return .running }
		if pausedRemaining != nil { return .paused }
		return .idle
	}

	/// 当前剩余秒数（idle 时为完整时长）。
	private var remaining: TimeInterval {
		switch state {
		case .running: return max(0, endAt!.timeIntervalSinceNow)
		case .paused: return pausedRemaining ?? 0
		case .idle: return durationSeconds
		}
	}

	func applicationDidFinishLaunching(_ notification: Notification) {
		// 只接受自定义输入范围内（0.1–600 分钟）的持久化值。
		if let saved = UserDefaults.standard.object(forKey: "durationSeconds") as? Double,
			saved >= 6, saved <= 36000 {
			durationSeconds = saved
		}

		statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
		statusItem.button?.toolTip = "TimerBar 倒计时器"
		let menu = NSMenu()
		menu.autoenablesItems = false
		menu.delegate = self
		statusItem.menu = menu

		let args = CommandLine.arguments
		if args.count >= 3, args[1] == "--start", let secs = Double(args[2]), secs >= 1 {
			durationSeconds = secs // 不写 UserDefaults，避免短时长测试污染默认值
			startTimer()
		}
		refreshUI()
	}

	// MARK: - 控制动作

	private func setDuration(_ secs: TimeInterval) {
		durationSeconds = secs
		UserDefaults.standard.set(secs, forKey: "durationSeconds")
	}

	/// 从头开始一次倒计时（任意状态均可调用）。
	private func startTimer() {
		cancelFlash()
		pausedRemaining = nil
		endAt = Date().addingTimeInterval(durationSeconds)
		if tickTimer == nil {
			// .common mode：菜单打开（event tracking）期间计时也不停；0.1s 驱动图标闪烁。
			tickTimer = Timer(timeInterval: 0.1, repeats: true) { [weak self] _ in
				self?.tick()
			}
			RunLoop.main.add(tickTimer!, forMode: .common)
		}
		refreshUI()
	}

	@objc private func startAction() { startTimer() }

	@objc private func pauseAction() {
		guard state == .running else { return }
		pausedRemaining = remaining
		endAt = nil
		refreshUI()
	}

	@objc private func resumeAction() {
		guard state == .paused else { return }
		endAt = Date().addingTimeInterval(pausedRemaining ?? 0)
		pausedRemaining = nil
		refreshUI()
	}

	@objc private func resetAction() {
		endAt = nil
		pausedRemaining = nil
		cancelFlash()
		refreshUI()
	}

	@objc private func presetAction(_ sender: NSMenuItem) {
		guard let secs = sender.representedObject as? Int else { return }
		setDuration(TimeInterval(secs))
		startTimer()
	}

	@objc private func customAction() {
		let alert = NSAlert()
		alert.messageText = "自定义倒计时时长"
		alert.informativeText = "分钟数（0.1 – 600），确认后立即开始"
		let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 140, height: 24))
		field.stringValue = String(format: "%g", durationSeconds / 60)
		alert.accessoryView = field
		alert.addButton(withTitle: "开始")
		alert.addButton(withTitle: "取消")
		NSApp.activate(ignoringOtherApps: true)
		guard alert.runModal() == .alertFirstButtonReturn,
			let mins = Double(field.stringValue.trimmingCharacters(in: .whitespaces)),
			mins >= 0.1, mins <= 600 else { return }
		setDuration(mins * 60)
		startTimer()
	}

	@objc private func quitAction() {
		NSApp.terminate(self)
	}

	// MARK: - 计时

	private func tick() {
		guard state == .running else { return }
		let rem = endAt!.timeIntervalSinceNow
		if rem <= 0 {
			finish()
		} else {
			// 图标闪烁 + tooltip + 菜单状态行剩余时间
			renderIcon()
		}
	}

	private func finish() {
		let total = durationSeconds
		endAt = nil
		pausedRemaining = nil
		sendDoneNotification(total: total)
		flashDone()
		refreshUI()
	}

	private func flashDone() {
		flashing = true
		flashReset?.cancel()
		let work = DispatchWorkItem { [weak self] in
			guard let self else { return }
			self.flashing = false
			self.renderIcon()
		}
		flashReset = work
		DispatchQueue.main.asyncAfter(deadline: .now() + 5, execute: work)
	}

	private func cancelFlash() {
		flashing = false
		flashReset?.cancel()
		flashReset = nil
	}

	// MARK: - 通知

	private func sendDoneNotification(total: TimeInterval) {
		let title = "TimerBar"
		let body = "\(Self.format(total)) 倒计时结束"
		DispatchQueue.global(qos: .utility).async {
			if let bin = Self.resolveNotifyBinary() {
				let p = Process()
				p.executableURL = URL(fileURLWithPath: bin)
				// pi-notify: send <title> <body> <activateBundleId> <identifier> <openPath> <sound>
				p.arguments = ["send", title, body, "", "timerbar", "", "Glass"]
				do {
					try p.run()
					p.waitUntilExit()
					return
				} catch {}
			}
			// pi-notify 不可用时的兜底：osascript 原生通知（无点击动作）。
			let p = Process()
			p.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
			p.arguments = ["-e", "display notification \"\(body)\" with title \"\(title)\" sound name \"Glass\""]
			try? p.run()
		}
	}

	/// pi-notify 二进制定位：~/Applications（与本 app 同目录）→ PATH。
	private static func resolveNotifyBinary() -> String? {
		var candidates: [String] = []
		// 本 app 与 pi-notify 均构建到 ~/Applications/。
		let localDir = Bundle.main.bundleURL.deletingLastPathComponent()
		candidates.append(
			localDir.appendingPathComponent("pi-notify.app/Contents/MacOS/pi-notify").path)
		for dir in (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":") {
			candidates.append("\(dir)/pi-notify")
		}
		return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
	}

	// MARK: - UI

	private func refreshUI() {
		renderIcon()
		rebuildMenu()
	}

	/// 秒 → 显示文本：不足 1 小时用 M:SS，否则 H:MM:SS。
	private static func format(_ t: TimeInterval) -> String {
		let s = Int(t.rounded(.up))
		let h = s / 3600, m = (s % 3600) / 60, sec = s % 60
		return h > 0 ? String(format: "%d:%02d:%02d", h, m, sec) : String(format: "%d:%02d", m, sec)
	}

	private var statusText: String {
		let totalStr = Self.format(durationSeconds)
		switch state {
		case .idle: return "待开始 · \(totalStr)"
		case .running: return "运行中 · 剩余 \(Self.format(remaining)) / \(totalStr)"
		case .paused: return "已暂停 · \(Self.format(remaining)) / \(totalStr)"
		}
	}

	/// 状态栏图标：未开始/已暂停 ⌛️，运行中 ⏳（每 5 秒缓慢淡出淡入一次），结束闪 ✅。
	private func renderIcon() {
		var text = "⌛️"
		var alpha: CGFloat = 1
		if flashing {
			text = "✅"
		} else if state == .running {
			text = "⏳"
			alpha = Self.flashAlpha(elapsed: durationSeconds - remaining)
		}
		statusItem.button?.attributedTitle = NSAttributedString(string: text)
		statusItem.button?.alphaValue = alpha
		statusItem.button?.toolTip = flashing ? "倒计时结束 · \(Self.format(durationSeconds))" : statusText
		statusMenuItem?.title = "状态：\(statusText)"
	}

	/// 闪烁波形：5 秒周期 = 4.4s 全亮 + 0.3s 渐暗至 0.35 + 0.3s 渐亮回 1。
	/// emoji 无法用 foregroundColor 淡化，alphaValue 作用于整个按钮，图标一并变淡。
	private static func flashAlpha(elapsed: TimeInterval) -> CGFloat {
		let phase = elapsed.truncatingRemainder(dividingBy: 5)
		if phase < 4.4 { return 1 }
		if phase < 4.7 { return CGFloat(1 - 0.65 * (phase - 4.4) / 0.3) }
		return CGFloat(0.35 + 0.65 * (phase - 4.7) / 0.3)
	}

	private func rebuildMenu() {
		guard let menu = statusItem.menu else { return }
		menu.removeAllItems()

		let statusLine = NSMenuItem(title: "状态：\(statusText)", action: nil, keyEquivalent: "")
		statusLine.isEnabled = false
		menu.addItem(statusLine)
		statusMenuItem = statusLine
		menu.addItem(.separator())

		let totalStr = Self.format(durationSeconds)
		let primary = NSMenuItem(
			title: state == .idle ? "开始（\(totalStr)）" : state == .running ? "暂停" : "继续",
			action: state == .idle ? #selector(startAction)
				: state == .running ? #selector(pauseAction) : #selector(resumeAction),
			keyEquivalent: "")
		primary.target = self
		menu.addItem(primary)

		if state != .idle {
			let reset = NSMenuItem(title: "重置", action: #selector(resetAction), keyEquivalent: "")
			reset.target = self
			menu.addItem(reset)
		}
		menu.addItem(.separator())

		let header = NSMenuItem(title: "时长（选择后立即开始）", action: nil, keyEquivalent: "")
		header.isEnabled = false
		menu.addItem(header)
		for minutes in [1, 5, 10, 15, 25, 30, 45, 60] {
			let item = NSMenuItem(title: "\(minutes) 分钟", action: #selector(presetAction(_:)), keyEquivalent: "")
			item.target = self
			item.representedObject = minutes * 60
			if abs(durationSeconds - Double(minutes * 60)) < 0.5 { item.state = .on }
			menu.addItem(item)
		}
		let custom = NSMenuItem(title: "自定义…", action: #selector(customAction), keyEquivalent: "")
		custom.target = self
		menu.addItem(custom)
		menu.addItem(.separator())

		let quit = NSMenuItem(title: "退出 TimerBar", action: #selector(quitAction), keyEquivalent: "q")
		quit.target = self
		menu.addItem(quit)
	}
}

extension AppDelegate: NSMenuDelegate {
	func menuNeedsUpdate(_ menu: NSMenu) {
		// 打开菜单时同步一次剩余时间显示。
		refreshUI()
	}
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory) // 不占 Dock、不抢焦点
app.run()
