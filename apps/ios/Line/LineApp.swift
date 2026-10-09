import SwiftUI

let lineBlue = Color(red: 0.44, green: 0.61, blue: 0.88)
let lineBackground = Color(red: 0.96, green: 0.97, blue: 0.99)

@main struct LineApp: App {
    @StateObject private var api = API()
    @StateObject private var alarms = AlarmBridge()
    var body: some Scene { WindowGroup { RootView().environmentObject(api).environmentObject(alarms).tint(lineBlue) } }
}

@MainActor final class Workspace: ObservableObject {
    @Published var reminders: [Reminder] = []
    @Published var contacts: [Contact] = []
    @Published var settings: ModelSettings?
    @Published var deliveries: [Delivery] = []
    @Published var error: String?
    func refresh(_ api: API) async {
        do { reminders = try await api.get("/reminders"); contacts = try await api.get("/contacts"); settings = try await api.get("/settings"); deliveries = try await api.get("/deliveries") }
        catch { self.error = error.localizedDescription }
    }
}

struct RootView: View {
    @EnvironmentObject var api: API
    @EnvironmentObject var alarms: AlarmBridge
    @Environment(\.scenePhase) var phase
    @StateObject var workspace = Workspace()
    @State private var tab = 0
    var body: some View {
        Group {
            if api.logged {
                TabView(selection: $tab) {
                    AssistantView().tabItem { Label("助理", systemImage: "mic") }.tag(0)
                    RemindersView().tabItem { Label("提醒", systemImage: "bell") }.tag(1)
                    ContactsView().tabItem { Label("联系人", systemImage: "person.2") }.tag(2)
                    SettingsView().tabItem { Label("设置", systemImage: "slider.horizontal.3") }.tag(3)
                }.environmentObject(workspace)
                .task { await workspace.refresh(api); await alarms.sync(api: api); await workspace.refresh(api); if Signing.needsUpdate { workspace.error = "开发签名将在一天内到期或已经到期，请用 Xcode 更新安装，再验证系统闹钟。" } }
            } else { LoginView() }
        }.onChange(of: phase) { _, next in if next == .active && api.logged { Task { await alarms.sync(api: api); await workspace.refresh(api); if Signing.needsUpdate { workspace.error = "开发签名即将到期，请重新安装并验证系统闹钟。" } } } }
        .alert("提示", isPresented: Binding(get: { workspace.error != nil }, set: { if !$0 { workspace.error = nil } })) { Button("知道了") { workspace.error = nil } } message: { Text(workspace.error ?? "") }
    }
}

struct LoginView: View {
    @EnvironmentObject var api: API
    @State private var username = "", password = "", error = "", busy = false
    var body: some View {
        ZStack {
            lineBackground.ignoresSafeArea()
            VStack(alignment: .leading, spacing: 24) {
                Label("Line.", systemImage: "mic.circle.fill").font(.largeTitle).foregroundStyle(lineBlue)
                Text("欢迎回来，\n今天也从容一点。").font(.system(size: 29, weight: .medium)).lineSpacing(10)
                Text("先在电脑网页建立管理账号，再登录手机。手机使用相同的后台地址。") .font(.footnote).foregroundStyle(.secondary)
                TextField("后台地址，例如 https://line.example.com", text: $api.server).textContentType(.URL).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                TextField("管理账号", text: $username).textContentType(.username).textInputAutocapitalization(.never).autocorrectionDisabled()
                SecureField("密码", text: $password).textContentType(.password)
                if !error.isEmpty { Text(error).font(.footnote).foregroundStyle(.red) }
                Button { busy = true; Task { do { try await api.login(username: username, password: password) } catch { self.error = error.localizedDescription }; busy = false } } label: { Text(busy ? "正在登录…" : "进入私人空间").frame(maxWidth: .infinity).padding(13) }.buttonStyle(.borderedProminent).disabled(busy || username.isEmpty || password.isEmpty)
                Text("凭据保存在 iPhone 钥匙串中").font(.caption).foregroundStyle(.secondary).frame(maxWidth: .infinity)
            }.textFieldStyle(.roundedBorder).padding(28).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 28)).padding(22)
        }
    }
}

