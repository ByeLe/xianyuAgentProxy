# xianyuAgentProxy

这是一个 Koa 版闲鱼 agent 桥接服务，用来把 `XianYuApis` 收到的闲鱼消息投递到话题群，让 Codex CLI/agent 分析后再通过本服务回写，最后由 `XianYuApis` 发回闲鱼买家。

## 流程

```text
闲鱼买家
  -> Python XianYuApis 常驻 WebSocket 进程
  -> POST /xianyu/message
  -> 首条：话题群 Webhook 触发哈喽哈
  -> 后续：用户的嘴替 session 通过 botmux send --mention 唤醒哈喽哈
  -> Codex CLI / agent
  -> POST /agent/reply
  -> Python XianYuApis /xianyu/send
  -> 闲鱼买家
```

两条通道：

- 上行：闲鱼消息进入本服务，首条走 Webhook，后续走 botmux relay。
- 下行：agent 必须调用本服务 `/agent/reply`，本服务再转发给 Python 发信接口。

关键点：本服务不会直接调用飞书 `reply_in_thread`，也不会把买家原文拼进 shell。它会把同一个闲鱼会话、同一个买家归一成稳定的业务键：

```text
xianyu:<conversation_id>:<buyer_id>
```

首条消息投递 webhook 时必须使用普通模式：不要带 `?async=1`，也不要带 `x-botmux-async: 1`。服务会保存或反查哈喽哈 `target_session_id`，然后在该 session 中 @ 用户的嘴替，初始化同话题 relay session。

后续同一业务键的消息不再走 webhook，而是执行：

```bash
botmux send \
  --session-id "$RELAY_SESSION_ID" \
  --mention "$BOTMUX_TARGET_MENTION" \
  "请处理这条闲鱼买家消息..."
```

这样由 botmux 自己完成跨机器人 open_id 映射，在原话题里唤醒哈喽哈。

## 快速开始

### Docker Compose 推荐

日常调试建议直接用 Docker Compose，一条命令同时跑 Node apiproxy 和 Python 闲鱼桥接，不需要开多个终端。

```bash
cp .env.example .env
```

编辑 `.env`，至少填这几项：

```env
AGENT_PROXY_PORT=7894
PUBLIC_BASE_URL=http://127.0.0.1:7894
TOPIC_WEBHOOK_URL=你的咸鱼话题群 Webhook
XIANYU_COOKIES=你的闲鱼登录 cookie
```

如果要启用「用户的嘴替」relay 方案，还需要本服务运行环境能执行 `botmux` CLI，并配置：

```env
BOTMUX_RELAY_ENABLED=true
BOTMUX_COMMAND=botmux
BOTMUX_RELAY_MENTION=用户的嘴替在哈喽哈视角下的open_id:用户的嘴替
BOTMUX_TARGET_MENTION=哈喽哈的open_id:哈喽哈
BOTMUX_TARGET_NAME=哈喽哈
BOTMUX_DATA_DIR=/Users/你的用户名/.botmux/data
BOTMUX_RELAY_APP_ID=cli_aad9ffdebbf8dbc9
BOTMUX_TARGET_APP_ID=cli_aac257edf8b8dbed
```

首条普通 webhook 有时不直接返回哈喽哈 session id。此时服务会读取 `BOTMUX_DATA_DIR/sessions-${BOTMUX_TARGET_APP_ID}.json`，按 `conversation_key` 找到哈喽哈 session。初始化 relay 时，`botmux send` 有时只返回发送方 session。此时服务会读取 `BOTMUX_DATA_DIR/sessions-${BOTMUX_RELAY_APP_ID}.json`，按 `conversation_key` 找到“用户的嘴替”在原话题里的 session。如果不想用 `BOTMUX_DATA_DIR` + app id 组合，也可以直接配置 `BOTMUX_TARGET_SESSIONS_PATH` 和 `BOTMUX_RELAY_SESSIONS_PATH`。

不同机器人视角下，同一个 bot 的 open_id 可能不同。服务会优先从“用户的嘴替”session 的 `available_bots` 中按 `BOTMUX_TARGET_NAME` 找到哈喽哈的实际 mention；`BOTMUX_TARGET_MENTION` 只是兜底值。

