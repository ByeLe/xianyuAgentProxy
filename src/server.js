import { createApp } from './app.js';
import { BotmuxClient } from './botmux-client.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const botmuxClient = config.botmuxRelayEnabled
  ? new BotmuxClient({
    command: config.botmuxCommand,
    timeoutMs: config.botmuxSendTimeoutMs,
    relaySessionsPath: config.botmuxRelaySessionsPath
  })
  : null;
const app = createApp({ config, botmuxClient });

app.listen(config.port, () => {
  console.log(`xianyu-agent-proxy listening on ${config.port}`);
});
