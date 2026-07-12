import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { FeishuClient } from './feishu-client.js';

const config = loadConfig();
const feishuClient = config.feishuAppId && config.feishuAppSecret
  ? new FeishuClient({
    appId: config.feishuAppId,
    appSecret: config.feishuAppSecret,
    baseUrl: config.feishuBaseUrl,
    timeoutMs: config.requestTimeoutMs
  })
  : null;
const app = createApp({ config, feishuClient });

app.listen(config.port, () => {
  console.log(`xianyu-agent-proxy listening on ${config.port}`);
});