struct AssistantView: View {
    @EnvironmentObject var api: API
    @EnvironmentObject var alarms: AlarmBridge
    @EnvironmentObject var workspace: Workspace
    @Environment(\.scenePhase) var phase
    @StateObject private var voice = Voice()
    @State private var text = "", messages: [Message] = [], draft: Draft?, busy = false, manual = false, generation = UUID()
    private var review: String { guard let draft else { return "" }; return "\(Dates.display(draft.reminder.dueAt))，提醒\(draft.reminder.recipientIds.map { id in id == "self" ? "我自己" : workspace.contacts.first(where: { $0.id == id })?.name ?? "联系人" }.joined(separator: "和"))：\(draft.reminder.title)。请说确认，或说明需要调整的内容。" }
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 24) {
                    Text("YOUR EVERYDAY COMPANION").font(.system(size: 9, weight: .medium)).tracking(2).foregroundStyle(lineBlue.opacity(0.65)).padding(.top, 26)
                    Text("说一声，\n我帮你记着。").font(.system(size: 34, weight: .medium)).multilineTextAlignment(.center).lineSpacing(10)
                    Text("让小事有着落，让每一天从容一点。").font(.footnote).foregroundStyle(.secondary)
                    ZStack {
                        Circle().fill(lineBlue.opacity(0.035)).frame(width: 240, height: 240)
                        Circle().fill(lineBlue.opacity(0.07)).frame(width: 196, height: 196)
                        Button { if voice.state == "listening" { voice.finish() } else { Task { await start() } } } label: {
                            Image(systemName: voice.state == "listening" ? "waveform" : voice.state == "thinking" ? "ellipsis" : "mic").font(.system(size: 45, weight: .light)).foregroundStyle(.white).frame(width: 146, height: 146).background(LinearGradient(colors: [Color(red: 0.65, green: 0.80, blue: 0.98), lineBlue], startPoint: .topLeading, endPoint: .bottomTrailing), in: Circle()).shadow(color: lineBlue.opacity(0.20), radius: 18, y: 12)
                        }.disabled(voice.state == "greeting" || voice.state == "thinking" || busy)
                    }.padding(.vertical, -4)
                    Text(voice.state == "listening" ? "正在聆听，停顿 2 秒后提交" : voice.state == "greeting" ? "我在和你说话…" : voice.state == "thinking" ? "正在整理提醒…" : "轻触麦克风，说出你的安排").font(.footnote).foregroundStyle(.secondary)
                    if voice.state != "idle" { Button("结束对话") { cancel() }.font(.caption) }
                    if let draft {
                        VStack(alignment: .leading, spacing: 14) {
                            Text("准备好这条提醒了").font(.subheadline).foregroundStyle(lineBlue)
                            Text(draft.reminder.title).font(.title3)
                            Text(review).font(.footnote).foregroundStyle(.secondary)
                            if draft.reminder.channels.alarm { Text("保存后会同步手机系统闹钟，请查看登记结果。").font(.caption).foregroundStyle(.secondary) }
                            HStack { Button("放弃") { cancel(); self.draft = nil }.buttonStyle(.bordered); Spacer(); Button(busy ? "正在保存…" : "确认保存") { Task { await confirm(spoken: false) } }.buttonStyle(.borderedProminent).disabled(busy) }
                        }.padding(22).glassCard()
                    }
                    ForEach(Array(messages.suffix(4).enumerated()), id: \.offset) { _, item in Text("\(item.role == "user" ? "你" : "Line")：\(item.content)").font(.footnote).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading).padding(16).glassCard() }
                    HStack { TextField("也可以打字告诉我…", text: $text); Button { let value = text; text = ""; Task { await submit(value, endedAt: Dates.iso(Date()), spoken: false) } } label: { Image(systemName: "arrow.up.circle.fill").font(.title2) }.disabled(text.trimmingCharacters(in: .whitespaces).isEmpty || busy || voice.state != "idle") }.padding(16).glassCard()
                    Button { cancel(); manual = true } label: { Label("手动建立提醒", systemImage: "plus") }.font(.footnote)
                    VStack(alignment: .leading, spacing: 10) { Label("接下来的安排", systemImage: "clock").font(.caption).foregroundStyle(.secondary)
                        if let r = workspace.reminders.filter({ $0.status == "active" && $0.nextDueAt != nil }).sorted(by: { ($0.nextDueAt ?? "") < ($1.nextDueAt ?? "") }).first { Text(r.title).font(.subheadline); Text(Dates.display(r.nextDueAt ?? r.dueAt)).font(.caption).foregroundStyle(.secondary) } else { Text("还没有安排，给今天留一点轻松。").font(.footnote).foregroundStyle(.secondary) }
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(22).glassCard()
                    Text("录音仅用于识别，处理后即删除").font(.caption2).foregroundStyle(.tertiary)
                }.padding(.horizontal, 24).padding(.bottom, 30)
            }.background(lineBackground).navigationTitle("Line.").navigationBarTitleDisplayMode(.inline)
            .sheet(isPresented: $manual) { ReminderEditor { value in let result: Draft = try await api.send("/drafts", value: value); draft = result; manual = false } }
        }.onDisappear { cancel() }.onChange(of: phase) { _, next in if next != .active { cancel() } }
    }
    private func cancel() { generation = UUID(); voice.cancel() }
    private func start() async {
        guard workspace.settings?.providers["asr"]?.enabled == true, workspace.settings?.providers["llm"]?.enabled == true else { workspace.error = "请先在设置中启用语音识别和文字理解，也可以手动建立提醒"; return }
        cancel(); let current = generation
        do { try await voice.speak(draft == nil ? "你好，我在。有什么需要我提醒你的？" : "请确认这条提醒，或告诉我需要调整的内容。", api: api, settings: workspace.settings); guard generation == current else { return }; try await listen(current) }
        catch { if generation == current { workspace.error = error.localizedDescription; voice.state = "idle" } }
    }
    private func listen(_ current: UUID) async throws {
        try await voice.record { result in Task { @MainActor in
            guard generation == current else { return }
            do { let (audio, endedAt) = try result.get(); let text = try await api.transcribe(audio); guard generation == current else { return }; await submit(text, endedAt: endedAt, spoken: true) }
            catch { if generation == current { workspace.error = error.localizedDescription; voice.state = "idle" } }
        } }
    }
    private func submit(_ value: String, endedAt: String, spoken: Bool) async {
        guard !busy, !value.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        let current = generation
        if draft != nil && ["确认", "确认。", "确定", "好的", "确认建立"].contains(value.trimmingCharacters(in: .whitespacesAndNewlines)) { messages.append(Message(role: "user", content: value)); await confirm(spoken: spoken); return }
        busy = true; voice.state = "thinking"
        do {
            struct Input: Encodable { var text: String; var endedAt: String; var context: [Message] }
            let input = Input(text: value, endedAt: endedAt, context: Array(messages.suffix(12)))
            messages.append(Message(role: "user", content: value))
            let result: ParseResult = try await api.send("/parse", value: input)
            guard generation == current else { busy = false; return }; draft = result.draft
            let reply = result.question ?? review; messages.append(Message(role: "assistant", content: reply)); busy = false
            if spoken { try await voice.speak(reply, api: api, settings: workspace.settings); if generation == current { try await listen(current) } } else { voice.state = "idle" }
        } catch { busy = false; if generation == current { workspace.error = error.localizedDescription; voice.state = "idle" } }
    }
    private func confirm(spoken: Bool) async {
        guard let draft, !busy else { return }; busy = true; voice.cancel(); let current = generation
        do { let _: Reminder = try await api.send("/drafts/\(draft.id)/confirm", value: ["confirmed": true]); self.draft = nil
            await alarms.sync(api: api); await workspace.refresh(api)
            messages.append(Message(role: "assistant", content: "提醒已保存。\(alarms.message)"))
            if spoken && generation == current { try await voice.speak("好的，提醒已保存。", api: api, settings: workspace.settings) }
        } catch { workspace.error = error.localizedDescription }
        busy = false; voice.state = "idle"
    }
}

