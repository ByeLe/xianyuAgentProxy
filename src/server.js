import { createApp } from './app.js';
import { BotmuxSessionReader } from './botmux-session-reader.js';
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
const botmuxSessionReader = new BotmuxSessionReader({
  appId: config.botmuxTargetAppId,
  sessionsPath: config.botmuxTargetSessionsPath
});
const app = createApp({ config, feishuClient, botmuxSessionReader });

app.listen(config.port, () => {
  console.log(`xianyu-agent-proxy listening on ${config.port}`);
});