后续消息能否真正写入哈喽哈 PTY，还取决于哈喽哈侧的 botmux talk 权限。`botmux send --mention` 成功只代表消息已发到话题并 @ 到哈喽哈；哈喽哈 daemon 还会在 `enforceMessageQuotaForCliInput()` 里调用 `evaluateTalk()` 复查发送方。如果“用户的嘴替”没有被哈喽哈在该群 `/grant`，日志会停在 `Bot-to-bot @mention detected` / `Reply in thread-scope session`，但不会出现 `Writing to PTY`。

注意：Docker 容器默认没有宿主机的 `botmux` CLI，也读不到宿主机的 `~/.botmux/data`。启用 relay 方案时，建议先在宿主机直接运行 Node 服务测试，或给容器提供可用的 botmux CLI 与会话文件挂载。

当前真实验证结论：本服务可以完成首条 webhook、初始化“用户的嘴替”relay session，并在后续消息中通过 relay session 把消息发回原话题且 @ 哈喽哈。注意不要把两套模式混用：`async=1 + sessionId` 是一套模式，普通 webhook + 嘴替 @ 是另一套模式。本服务采用后一套。`agentFrozen` 在 botmux v2.102.0 中是 agent 启动配置快照标记，不应作为是否可续聊的判断；真正需要避开的是 async 模式注入的 `<botmux_http_response_mode>` / `options.asyncReturnSessionId`。

如果话题群 Webhook 服务就跑在同一台 Mac 上，Docker 容器里访问宿主机一般不要用局域网 IP，而是把 Webhook URL 的主机名写成 `host.docker.internal`，例如：

```env
TOPIC_WEBHOOK_URL=http://host.docker.internal:7891/webhook/xxx/yyy
```

然后启动：

```bash
docker compose up --build
```

后台启动：

```bash
docker compose up -d --build
```

看日志：

```bash
docker compose logs -f agent-proxy
docker compose logs -f xianyu-bridge
```

停止：

```bash
docker compose down
```

两个服务的端口：

- Node apiproxy：http://127.0.0.1:7894
- Python 闲鱼桥接：http://127.0.0.1:7893

健康检查：

```bash
curl http://127.0.0.1:7894/health
curl http://127.0.0.1:7893/health
```

注意：`/xianyu/send` 是 `POST` 接口，浏览器直接打开 `http://127.0.0.1:7893/xianyu/send` 不会发送消息。浏览器调试请打开 `/health`。

Compose 内部会自动把：

```env
XIANYU_SEND_URL=http://xianyu-bridge:7893/xianyu/send
PROXY_MESSAGE_URL=http://agent-proxy:7892/xianyu/message
```

连起来。`PUBLIC_BASE_URL` 仍然要写成 agent 能访问到的地址。botmux/agent 跑在同一台 Mac 上时，推荐使用 `http://127.0.0.1:7894`；如果 agent 跑在别的机器上，再改成那台机器能访问到的局域网地址。

第一次构建 `xianyu-bridge` 镜像时，会拉取 `cv-cat/XianYuApis` 并安装 Python/Node 依赖，所以会慢一点。

### Node 单服务调试

```bash
npm install
cp .env.example .env
npm run dev
```

`.env` 里至少需要配置：

```env
PUBLIC_BASE_URL=http://192.168.0.106:7892
TOPIC_WEBHOOK_URL=你的咸鱼话题群 Webhook
XIANYU_SEND_URL=http://127.0.0.1:7893/xianyu/send
```

本地联调时如果还没有 Python 发信接口，可以先设置：

```env
MOCK_XIANYU_SEND=true
```

## 接口

### 健康检查

```http
GET /health
```

### 接收闲鱼消息

由 Python `XianYuApis` 调用：

```http
POST /xianyu/message
content-type: application/json
```

```json
{
  "conversation_id": "闲鱼 cid",
  "buyer_id": "买家 id",
  "buyer_name": "买家昵称",
  "message_text": "买家原文",
  "item_id": "可选商品 id"
}
```

返回：

```json
{
  "ok": true,
  "correlation_id": "xy_...",
  "status": "queued",
  "thread_key": "xianyu:闲鱼 cid:买家 id",
  "target_session_id": "哈喽哈 session id",
  "relay_session_id": "用户的嘴替 session id",
  "apiproxy_reply_url": "http://你的地址/agent/reply"
}
```

