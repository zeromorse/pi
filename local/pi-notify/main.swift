// pi-notify: tiny macOS notification tool built on UNUserNotification.
//
// Usage:
//   pi-notify send <title> <body> [activateBundleId] [identifier]
//
// - Sends a notification, then exits.
// - Reusing an identifier replaces the previous notification (no piling up).
// - When the user clicks the notification, macOS relaunches this app with no
//   arguments; the didReceive handler activates the app whose bundle id was
//   recorded in the notification's userInfo, then exits.

import Cocoa
import UserNotifications

final class NotificationCenterDelegate: NSObject, UNUserNotificationCenterDelegate {
	func userNotificationCenter(
		_ center: UNUserNotificationCenter,
		didReceive response: UNNotificationResponse,
		withCompletionHandler completionHandler: @escaping () -> Void
	) {
		let info = response.notification.request.content.userInfo
		if let bundleId = info["activateBundleId"] as? String,
			!bundleId.isEmpty,
			let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId)
		{
			let config = NSWorkspace.OpenConfiguration()
			config.activates = true
			NSWorkspace.shared.openApplication(at: url, configuration: config) { _, _ in
				exit(0)
			}
			return
		}
		completionHandler()
		exit(0)
	}

	func userNotificationCenter(
		_ center: UNUserNotificationCenter,
		willPresent notification: UNNotification,
		withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
	) {
		completionHandler([.banner])
	}
}

let args = CommandLine.arguments
let center = UNUserNotificationCenter.current()
let delegate = NotificationCenterDelegate()
center.delegate = delegate

func send(title: String, body: String, activateBundleId: String, identifier: String) -> Never {
	let content = UNMutableNotificationContent()
	content.title = title
	content.body = body
	content.userInfo = ["activateBundleId": activateBundleId]
	let request = UNNotificationRequest(identifier: identifier, content: content, trigger: nil)
	let sem = DispatchSemaphore(value: 0)
	center.requestAuthorization(options: [.alert]) { _, _ in
		center.add(request) { _ in sem.signal() }
	}
	sem.wait()
	// Give the notification daemon a moment to pick it up before exiting.
	Thread.sleep(forTimeInterval: 0.2)
	exit(0)
}

if args.count >= 2 && args[1] == "status" {
	let sem = DispatchSemaphore(value: 0)
	center.getNotificationSettings { settings in
		let statusName: String
		switch settings.authorizationStatus {
		case .notDetermined: statusName = "notDetermined (0) - permission prompt never shown"
		case .denied: statusName = "denied (1) - user or system rejected"
		case .authorized: statusName = "authorized (2)"
		case .provisional: statusName = "provisional (3)"
		case .ephemeral: statusName = "ephemeral (4)"
		@unknown default: statusName = "unknown (\(settings.authorizationStatus.rawValue))"
		}
		print("authorizationStatus:", statusName)
		print("alertSetting:", settings.alertSetting.rawValue)
		sem.signal()
	}
	sem.wait()
	exit(0)
}

if args.count >= 2 && args[1] == "send" {
	let title = args.count > 2 ? args[2] : "pi"
	let body = args.count > 3 ? args[3] : ""
	let bundleId = args.count > 4 ? args[4] : ""
	let identifier = args.count > 5 ? args[5] : "pi-notify"
	send(title: title, body: body, activateBundleId: bundleId, identifier: identifier)
} else {
	// Relaunched by the system on notification click. Run the event loop so
	// didReceive can fire; exit from the callback or after a timeout.
	DispatchQueue.main.asyncAfter(deadline: .now() + 10) { exit(0) }
	NSApplication.shared.run()
	exit(0)
}
