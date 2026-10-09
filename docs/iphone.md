# iPhone 真机验证

这份原生工程由 Windows 环境生成，已按 Apple AlarmKit 官方接口核对，**尚未在 Xcode 编译或真机测试**。先完成一分钟闹钟验证，再依赖它处理日常提醒。

## 第一步：安装

1. 将整个项目复制到 Mac。安装 Xcode 26 或更新版本，确认手机 iOS 26 或更新版本。
2. 双击 `apps/ios/Line.xcodeproj`。在 Xcode → Settings → Accounts 添加 Apple 账号。
3. 选择 Line target → Signing & Capabilities，勾选 Automatically manage signing，Team 选择个人账号；把 Bundle Identifier 改成你自己的唯一值。
4. USB 连接 iPhone，开启开发者模式，选真实设备后点击 Run。必要时在 iPhone 的“VPN 与设备管理”信任开发者。

免费 Personal Team 安装有效期通常7天，需到期前重新编译安装。不要添加不存在的 AlarmKit entitlement。工程无 APNs、无 Live Activity 倒计时扩展，使用固定日期系统闹钟。[Apple 免费账号限制](https://developer.apple.com/help/account/basics/about-your-developer-account)、[AlarmKit 官方指南](https://developer.apple.com/documentation/alarmkit/scheduling-an-alarm-with-alarmkit)

## 第二步：连接本地 Windows 后台

手机和 Windows 连接相同可信 Wi-Fi。在 Windows 本地 `.env` 将 `HOST` 改为 `0.0.0.0`，重启 `npm run dev`。`APP_ORIGIN` 保持网页实际地址 `http://127.0.0.1:5173`。获取 Windows 局域网 IPv4，手机输入 `http://该IP:8787`，登录相同管理账号。

若 Windows 防火墙阻止连接，仅在可信的“专用网络”允许后台端口8787，不要把端口开放给公网。Debug 工程允许 HTTP，仅用于局域网验证；Release 要求 HTTPS。局域网模式自动关闭本机 ChatGPT 订阅入口，模型使用普通 API Key。后续云端只需改为 HTTPS 地址。

## 第三步：一分钟闹钟

手机“设置 → 手机闹钟验证 → 建立一分钟后的系统测试闹钟”，允许 AlarmKit 权限，锁屏等待。分别测静音、专注模式和前后台。系统登记失败时界面展示错误；不要将“保存提醒”理解为“闹钟已登记”。

测试通过后，在电脑建立提醒，查看“待手机同步”。打开手机，执行同步，再查看“手机闹钟已生效”和覆盖期限。接着修改、取消整组重复提醒，验证旧闹钟被移除。断网取消时，旧手机闹钟仍可能存在，必须再次联网同步。

## 已实现的同步规则

- 根据后台北京时间生成未来7天的固定日期实例，不受手机所在时区变化影响。
- UUID 在调用系统登记之前保存，重启可以检查系统实际闹钟；旧版本先取消，再补齐新版本。
- 只有系统实际集合核对成功，才提交当前版本的 ACK。旧版本 ACK 会被后台拒绝。
- 每次打开或回到前台同步；免费账号不依赖后台 APNs 唤醒。
- 退出手机登录时明确移除本机闹钟，并向后台报告手机不再登记；后台公众号和电脑通知仍执行。
- 系统容量、权限、安装有效期均可能使登记失败，界面展示失败和剩余覆盖范围。签名到期后闹钟是否仍执行须真机验证。

## 更新提醒

设置页展示免费签名7天限制，并尝试从已安装应用的 `embedded.mobileprovision` 读取实际 `ExpirationDate`。到期前一天打开应用会提示更新，还可点击“启用签名到期前一天的更新提醒”允许本机通知。读取和通知尚未真机验证；无法读取时显示未知，请按安装日期在第6天自行更新。模拟器通常没有该文件。原生页面目前无 App Store 发布图标和上架配置，符合私人验证用途。
