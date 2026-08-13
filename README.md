# dsh2wechat — DeepSeek Harness 微信 ClawBot 消息桥

把 **DeepSeek Harness** 接入**微信 ClawBot（腾讯 iLink）**：微信里发消息，插件交给 DSH 回答后回发。

## 特性

- **单开持久会话**：每个微信用户对应独立 Agent 会话（`im-wechat-*`），与 GUI 对话隔离，持久化、跨重启自动恢复、上下文连续。
- **getupdates 长轮询** + **sendmessage 回复**（携带 `context_token`），内置微信官方限速（约 7 条/5 分钟）排队与退避。
- **崩溃免疫**：进程级错误钩子记录到 `$DSH_HOME/dshplug.log`，单个错误不会杀掉 DSH 进程。
- **会话自愈**：残留/损坏会话自动清理，冲突时自动轮换 sessionId 恢复（日志 `heal` 行）。
- **通用插件**：凭据全在配置、零硬编码、无账号白名单；可选 `allowUsers` 白名单。
- 本地状态检查：`http://127.0.0.1:3901/health`。

## 安装

### 1. 构建

```sh
git clone https://github.com/wuyuanjiang1/dsh2wechat.git
cd dshplug
pnpm install
pnpm run build
```

### 2. 挂载到 profile

```sh
dsh plugin --profile web add file:C:/绝对/路径/dshplug
```

### 3. 微信扫码绑定（一条命令）

```sh
node tools/wechat-login.mjs --write
```

终端会显示二维码（手机微信扫码）或可复制链接；确认后自动把凭据写入
`$DSH_HOME/profiles/web/cordis.patch.yml`（wechat 段：token/botId/baseUrl/enabled）。

参数：`--profile <name>`（默认 web）、`--timeout <秒>`（默认 600）、不加 `--write` 只输出凭据。

### 4. 生效

```sh
dsh web        # 或 dsh --profile <name>
```

重启 profile 后，给机器人发一条微信消息即可使用。