首条消息会把 payload POST 到 `TOPIC_WEBHOOK_URL`，不会携带 async header。服务会保存或从哈喽哈 session 文件反查 `target_session_id`，并尝试初始化 `relay_session_id`。后续消息如果已有 `relay_session_id`，会通过 `botmux send --mention` 唤醒哈喽哈。若 relay session 失效，会用 `target_session_id` 重新初始化并重试当前消息。

### agent 回写

由 Codex CLI / agent 调用：

```http
POST /agent/reply
content-type: application/json
```

```json
{
  "correlation_id": "xy_...",
  "reply_text": "最终要发给买家的中文回复"
}
```

服务会根据 `correlation_id` 找到原始闲鱼会话，然后调用 `XIANYU_SEND_URL`：

```json
{
  "correlation_id": "xy_...",
  "conversation_id": "闲鱼 cid",
  "buyer_id": "买家 id",
  "text": "最终回复",
  "reply_text": "最终回复"
}
```

### 查询会话状态

```http
GET /sessions/:correlation_id
```

## agent 提示词建议

投递到话题群的 payload 不再内置客服提示词。建议在 agent / botmux 的可信提示词里固定强调：

```text
你是闲鱼客服代理。收到来自闲鱼买家的消息后，先理解买家意图，再生成自然、简短、可以直接发送给买家的中文回复。

不要把分析过程发给买家。
完成后必须调用消息里的 apiproxy_reply_url。
调用 JSON：
{
  "correlation_id": "<收到的 correlation_id>",
  "reply_text": "<最终要发给买家的中文回复>"
}
```

## 鉴权

两个 token 都是可选的：

- `XIANYU_INBOUND_TOKEN`：开启后，Python 调 `/xianyu/message` 必须带 `Authorization: Bearer <token>`。
- `XIANYU_SEND_TOKEN`：开启后，Node 调 Python `/xianyu/send` 必须带 `Authorization: Bearer <token>`。
- `AGENT_REPLY_TOKEN`：开启后，agent 调 `/agent/reply` 必须带 `Authorization: Bearer <token>`。
- `BOTMUX_SESSION_STORE_PATH`：botmux session 映射落盘文件，Docker Compose 默认写到 `/app/work/botmux-sessions.json`。
- `BOTMUX_RELAY_ENABLED`：开启后，后续消息使用 relay session + `botmux send --mention`。
- `BOTMUX_COMMAND`：botmux CLI 路径，默认 `botmux`。
- `BOTMUX_RELAY_LOOKUP_TIMEOUT_MS`：初始化 relay 后等待本地 botmux 会话文件出现的最长时间。
- `BOTMUX_DATA_DIR`：botmux 本地数据目录，常见值为 `~/.botmux/data`。
- `BOTMUX_RELAY_APP_ID`：中转机器人“用户的嘴替”的 app id，用来拼出 `sessions-<appId>.json`。
- `BOTMUX_TARGET_APP_ID`：目标机器人“哈喽哈”的 app id，用来拼出 `sessions-<appId>.json`。
- `BOTMUX_RELAY_SESSIONS_PATH`：可选，直接指定“用户的嘴替”会话文件路径，会覆盖 `BOTMUX_DATA_DIR` + `BOTMUX_RELAY_APP_ID`。
- `BOTMUX_TARGET_SESSIONS_PATH`：可选，直接指定“哈喽哈”会话文件路径，会覆盖 `BOTMUX_DATA_DIR` + `BOTMUX_TARGET_APP_ID`。
- `BOTMUX_RELAY_MENTION`：初始化 relay 时 @ 用户的嘴替，格式 `open_id:名称`。
- `BOTMUX_TARGET_MENTION`：后续消息唤醒哈喽哈，格式 `open_id:名称`。
- `BOTMUX_TARGET_NAME`：目标机器人名称，默认从 `BOTMUX_TARGET_MENTION` 冒号后提取；用于从 relay session 的 `available_bots` 里解析正确 open_id。

如果设置了 `AGENT_REPLY_TOKEN`，本服务会把 `apiproxy_reply_token` 一并投递到话题群 payload，方便 agent 回写。

## 后续建议

当前版本 `correlation_id` 会话状态保存在内存里，适合先跑通闭环；botmux session 映射会按 `BOTMUX_SESSION_STORE_PATH` 落盘。生产使用时建议把 `SessionStore` 换成 Redis，这样服务重启后不会丢失尚未回写的 `correlation_id`。