struct RemindersView: View {
    @EnvironmentObject var api: API
    @EnvironmentObject var alarms: AlarmBridge
    @EnvironmentObject var workspace: Workspace
    @State private var create = false, editing: Reminder?, cancelling: Reminder?
    var body: some View {
        NavigationStack {
            List {
                Section { Button { Task { await alarms.sync(api: api); await workspace.refresh(api) } } label: { Label(alarms.syncing ? "正在同步…" : "同步手机闹钟", systemImage: "arrow.triangle.2.circlepath") }.disabled(alarms.syncing); Text(alarms.message).font(.caption).foregroundStyle(.secondary) }
                Section("我的提醒") {
                    if workspace.reminders.isEmpty { Text("还没有安排，建立第一条提醒吧。").foregroundStyle(.secondary) }
                    ForEach(workspace.reminders) { r in VStack(alignment: .leading, spacing: 10) {
                        HStack { Text(r.title).font(.headline); Spacer(); if r.status == "cancelled" { Text("已取消").font(.caption).foregroundStyle(.secondary) } }
                        Text("\(Dates.display(r.dueAt)) · \(recurrenceLabel(r.recurrence))").font(.caption).foregroundStyle(.secondary)
                        Text(syncLabel(r)).font(.caption).foregroundStyle(r.syncStatus == "registered" ? .green : .orange)
                        if let coverage = r.coverageUntil, r.status == "active" { Text("覆盖至 \(Dates.display(coverage))").font(.caption2).foregroundStyle(.secondary) }
                        if let error = r.syncError { Text(error).font(.caption).foregroundStyle(.red) }
                        if r.status == "active" { HStack { Button("修改") { editing = r }; Spacer(); Button("取消系列", role: .destructive) { cancelling = r } }.font(.caption).buttonStyle(.borderless) }
                    }.padding(.vertical, 8) }
                }
                Section("通知记录（不代表已阅读）") { ForEach(workspace.deliveries.prefix(30)) { d in VStack(alignment: .leading, spacing: 6) { Text(d.title).font(.subheadline); Text("\(d.channel == "web" ? "电脑" : "公众号") · \(deliveryLabel(d.status)) · \(Dates.display(d.dueAt))").font(.caption).foregroundStyle(.secondary); if let error = d.error { Text(error).font(.caption2).foregroundStyle(.secondary) } } } }
            }.scrollContentBackground(.hidden).background(lineBackground).navigationTitle("提醒")
            .toolbar { Button { create = true } label: { Image(systemName: "plus") } }
            .refreshable { await alarms.sync(api: api); await workspace.refresh(api) }
            .sheet(isPresented: $create) { ReminderEditor { value in let draft: Draft = try await api.send("/drafts", value: value); let _: Reminder = try await api.send("/drafts/\(draft.id)/confirm", value: ["confirmed": true]); create = false; await alarms.sync(api: api); await workspace.refresh(api) } }
            .sheet(item: $editing) { reminder in ReminderEditor(editing: reminder) { value in struct Input: Encodable { var revision: Int; var confirmed = true; var reminder: ReminderInput }; let _: Reminder = try await api.send("/reminders/\(reminder.id)", method: "PUT", value: Input(revision: reminder.revision, reminder: value)); editing = nil; await alarms.sync(api: api); await workspace.refresh(api) } }
            .confirmationDialog("取消整个提醒系列？旧闹钟将在手机同步后移除。", isPresented: Binding(get: { cancelling != nil }, set: { if !$0 { cancelling = nil } })) { Button("取消提醒", role: .destructive) { if let r = cancelling { Task { do { let _: Reminder = try await api.send("/reminders/\(r.id)", method: "DELETE", value: ["revision": r.revision]); await alarms.sync(api: api); await workspace.refresh(api) } catch { workspace.error = error.localizedDescription } } }; cancelling = nil } }
        }
    }
}

