# xianyuAgentProxy

这是一个 Koa 版闲鱼 agent 桥接服务，用来把 `XianYuApis` 收到的闲鱼消息投递到话题群，让 Codex CLI/agent 分析后再通过本服务回写，最后由 `XianYuApis` 发回闲鱼买家。

## 流程

```text
闲鱼买家
  -> Python XianYuApis 常驻 WebSocket 进程
  -> POST /xianyu/message
  -> 首次：话题群 Webhook
  -> 后续：飞书消息 reply_in_thread
  -> Codex CLI / agent
  -> POST /agent/reply
  -> Python XianYuApis /xianyu/send
  -> 闲鱼买家
```

两条通道：

- 上行：闲鱼消息进入本服务，本服务投递到话题群。
- 下行：agent 必须调用本服务 `/agent/reply`，本服务再转发给 Python 发信接口。

## 快速开始

### Docker Compose 推荐

日常调试建议直接用 Docker Compose，一条命令同时跑 Node apiproxy 和 Python 闲鱼桥接，不需要开多个终端。

```bash
cp .env.example .env
```

编辑 `.env`，至少填这几项：

```env
PUBLIC_BASE_URL=http://192.168.0.106:7892
TOPIC_WEBHOOK_URL=你的咸鱼话题群 Webhook
XIANYU_COOKIES=你的闲鱼登录 cookie
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

- Node apiproxy：http://127.0.0.1:7892
- Python 闲鱼桥接：http://127.0.0.1:7893

健康检查：

```bash
curl http://127.0.0.1:7892/health
curl http://127.0.0.1:7893/health
```

注意：`/xianyu/send` 是 `POST` 接口，浏览器直接打开 `http://127.0.0.1:7893/xianyu/send` 不会发送消息。浏览器调试请打开 `/health`。

Compose 内部会自动把：

```env
XIANYU_SEND_URL=http://xianyu-bridge:7893/xianyu/send
PROXY_MESSAGE_URL=http://agent-proxy:7892/xianyu/message
```

连起来。`PUBLIC_BASE_URL` 仍然要写成 agent 能访问到的地址，例如你的局域网地址 `http://192.168.0.106:7892`。

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
  "apiproxy_reply_url": "http://你的地址/agent/reply"
}
```

如果这个 `thread_key` 已经保存过飞书消息锚点，本服务不会再调用话题群 Webhook，而是调用飞书接口：

```http
POST https://open.feishu.cn/open-apis/im/v1/messages/:message_id/reply
```

请求里会带 `reply_in_thread: true`，让后续同一买家的消息进入原飞书话题。

### agent 回写

由 Codex CLI / agent 调用：

```http
POST /agent/reply
content-type: application/json
```

```json
{
  "correlation_id": "xy_...",
  "reply_text": "最终要发给买家的中文回复",
  "lark_message_id": "当前飞书话题内可被 reply 的消息 ID"
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

`lark_message_id` 可选，但建议让 agent 每次都带上。服务会按：

```text
xianyu:<conversation_id>:<buyer_id>
```

保存这条飞书消息 ID。下一次同一个闲鱼会话、同一个买家的消息到来时，就直接回复到这条飞书消息所在的话题。

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
  "reply_text": "<最终要发给买家的中文回复>",
  "lark_message_id": "<当前飞书消息 ID，用于后续 reply_in_thread>"
}
```

## 鉴权

两个 token 都是可选的：

- `XIANYU_INBOUND_TOKEN`：开启后，Python 调 `/xianyu/message` 必须带 `Authorization: Bearer <token>`。
- `XIANYU_SEND_TOKEN`：开启后，Node 调 Python `/xianyu/send` 必须带 `Authorization: Bearer <token>`。
- `AGENT_REPLY_TOKEN`：开启后，agent 调 `/agent/reply` 必须带 `Authorization: Bearer <token>`。
- `FEISHU_APP_ID` / `FEISHU_APP_SECRET`：开启后，已有飞书锚点的闲鱼消息会通过飞书 reply 接口进入原话题。
- `THREAD_ANCHOR_STORE_PATH`：飞书锚点落盘文件，Docker Compose 默认写到 `/app/work/thread-anchors.json`。

如果设置了 `AGENT_REPLY_TOKEN`，本服务会把 `apiproxy_reply_token` 一并投递到话题群 payload，方便 agent 回写。

## 后续建议

当前版本 `correlation_id` 会话状态保存在内存里，适合先跑通闭环；飞书话题锚点会按 `THREAD_ANCHOR_STORE_PATH` 落盘。生产使用时建议把 `SessionStore` 换成 Redis，这样服务重启后不会丢失尚未回写的 `correlation_id`。
