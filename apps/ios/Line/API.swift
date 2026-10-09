import Foundation
import Security
import SwiftUI

struct Channels: Codable { var alarm: Bool; var web: Bool; var wechat: Bool }
struct ReminderInput: Codable {
    var title: String; var content: String; var dueAt: String; var recurrence: String
    var weekdays: [Int]; var recipientIds: [String]; var channels: Channels
}
struct Reminder: Codable, Identifiable {
    var id: String; var title: String; var content: String; var dueAt: String; var recurrence: String
    var weekdays: [Int]; var recipientIds: [String]; var channels: Channels
    var revision: Int; var status: String; var syncStatus: String
    var coverageUntil: String?; var syncError: String?
    var nextDueAt: String?
    var input: ReminderInput { .init(title: title, content: content, dueAt: dueAt, recurrence: recurrence, weekdays: weekdays, recipientIds: recipientIds, channels: channels) }
}
struct Contact: Codable, Identifiable { var id: String; var name: String; var aliases: [String]; var hasToken: Bool }
struct Draft: Codable { var id: String; var reminder: ReminderInput; var expiresAt: String }
struct ParseResult: Codable { var draft: Draft?; var question: String? }
struct Provider: Codable { var kind: String; var adapter: String; var baseUrl: String; var model: String; var voice: String; var enabled: Bool; var hasKey: Bool; var keyMask: String }
struct ModelSettings: Codable { var providers: [String: Provider]; var hasPushToken: Bool; var pushTokenMask: String; var hasPushSecret: Bool; var timezone: String; var vapidPublicKey: String }
struct SyncAlarm: Codable { var occurrenceKey: String; var reminderId: String; var revision: Int; var dueAt: String; var title: String }
struct SyncSnapshot: Codable { var serverTime: String; var coverageUntil: String; var reminders: [Reminder]; var alarms: [SyncAlarm] }
struct Delivery: Codable, Identifiable { var id: String; var title: String; var dueAt: String; var recipientId: String; var channel: String; var status: String; var error: String? }
struct Message: Codable { var role: String; var content: String }
struct OK: Codable { var ok: Bool }
struct ErrorResponse: Codable { var error: String }
struct TextResponse: Codable { var text: String }
enum LineError: LocalizedError { case message(String); var errorDescription: String? { if case .message(let s) = self { return s }; return nil } }

enum Dates {
    static func parse(_ string: String) -> Date? {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.date(from: string) ?? ISO8601DateFormatter().date(from: string)
    }
    static func iso(_ date: Date) -> String { let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f.string(from: date) }
    static func display(_ date: String) -> String { let f = DateFormatter(); f.locale = Locale(identifier: "zh_CN"); f.timeZone = TimeZone(identifier: "Asia/Shanghai"); f.dateFormat = "M月d日 EEEE HH:mm"; return parse(date).map(f.string) ?? date }
}

enum Keychain {
    static let service = "local.line.voice-reminders"
    static func token(_ server: String) -> String? {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: server, kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var value: CFTypeRef?; guard SecItemCopyMatching(q as CFDictionary, &value) == errSecSuccess, let data = value as? Data else { return nil }; return String(data: data, encoding: .utf8)
    }
    static func save(_ token: String?, server: String) throws {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: server]
        SecItemDelete(q as CFDictionary)
        if let token { var item = q; item[kSecValueData as String] = Data(token.utf8); item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else { throw LineError.message("无法将登录凭据保存到钥匙串") }
        }
    }
}

@MainActor final class API: ObservableObject {
    @Published var server = UserDefaults.standard.string(forKey: "server") ?? ""
    @Published var logged = false
    @Published var error: String?
    var token: String? { Keychain.token(server) }
    init() { logged = !server.isEmpty && token != nil }
    func request(_ path: String, method: String = "GET", body: Data? = nil, mime: String = "application/json") async throws -> Data {
        guard let base = URL(string: server), ["https", "http"].contains(base.scheme ?? ""), base.user == nil, base.password == nil, base.query == nil, base.fragment == nil,
              let url = URL(string: server.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/api" + path) else { throw LineError.message("请输入正确的后台地址") }
        #if !DEBUG
        guard base.scheme == "https" else { throw LineError.message("正式版本需要 HTTPS 后台地址") }
        #endif
        var r = URLRequest(url: url); r.httpMethod = method; r.httpBody = body; r.timeoutInterval = 100
        if let token { r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if body != nil { r.setValue(mime, forHTTPHeaderField: "Content-Type") }
        let (data, response) = try await URLSession.shared.data(for: r)
        guard let http = response as? HTTPURLResponse else { throw LineError.message("后台响应无效") }
        if http.statusCode == 401 { logged = false }
        guard (200..<300).contains(http.statusCode) else { throw LineError.message((try? JSONDecoder().decode(ErrorResponse.self, from: data).error) ?? "请求未成功（\(http.statusCode)）") }
        return data
    }
    func get<T: Decodable>(_ path: String) async throws -> T { try JSONDecoder().decode(T.self, from: await request(path)) }
    func send<T: Decodable>(_ path: String, method: String = "POST", value: some Encodable) async throws -> T { try JSONDecoder().decode(T.self, from: await request(path, method: method, body: JSONEncoder().encode(value))) }
    func login(username: String, password: String) async throws {
        struct Input: Encodable { var username: String; var password: String; var client = "ios" }
        struct Result: Decodable { var token: String }
        let result: Result = try await send("/auth/login", value: Input(username: username, password: password))
        try Keychain.save(result.token, server: server); UserDefaults.standard.set(server, forKey: "server"); logged = true
    }
    func logout() async { _ = try? await request("/logout", method: "POST", body: Data("{}".utf8)); try? Keychain.save(nil, server: server); logged = false }
    func transcribe(_ audio: Data) async throws -> String {
        let boundary = "Line-\(UUID().uuidString)"
        var data = Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"voice.wav\"\r\nContent-Type: audio/wav\r\n\r\n".utf8)
        data.append(audio); data.append(Data("\r\n--\(boundary)--\r\n".utf8))
        return try JSONDecoder().decode(TextResponse.self, from: await request("/transcribe", method: "POST", body: data, mime: "multipart/form-data; boundary=\(boundary)")).text
    }
}