struct ReminderEditor: View {
    @EnvironmentObject var workspace: Workspace
    @Environment(\.dismiss) var dismiss
    var editing: Reminder?
    var onSave: (ReminderInput) async throws -> Void
    @State private var title = "", content = "", due = Date().addingTimeInterval(3600), recurrence = "once", weekdays: Set<Int> = [], recipients: Set<String> = ["self"], alarm = true, web = true, wechat = false, error = "", busy = false, confirming = false
    private var input: ReminderInput { .init(title: title, content: content, dueAt: Dates.iso(due), recurrence: recurrence, weekdays: weekdays.sorted(), recipientIds: Array(recipients).sorted(), channels: .init(alarm: alarm && recipients.contains("self"), web: web && recipients.contains("self"), wechat: wechat)) }
    var body: some View {
        NavigationStack { Form {
            Section("提醒安排") { TextField("提醒内容", text: $title); DatePicker("北京时间", selection: $due, in: Date()...).environment(\.timeZone, TimeZone(identifier: "Asia/Shanghai")!); Picker("重复", selection: $recurrence) { Text("仅一次").tag("once"); Text("每天").tag("daily"); Text("周一至周五").tag("weekdays"); Text("指定星期").tag("weekly") }; if recurrence == "weekly" { ForEach(1...7, id: \.self) { d in Toggle("星期\(Array("一二三四五六日")[d - 1])", isOn: Binding(get: { weekdays.contains(d) }, set: { if $0 { weekdays.insert(d) } else { weekdays.remove(d) } })) } }; TextField("备注（选填）", text: $content, axis: .vertical) }
            Section("提醒谁") { Toggle("我自己", isOn: Binding(get: { recipients.contains("self") }, set: { if $0 { recipients.insert("self") } else { recipients.remove("self") } })); ForEach(workspace.contacts) { c in Toggle(c.name + (c.hasToken ? "" : "（待绑定）"), isOn: Binding(get: { recipients.contains(c.id) }, set: { if $0 { recipients.insert(c.id); wechat = true } else { recipients.remove(c.id) } })).disabled(!c.hasToken || workspace.settings?.hasPushToken != true) } }
            Section("提醒方式") { Toggle("手机系统闹钟", isOn: $alarm).disabled(!recipients.contains("self")); Toggle("电脑通知", isOn: $web).disabled(!recipients.contains("self")); Toggle("微信公众号", isOn: $wechat).disabled(workspace.settings?.hasPushToken != true); Text("亲友只接收公众号通知；修改和取消作用于整个系列。").font(.caption).foregroundStyle(.secondary) }
            if !error.isEmpty { Text(error).foregroundStyle(.red).font(.caption) }
        }.navigationTitle(editing == nil ? "新提醒" : "修改提醒").toolbar { ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }; ToolbarItem(placement: .confirmationAction) { Button(busy ? "保存中…" : "下一步") { confirming = true }.disabled(title.trimmingCharacters(in: .whitespaces).isEmpty || recipients.isEmpty || busy) } }
        .alert("确认\(editing == nil ? "建立" : "修改整个系列")？", isPresented: $confirming) { Button("返回调整", role: .cancel) {}; Button("确认保存") { busy = true; Task { do { try await onSave(input); dismiss() } catch { self.error = error.localizedDescription }; busy = false } } } message: { Text("\(Dates.display(input.dueAt))\n\(title)\n\(recurrenceLabel(recurrence))") }
        .onAppear { if let editing { title = editing.title; content = editing.content; due = max(Dates.parse(editing.dueAt) ?? Date(), Date().addingTimeInterval(60)); recurrence = editing.recurrence; weekdays = Set(editing.weekdays); recipients = Set(editing.recipientIds); alarm = editing.channels.alarm; web = editing.channels.web; wechat = editing.channels.wechat } else { wechat = workspace.settings?.hasPushToken == true } }
        }
    }
}

