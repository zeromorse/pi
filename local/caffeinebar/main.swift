import Cocoa
import IOKit.ps

// CaffeineBar — 菜单栏防休眠开关
// ☕️ = caffeinate -s 运行中（接电源时合盖不休眠）
// 🔋 = 用户想开，但当前电池供电，防休眠已暂停（插电自动恢复）
// 💤 = 用户手动关闭

var sharedDelegate: AppDelegate?

// IOKit 电源回调（C 函数指针，不能捕获上下文，走全局变量）
private let powerSourceCallback: IOPowerSourceCallbackType = { _ in
    DispatchQueue.main.async { sharedDelegate?.powerStateChanged() }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var caffeinateTask: Process?
    private var intentionalStop = false

    // 用户意图：开关本身是否想开（持久化，默认开）
    private var _userWantsOn = true
    private var userWantsOn: Bool {
        get { _userWantsOn }
        set { _userWantsOn = newValue; UserDefaults.standard.set(newValue, forKey: "userWantsOn") }
    }

    private var onACPower = true
    private var effectiveOn: Bool { userWantsOn && onACPower }

    func applicationDidFinishLaunching(_ notification: Notification) {
        sharedDelegate = self
        if UserDefaults.standard.object(forKey: "userWantsOn") != nil {
            _userWantsOn = UserDefaults.standard.bool(forKey: "userWantsOn")
        }

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.toolTip = "防休眠开关：接电源时合盖保持运行"
        let menu = NSMenu()
        menu.delegate = self
        menu.autoenablesItems = false
        statusItem.menu = menu

        onACPower = Self.checkACPower()
        if effectiveOn { startCaffeinate() }

        // 监听电源变化（插拔电源线即时响应）
        if let blob = IOPSNotificationCreateRunLoopSource(powerSourceCallback, nil)?.takeRetainedValue() {
            CFRunLoopAddSource(CFRunLoopGetMain(), blob, .defaultMode)
        }
        refreshUI()
    }

    // MARK: - 电源检测

    static func checkACPower() -> Bool {
        guard let snapshot = IOPSCopyPowerSourcesInfo()?.takeRetainedValue(),
              let sources = IOPSCopyPowerSourcesList(snapshot)?.takeRetainedValue() as? [CFTypeRef] else {
            return true // 拿不到信息时保守视为接电源
        }
        var sawPowerSource = false
        for ps in sources {
            guard let desc = IOPSGetPowerSourceDescription(snapshot, ps)?.takeUnretainedValue() as? [String: Any] else { continue }
            if let state = desc[kIOPSPowerSourceStateKey] as? String {
                sawPowerSource = true
                if state == kIOPSBatteryPowerValue { return false } // 任一电池在放电 → 电池供电
            }
        }
        return true // 全部在充电 / 无电池设备（台式机）
    }

    func powerStateChanged() {
        let now = Self.checkACPower()
        guard now != onACPower else { return }
        onACPower = now
        if effectiveOn {
            startCaffeinate()
        } else {
            stopCaffeinate()
        }
        refreshUI()
    }

    // MARK: - 控制逻辑

    private func startCaffeinate() {
        guard caffeinateTask == nil else { return }
        intentionalStop = false
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/caffeinate")
        task.arguments = ["-s"]
        task.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async {
                guard let self, self.caffeinateTask != nil else { return }
                self.caffeinateTask = nil
                if !self.intentionalStop && self.effectiveOn {
                    self.startCaffeinate() // 意外退出自动拉起
                } else {
                    self.refreshUI()
                }
            }
        }
        do {
            try task.run()
            caffeinateTask = task
        } catch {
            NSLog("caffeinate 启动失败: \(error.localizedDescription)")
        }
        refreshUI()
    }

    private func stopCaffeinate() {
        intentionalStop = true
        caffeinateTask?.terminate()
        caffeinateTask = nil
        refreshUI()
    }

    // MARK: - UI

    private func refreshUI() {
        let icon: String, status: String
        if effectiveOn {
            icon = "☕️"
            status = "状态：防休眠已开启（接电源 · 合盖不休眠）"
        } else if userWantsOn && !onACPower {
            icon = "🔋"
            status = "状态：电池供电，防休眠已暂停（插电自动恢复）"
        } else {
            icon = "💤"
            status = "状态：已关闭（合盖正常休眠）"
        }
        statusItem.button?.title = icon
        statusItem.menu?.removeAllItems()

        let statusLine = NSMenuItem(title: status, action: nil, keyEquivalent: "")
        statusLine.isEnabled = false
        statusItem.menu?.addItem(statusLine)
        statusItem.menu?.addItem(.separator())

        let toggleItem = NSMenuItem(title: userWantsOn ? "💤 关闭防休眠" : "☕️ 开启防休眠",
                                    action: #selector(toggleAction), keyEquivalent: "")
        toggleItem.target = self
        statusItem.menu?.addItem(toggleItem)

        statusItem.menu?.addItem(.separator())

        let quitItem = NSMenuItem(title: "退出 CaffeineBar", action: #selector(quitAction), keyEquivalent: "q")
        quitItem.target = self
        statusItem.menu?.addItem(quitItem)
    }

    // MARK: - Actions

    @objc private func toggleAction() {
        userWantsOn.toggle()
        if effectiveOn { startCaffeinate() } else { stopCaffeinate() }
        refreshUI()
    }

    @objc private func quitAction() {
        stopCaffeinate()
        NSApp.terminate(self)
    }
}

extension AppDelegate: NSMenuDelegate {
    func menuNeedsUpdate(_ menu: NSMenu) {
        // 点开菜单前同步一次真实状态
        let now = Self.checkACPower()
        if now != onACPower { powerStateChanged() }
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory) // 不占 Dock、不抢焦点
app.run()
