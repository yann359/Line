# Line · 个人语音提醒助理

暖白、柔和蓝色和轻玻璃界面。Windows 使用 React 网页，iPhone 使用 SwiftUI + AlarmKit，后台使用 Fastify + SQLite。仅一个私有管理账号，模型和通知服务初始未配置。

## 在 Windows 打开

需要 Node.js 24。进入此文件夹，运行：

```powershell
.\scripts\start.ps1
```

若 PowerShell 不允许运行脚本，可仅为这次启动执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start.ps1
```

打开 **http://127.0.0.1:5173**，输入你自己选择的账号和至少12位密码，建立私人空间。脚本会建立本地 `.env` 并限制 `data` 文件夹的 Windows 权限；管理员仍可访问。首次创建账号只允许服务器本机，后续登录记住设备30天。不要把密钥或账号密码发到聊天里。

先点击“手动建立提醒”完成保存和修改。启用“电脑通知”需要在设置中允许通知。后台进程和设备必须运行；本地电脑关机后，公众号通知不会继续发送。

## 接入语音和 OpenAI

在“设置”分别保存并启用语音识别、文字理解、语音朗读，再测试连接。录音测试调用真实服务，可能产生费用。地址是接口基础地址，代码会追加对应路径，勿填写完整的方法路径。

| 功能 | 可选接口 | 基础地址示例 |
| --- | --- | --- |
| 识别 | 百炼 `qwen3-asr-flash` | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| 识别 | 兼容 `audio/transcriptions` | 厂商提供的基础地址 |
| 文字 | 兼容 Chat Completions | 厂商提供的基础地址，如 `https://api.openai.com/v1` |
| 文字 | OpenAI Responses | `https://api.openai.com/v1` |
| 文字 | ChatGPT 订阅官方登录 | 无需基础地址和 API Key |
| 朗读 | 系统朗读 | 无需 Key，网页默认可用 |
| 朗读 | 百炼 `qwen3-tts-flash`，声音 `Cherry` | `https://dashscope.aliyuncs.com/api/v1` |
| 朗读 | 兼容 `audio/speech` | 厂商提供的基础地址和声音名称 |

新增的 OpenAI 入口有两种独立方式：

1. **打开官方 Key 管理**：进入 [OpenAI 平台](https://platform.openai.com/api-keys)自行创建并填写 Key，API 用量单独计费。
2. **Continue with ChatGPT**：本机后台启动临时回环回调，执行官方动态客户端 OAuth + PKCE，验证身份后加密保存凭据。返回网页读取模型，选择“文字理解 → ChatGPT 订阅”，填写可用模型并测试。**订阅登录不会生成 API Key**；账户是否符合当前预览条件、地区和额度由 OpenAI 决定。首版只接入文字理解，音频识别需要另行配置。[官方本地应用授权文档](https://developers.openai.com/siwc/token-sharing-open-source)

云端部署自动关闭此本机订阅入口。若为了手机局域网连接把 `HOST` 改成 `0.0.0.0`，也会关闭；该模式请先使用普通 API Key。不要复制 Codex 自己的登录文件。断开授权会尝试撤销刷新令牌；网络异常时清除本地凭据，并提示到 ChatGPT 设置核实断开状态。

## 微信和亲友提醒

本人在 pushplus 完成实名并关注公众号，在设置填写本人 token。亲友扫码添加你为好友，从官网好友列表取得好友 token，填入联系人。[绑定步骤](https://pushplus.plus/doc/function/friend.html)

结果查询还需要在 pushplus 开放接口设置中建立 secretKey，并把后台公网 IP 加入安全白名单。界面会提示“已受理 · 待核实”，只有查询返回成功才标记公众号“发送成功”。没有查询凭据时不会假报成功。[接口文档](https://pushplus.plus/doc/guide/openApi.html)

后台限制每分钟最多5次、每天最多200次发送尝试，同内容同接收人每小时最多3次。明确失败最多重试3次，同时受上述限额和最多迟到5分钟约束；发送结果未知时停止自动重发。公众号有排队延迟，发送状态不等于亲友已阅读。真实测试先建立一条提醒本人、一分钟后的公众号提醒，亲友提醒由你确认建立后才启用。

## iPhone、部署与验证

- [iPhone 真机安装和验证](docs/iphone.md)：包含可在 Xcode 打开的原生工程，需 Mac + Xcode 26 + iOS 26。当前 Windows 环境没有完成原生编译或真机闹钟验收。
- [部署与备份](docs/deployment.md)：提供 Docker Compose + Caddy HTTPS + 每日备份；当前未部署到服务器。
- [验收清单与实现边界](docs/verification.md)：列出已自动验证项和需要设备、账号验证的项目。

## 开发命令

```powershell
npm ci
npm run dev
npm run build
npm test
npm run test:e2e
npm run backup
```

浏览器测试使用独立的 `test-results/e2e-data`，不会访问你的实际数据。默认调用本机 Edge；未安装 Edge 时修改 `playwright.config.ts` 的浏览器 channel。生产本地预览用 `.env` 设置 `APP_ORIGIN=http://127.0.0.1:8787`、`NODE_ENV=development` 后执行 `npm start`。

目录：`web` 网页，`server` 后台，`shared` 接口类型，`apps/ios` 原生工程，`deploy` 部署文件，`tests` 自动化验证。录音只在内存中上传处理，原生临时文件在结束录音后立即删除。服务器保存密码摘要；密钥、推送令牌和订阅凭据用 AES-256-GCM 加密，恢复数据必须同时恢复数据库和 `master.key`。请勿公开 `data`、`.env` 或备份。