struct ContactsView: View {
    @EnvironmentObject var workspace: Workspace
    @EnvironmentObject var api: API
    @State private var create = false, editing: Contact?, deleting: Contact?
    var body: some View { NavigationStack { List {
        Section { Link("查看 pushplus 官方扫码绑定步骤", destination: URL(string: "https://pushplus.plus/doc/function/friend.html")!); Text("本人完成实名并关注公众号，亲友扫码添加你为好友后，填写好友 token。").font(.caption).foregroundStyle(.secondary) }
        Section("联系人") { Label("我自己", systemImage: "person.crop.circle"); ForEach(workspace.contacts) { c in Button { editing = c } label: { HStack { VStack(alignment: .leading) { Text(c.name).foregroundStyle(.primary); Text(c.hasToken ? "已填写好友 token" : "待绑定").font(.caption).foregroundStyle(.secondary) }; Spacer(); Image(systemName: "chevron.right").font(.caption) } }.swipeActions { Button("删除", role: .destructive) { deleting = c } } } }
    }.navigationTitle("联系人").toolbar { Button { create = true } label: { Image(systemName: "plus") } }.sheet(isPresented: $create) { ContactEditor() }.sheet(item: $editing) { ContactEditor(contact: $0) }
    .confirmationDialog("删除联系人？", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })) { Button("删除", role: .destructive) { if let c = deleting { Task { do { let _: OK = try await api.send("/contacts/\(c.id)", method: "DELETE", value: [String: String]()); await workspace.refresh(api) } catch { workspace.error = error.localizedDescription } } }; deleting = nil } }
    .scrollContentBackground(.hidden).background(lineBackground) } }
}
struct ContactEditor: View {
    @EnvironmentObject var api: API
    @EnvironmentObject var workspace: Workspace
    @Environment(\.dismiss) var dismiss
    var contact: Contact?
    @State private var name = "", aliases = "", token = "", clear = false, error = "", busy = false
    var body: some View { NavigationStack { Form { TextField("姓名", text: $name); TextField("其他称呼，用逗号分隔", text: $aliases); SecureField(contact?.hasToken == true ? "已保存，留空保持原值" : "pushplus 好友 token", text: $token); if contact?.hasToken == true { Toggle("清除已保存 token", isOn: $clear) }; if !error.isEmpty { Text(error).foregroundStyle(.red) } }.navigationTitle("联系人").toolbar { ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }; ToolbarItem(placement: .confirmationAction) { Button("保存") { busy = true; Task { do { struct Input: Encodable { var id: String?; var name: String; var aliases: [String]; var token: String?; var clearToken: Bool }; let _: Contact = try await api.send("/contacts", value: Input(id: contact?.id, name: name, aliases: aliases.replacingOccurrences(of: "，", with: ",").split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }, token: token.isEmpty ? nil : token, clearToken: clear)); await workspace.refresh(api); dismiss() } catch { self.error = error.localizedDescription }; busy = false } }.disabled(name.isEmpty || busy) } }.onAppear { name = contact?.name ?? ""; aliases = contact?.aliases.joined(separator: "，") ?? "" } } }
}

