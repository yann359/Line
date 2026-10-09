# 在线部署和每日备份

当前只准备了部署文件，没有购买服务器、域名或执行线上发布。部署需要持续运行的 Linux 主机、Docker Compose、域名 DNS 指向服务器，端口80/443可用。只运行一个后台实例，SQLite 放持久卷。

## 部署步骤

1. 复制项目到服务器，在 `deploy` 文件夹将 `.env.example` 复制为 `.env`，填写自己的域名和 VAPID 联系邮箱。
2. 在项目根目录构建镜像：`docker compose --env-file deploy/.env -f deploy/compose.yml build`。
3. **先创建管理账号**：`docker compose --env-file deploy/.env -f deploy/compose.yml run --rm app node dist/server/server/src/setup.js`。在可信终端输入账号和密码。此命令不会覆盖已有账号；首次公网页面不提供创建入口。
4. 启动：`docker compose --env-file deploy/.env -f deploy/compose.yml up -d`。Caddy 自动申请 HTTPS 证书。打开 `https://你的域名` 登录，手机填写相同地址。
5. 在应用中填写模型和 pushplus 配置，再发一条一分钟后提醒本人。检查发送结果、重启恢复以及手机登记。

后台仅通过容器网络供 Caddy 访问，端口8787不映射到公网。反向代理之后请求 IP 视为 Caddy，登录限流对整个私人站点共享（符合单管理账号用途）。后台 Cookie 在生产环境为 Secure + HttpOnly + SameSite=Strict，所有网页写请求核对配置的完整 Origin。不同域名或端口必须同时更新 APP_ORIGIN。

生产部署关闭 ChatGPT 本机订阅授权；订阅授权凭据不要从 Windows 复制到云端。使用厂商正式 API Key。初次 DNS、TLS、推送权限和外部厂商网络连通性仍需实际服务器验证；Docker 构建未在当前 Windows 环境验证。

## 备份与恢复

Compose 的 backup 服务在后台健康后启动，每24小时用 SQLite `VACUUM INTO` 生成一致性快照，连同 `master.key` 保存到 `/app/data/backups/<时间>`，保留最近7份。启动第一轮时尚未建立数据库，任务会失败后次日重试；创建账号之后再启动可避免这一点。

备份仍在同一持久卷，**不能替代异地备份**。请用服务器备份服务每日复制加密磁盘快照到独立存储。数据库与 master.key 必须一起保存并限制访问；分离或丢失密钥将无法恢复配置凭据。

恢复前停止 app 和 backup 服务，复制选定备份的 `line.sqlite`、`master.key` 到数据卷根目录，并移除旧数据库的 `line.sqlite-wal`/`line.sqlite-shm`（先确认路径只在该应用数据卷）。启动后检查账号、配置和提醒，打开手机重新同步。恢复旧快照可能包含外部已经发送过、但数据库尚未确认的请求，必须核对未知结果，避免手动重发造成重复。

本地可执行 `npm run backup`，同样产生数据库和密钥快照。建议定期测试恢复到独立数据目录。
