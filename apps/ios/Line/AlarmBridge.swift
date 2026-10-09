import AlarmKit
import SwiftUI

struct ReminderMetadata: AlarmMetadata { var reminderId: String }
struct AlarmRegistration: Codable { var uuid: UUID; var reminderId: String; var revision: Int; var dueAt: String }

@MainActor final class AlarmBridge: ObservableObject {
    @Published var syncing = false
    @Published var message = "打开 APP 后同步手机闹钟"
    private let manager = AlarmManager.shared
    private var registrations: [String: AlarmRegistration] {
        get { guard let data = UserDefaults.standard.data(forKey: "alarmRegistrations") else { return [:] }; return (try? JSONDecoder().decode([String: AlarmRegistration].self, from: data)) ?? [:] }
        set { UserDefaults.standard.set(try? JSONEncoder().encode(newValue), forKey: "alarmRegistrations") }
    }
    private var deviceId: String {
        if let id = UserDefaults.standard.string(forKey: "deviceId") { return id }
        let id = UUID().uuidString; UserDefaults.standard.set(id, forKey: "deviceId"); return id
    }
    private func schedule(id: UUID, date: Date, title: String, reminderId: String) async throws {
        let stop = AlarmButton(text: "停止", textColor: .white, systemImageName: "stop.fill")
        let alert = AlarmPresentation.Alert(title: LocalizedStringResource(stringLiteral: title), stopButton: stop, secondaryButton: nil, secondaryButtonBehavior: nil)
        let presentation = AlarmPresentation(alert: alert)
        let attributes = AlarmAttributes(presentation: presentation, metadata: ReminderMetadata(reminderId: reminderId), tintColor: Color.blue)
        let configuration = AlarmManager.AlarmConfiguration.alarm(schedule: .fixed(date), attributes: attributes)
        _ = try await manager.schedule(id: id, configuration: configuration)
    }
    func minuteTest() async {
        guard !syncing else { return }
        do {
            guard try await manager.requestAuthorization() == .authorized else { throw LineError.message("请在系统设置允许 Line 使用闹钟") }
            let id = UUID(), date = Date().addingTimeInterval(60)
            var map = registrations; map["test:\(id.uuidString)"] = AlarmRegistration(uuid: id, reminderId: "test", revision: 0, dueAt: Dates.iso(date)); registrations = map
            try await schedule(id: id, date: date, title: "Line 一分钟闹钟测试", reminderId: "test")
            message = "测试闹钟将在一分钟后响起，请锁屏验证。"
        } catch { message = error.localizedDescription }
    }
    func sync(api: API) async {
        guard !syncing, api.logged else { return }; syncing = true; defer { syncing = false }
        do {
            let snapshot: SyncSnapshot = try await api.get("/sync")
            guard let time = Dates.parse(snapshot.serverTime), abs(time.timeIntervalSinceNow) < 60 else { throw LineError.message("手机时间与后台偏差较大，请校准时间后同步") }
            let expected = Dictionary(uniqueKeysWithValues: snapshot.alarms.map { ($0.occurrenceKey, $0) })
            var map = registrations, failures: [String: String] = [:]
            var actual = Set(try manager.alarms.map(\.id))
            // A reinstall or interrupted persistence can leave an alarm without a local mapping.
            let tracked = Set(map.values.map(\.uuid))
            for orphan in actual.subtracting(tracked) { try manager.cancel(id: orphan); actual.remove(orphan) }
            // Remove stale revisions first. Persist each result so an interrupted sync can be recovered.
            for (key, entry) in map {
                if entry.reminderId == "test", let due = Dates.parse(entry.dueAt), due > Date() { continue }
                if expected[key] == nil {
                    do { if actual.contains(entry.uuid) { try manager.cancel(id: entry.uuid); actual.remove(entry.uuid) }; map.removeValue(forKey: key); registrations = map }
                    catch { failures[entry.reminderId] = "旧闹钟移除失败，请重新同步" }
                }
            }
            if !snapshot.alarms.isEmpty {
                guard try await manager.requestAuthorization() == .authorized else { throw LineError.message("闹钟权限未授予；旧闹钟仍可能存在，请检查系统设置") }
            }
            for alarm in snapshot.alarms {
                guard failures[alarm.reminderId] == nil, let due = Dates.parse(alarm.dueAt), due > Date() else { continue }
                let entry = map[alarm.occurrenceKey] ?? AlarmRegistration(uuid: UUID(), reminderId: alarm.reminderId, revision: alarm.revision, dueAt: alarm.dueAt)
                map[alarm.occurrenceKey] = entry; registrations = map // Save UUID before scheduling to recover after a crash.
                if !actual.contains(entry.uuid) {
                    do { try await schedule(id: entry.uuid, date: due, title: alarm.title, reminderId: alarm.reminderId); actual.insert(entry.uuid) }
                    catch { failures[alarm.reminderId] = "系统闹钟登记失败：\(error.localizedDescription)" }
                }
            }
            actual = Set(try manager.alarms.map(\.id))
            struct Ack: Encodable { var reminderId: String; var deviceId: String; var revision: Int; var status: String; var coverageUntil: String?; var error: String? }
            for reminder in snapshot.reminders {
                if reminder.syncStatus == "not_required" { continue }
                let expectedEntries = snapshot.alarms.filter { $0.reminderId == reminder.id }
                let verified = expectedEntries.allSatisfy { item in guard let entry = map[item.occurrenceKey] else { return false }; return actual.contains(entry.uuid) }
                let stale = map.contains { key, entry in entry.reminderId == reminder.id && expected[key] == nil && actual.contains(entry.uuid) }
                let success = verified && !stale && failures[reminder.id] == nil
                let _: OK = try await api.send("/sync/ack", value: Ack(reminderId: reminder.id, deviceId: deviceId, revision: reminder.revision, status: success ? "registered" : "failed", coverageUntil: success && reminder.status == "active" && reminder.channels.alarm ? snapshot.coverageUntil : nil, error: success ? nil : failures[reminder.id] ?? "部分闹钟未登记或旧闹钟仍存在"))
            }
            message = failures.isEmpty ? "手机已同步，重复闹钟覆盖至 \(Dates.display(snapshot.coverageUntil))" : "部分闹钟同步失败，请查看提醒列表"
        } catch { message = "同步未完成：\(error.localizedDescription)。旧闹钟可能仍存在。" }
    }
    func removeAll() throws {
        var map = registrations
        let actual = Set(try manager.alarms.map(\.id))
        for (key, entry) in map { if actual.contains(entry.uuid) { try manager.cancel(id: entry.uuid) }; map.removeValue(forKey: key); registrations = map }
    }
}