struct SettingsView: View {
    @EnvironmentObject var api: API
    @EnvironmentObject var workspace: Workspace
    @EnvironmentObject var alarms: AlarmBridge
    @State private var token = "", secret = "", clearToken = false, clearSecret = false, logout = false
    var body: some View { NavigationStack { Form {
        Section("模型与声音") { if let settings = workspace.settings { ForEach(["asr", "llm", "tts"], id: \.self) { kind in if let provider = settings.providers[kind] { NavigationLink(providerName(kind)) { ProviderEditor(provider: provider) } } } } }
        Section("OpenAI 接入") { Link("打开官方 API Key 管理", destination: URL(string: "https://platform.openai.com/api-keys")!); Text("API Key 按 API 用量单独计费。Continue with ChatGPT 订阅授权入口在本机 Windows 网页的设置中；它不会生成 API Key，仅用于本地文字理解。手机使用后台已保存的配置。").font(.caption).foregroundStyle(.secondary) }
        Section("微信公众号通知") { SecureField(workspace.settings?.hasPushToken == true ? "本人 token 已保存；留空保持" : "本人 pushplus token", text: $token); SecureField(workspace.settings?.hasPushSecret == true ? "查询 secretKey 已保存；留空保持" : "结果查询 secretKey", text: $secret); Toggle("清除本人 token", isOn: $clearToken); Toggle("清除查询 secretKey", isOn: $clearSecret)
            Text("结果查询需开启 pushplus 开放接口，并配置后台公网 IP 白名单；未配置只能显示已受理。").font(.caption).foregroundStyle(.secondary)
            Button("保存推送配置") { Task { do { struct Input: Encodable { var token: String?; var secretKey: String?; var clearToken: Bool; var clearSecret: Bool }; let _: OK = try await api.send("/settings/pushplus", method: "PUT", value: Input(token: token.isEmpty ? nil : token, secretKey: secret.isEmpty ? nil : secret, clearToken: clearToken, clearSecret: clearSecret)); token = ""; secret = ""; await workspace.refresh(api) } catch { workspace.error = error.localizedDescription } } }
            Link("查看本人和好友绑定说明", destination: URL(string: "https://pushplus.plus/doc/function/friend.html")!)
        }
        Section("手机闹钟验证") { Button("建立一分钟后的系统测试闹钟") { Task { await alarms.minuteTest() } }; Button("同步未来七天的系统闹钟") { Task { await alarms.sync(api: api); await workspace.refresh(api) } }.disabled(alarms.syncing); Text(alarms.message).font(.caption).foregroundStyle(.secondary) }
        Section("免费签名验证版") { Text("免费个人账号安装有效期通常为七天。到期前重新安装并打开 APP 同步，再测试系统闹钟。已登记闹钟在签名到期后的行为尚需真机验证，请勿依赖未验证的到期闹钟。").font(.caption).foregroundStyle(.secondary)
            if let expiry = Signing.expiresAt { Text("实际签名到期：\(Dates.display(Dates.iso(expiry)))").font(.caption).foregroundStyle(Signing.needsUpdate ? .orange : .secondary) } else { Text("未读取到签名期限，请按安装日期在第6天更新。").font(.caption).foregroundStyle(.secondary) }
            Button("启用签名到期前一天的更新提醒") { Task { do { workspace.error = try await Signing.enableNotice() } catch { workspace.error = error.localizedDescription } } }
            Text("重复闹钟覆盖未来七天，每次打开 APP 补齐；无后台推送唤醒。") .font(.caption).foregroundStyle(.secondary) }
        Section("私人空间") { Text(api.server).font(.caption); Text("录音处理后删除，登录凭据保存在钥匙串，厂商 Key 在后台加密保存。").font(.caption).foregroundStyle(.secondary); Button("退出并移除此手机的 Line 闹钟", role: .destructive) { logout = true } }
    }.navigationTitle("设置").scrollContentBackground(.hidden).background(lineBackground)
    .confirmationDialog("退出并移除手机已登记的闹钟？微信公众号和电脑提醒仍由后台执行。", isPresented: $logout) { Button("移除并退出", role: .destructive) { Task { do { try alarms.removeAll(); let snapshot: SyncSnapshot = try await api.get("/sync"); struct Ack: Encodable { var reminderId: String; var deviceId: String; var revision: Int; var status = "failed"; var error = "手机已退出，系统闹钟已移除" }; let deviceId = UserDefaults.standard.string(forKey: "deviceId") ?? UUID().uuidString; for r in snapshot.reminders where r.channels.alarm { let _: OK = try await api.send("/sync/ack", value: Ack(reminderId: r.id, deviceId: deviceId, revision: r.revision)) }; await api.logout() } catch { workspace.error = "退出未完成：\(error.localizedDescription)" } } } }
    } }
}

