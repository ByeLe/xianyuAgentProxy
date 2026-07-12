import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { FeishuClient } from './feishu-client.js';

const config = loadConfig();
const feishuClient = config.feishuReplyAppId && config.feishuReplyAppSecret
  ? new FeishuClient({
    appId: config.feishuReplyAppId,
    appSecret: config.feishuReplyAppSecret,
    baseUrl: config.feishuBaseUrl,
    timeoutMs: config.requestTimeoutMs,
    mentionOpenId: config.feishuReplyMentionOpenId,
    mentionName: config.feishuReplyMentionName
  })
  : null;
const app = createApp({ config, feishuClient });

app.listen(config.port, () => {
  console.log(`xianyu-agent-proxy listening on ${config.port}`);
});
