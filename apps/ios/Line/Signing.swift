import Foundation
import UserNotifications

enum Signing {
    // The installed, signed bundle is the source of truth; a build date is not a signing expiry.
    static var expiresAt: Date? {
        guard let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
              let data = try? Data(contentsOf: url) else { return nil }
        let text = String(decoding: data, as: UTF8.self)
        guard let start = text.range(of: "<?xml"), let end = text.range(of: "</plist>", range: start.lowerBound..<text.endIndex),
              let plist = try? PropertyListSerialization.propertyList(from: Data(text[start.lowerBound..<end.upperBound].utf8), options: [], format: nil) as? [String: Any] else { return nil }
        return plist["ExpirationDate"] as? Date
    }
    static var needsUpdate: Bool { expiresAt.map { $0.timeIntervalSinceNow < 86400 } ?? false }
    static func enableNotice() async throws -> String {
        guard let expiry = expiresAt else { throw LineError.message("未读取到签名到期日期，请按安装日期在第6天更新") }
        let center = UNUserNotificationCenter.current()
        guard try await center.requestAuthorization(options: [.alert, .sound]) else { throw LineError.message("签名更新通知权限未授予，请在系统设置检查") }
        center.removePendingNotificationRequests(withIdentifiers: ["line-signing-expiry"])
        guard expiry.timeIntervalSinceNow > 86400 else { return "签名即将到期或已到期，请现在重新安装并验证闹钟。" }
        let content = UNMutableNotificationContent(); content.title = "请更新 Line 验证版"; content.body = "开发签名将在一天后到期。请用 Xcode 重新安装，打开 APP 同步并验证闹钟。"; content.sound = .default
        let trigger = UNTimeIntervalNotificationTrigger(timeInterval: expiry.timeIntervalSinceNow - 86400, repeats: false)
        try await center.add(UNNotificationRequest(identifier: "line-signing-expiry", content: content, trigger: trigger))
        return "已安排签名到期前一天的本机更新提醒。"
    }
}