struct ProviderEditor: View {
    @EnvironmentObject var api: API
    @EnvironmentObject var workspace: Workspace
    var provider: Provider
    @State private var adapter = "", baseUrl = "", model = "", voice = "", key = "", enabled = false, clearKey = false, busy = false, error = ""
    @StateObject private var recorder = Voice()
    var usesKey: Bool { adapter != "system" && adapter != "chatgpt-plan" }
    var body: some View { Form {
        Toggle("启用", isOn: $enabled)
        Picker("服务接口", selection: $adapter) { if provider.kind == "asr" { Text("百炼 Qwen ASR").tag("qwen-asr"); Text("兼容识别接口").tag("compatible-asr") } else if provider.kind == "llm" { Text("兼容文字接口").tag("compatible"); Text("OpenAI Responses").tag("openai-responses"); Text("本机 ChatGPT 订阅").tag("chatgpt-plan") } else { Text("系统朗读").tag("system"); Text("百炼 Qwen TTS").tag("qwen-tts"); Text("兼容朗读接口").tag("compatible-tts") } }
        if usesKey { TextField("HTTPS API 基础地址", text: $baseUrl).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled() }
        if adapter != "system" { TextField("模型名称", text: $model).textInputAutocapitalization(.never).autocorrectionDisabled() }
        if provider.kind == "tts" && adapter != "system" { TextField("声音，例如 Cherry / alloy", text: $voice) }
        if usesKey { SecureField(provider.hasKey ? "\(provider.keyMask) 已保存；留空保持" : "API Key", text: $key); if provider.hasKey { Toggle("清除已保存 Key", isOn: $clearKey) } }
        if adapter == "chatgpt-plan" { Text("请先在本机网页设置中 Continue with ChatGPT；手机不会生成订阅 API Key。").font(.caption).foregroundStyle(.secondary) }
        if !error.isEmpty { Text(error).foregroundStyle(.red).font(.caption) }
        Button(busy ? "保存中…" : "保存配置") { Task { await save() } }.disabled(busy)
        Button(recorder.state == "listening" ? "结束测试录音" : "测试已保存配置（可能产生费用）") { Task { if recorder.state == "listening" { recorder.finish(); return }; do {
            if provider.kind == "asr" { try await recorder.speak("你好，请说一句话测试识别。", api: api, settings: workspace.settings); try await recorder.record { result in Task { @MainActor in do { let (audio, _) = try result.get(); let text = try await api.transcribe(audio); error = "识别成功：\(text)" } catch { self.error = error.localizedDescription }; recorder.state = "idle" } } }
            else { struct Result: Decodable { var message: String }; let result: Result = try await api.send("/settings/provider/\(provider.kind)/test", value: [String: String]()); error = result.message }
        } catch { self.error = error.localizedDescription; recorder.state = "idle" } } }.disabled(busy || recorder.state == "greeting" || recorder.state == "thinking")
    }.navigationTitle(providerName(provider.kind)).onAppear { adapter = provider.adapter; baseUrl = provider.baseUrl; model = provider.model; voice = provider.voice; enabled = provider.enabled }.onDisappear { recorder.cancel() } }
    private func save() async { busy = true; defer { busy = false }; do { struct Input: Encodable { var adapter: String; var baseUrl: String; var model: String; var voice: String; var enabled: Bool; var key: String?; var clearKey: Bool }; let _: Provider = try await api.send("/settings/provider/\(provider.kind)", method: "PUT", value: Input(adapter: adapter, baseUrl: usesKey ? baseUrl : "", model: model, voice: voice, enabled: enabled, key: key.isEmpty ? nil : key, clearKey: clearKey)); key = ""; await workspace.refresh(api); error = "配置已保存" } catch { self.error = error.localizedDescription } }
}

func recurrenceLabel(_ value: String) -> String { ["once": "仅一次", "daily": "每天", "weekdays": "周一至周五", "weekly": "指定星期"] [value] ?? value }
func providerName(_ kind: String) -> String { ["asr": "语音识别", "llm": "文字理解", "tts": "语音朗读"][kind] ?? kind }
func syncLabel(_ r: Reminder) -> String { if r.syncStatus == "not_required" { return "无需手机闹钟" }; if r.syncStatus == "registered" { return r.status == "cancelled" || !r.channels.alarm ? "手机旧闹钟已移除" : "手机闹钟已生效" }; if r.syncStatus == "failed" { return "手机闹钟登记失败" }; return r.status == "cancelled" || !r.channels.alarm ? "待手机移除旧闹钟" : "待手机同步" }
func deliveryLabel(_ status: String) -> String { ["pending": "待发送", "processing": "已受理·待核实", "success": "发送成功", "failed": "失败·待重试", "unknown": "结果未知", "missed": "已错过", "exhausted": "重试结束", "cancelled": "已取消"][status] ?? status }
extension View { func glassCard() -> some View { background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 20)).overlay(RoundedRectangle(cornerRadius: 20).stroke(.white.opacity(0.8))) } }
