import dotenv from 'dotenv';
import { join } from 'node:path';

dotenv.config();

const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function numberFromEnv(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function boolFromEnv(value, fallback = false) {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function trimRightSlash(value) {
  return value.replace(/\/+$/, '');
}

function mentionName(value) {
  const text = String(value || '');
  const index = text.indexOf(':');
  return index >= 0 ? text.slice(index + 1).trim() : '';
}

export function loadConfig(env = process.env) {
  const port = numberFromEnv(env.PORT, 7892);
  const publicBaseUrl = trimRightSlash(env.PUBLIC_BASE_URL || `http://127.0.0.1:${port}`);
  const botmuxTargetMention = env.BOTMUX_TARGET_MENTION || '';
  const botmuxDataDir = env.BOTMUX_DATA_DIR || '';
  const botmuxRelayAppId = env.BOTMUX_RELAY_APP_ID || '';
  const botmuxRelaySessionsPath = env.BOTMUX_RELAY_SESSIONS_PATH
    || (botmuxDataDir && botmuxRelayAppId ? join(botmuxDataDir, `sessions-${botmuxRelayAppId}.json`) : '');

  return {
    port,
    publicBaseUrl,
    topicWebhookUrl: env.TOPIC_WEBHOOK_URL || '',
    xianyuSendUrl: env.XIANYU_SEND_URL || 'http://127.0.0.1:7893/xianyu/send',
    xianyuSendToken: env.XIANYU_SEND_TOKEN || '',
    xianyuInboundToken: env.XIANYU_INBOUND_TOKEN || '',
    agentReplyToken: env.AGENT_REPLY_TOKEN || '',
    botmuxSessionStorePath: env.BOTMUX_SESSION_STORE_PATH || '',
    botmuxRelayEnabled: boolFromEnv(env.BOTMUX_RELAY_ENABLED, false),
    botmuxCommand: env.BOTMUX_COMMAND || 'botmux',
    botmuxSendTimeoutMs: numberFromEnv(env.BOTMUX_SEND_TIMEOUT_MS, 15000),
    botmuxRelayLookupTimeoutMs: numberFromEnv(env.BOTMUX_RELAY_LOOKUP_TIMEOUT_MS, 5000),
    botmuxRelayLookupIntervalMs: numberFromEnv(env.BOTMUX_RELAY_LOOKUP_INTERVAL_MS, 250),
    botmuxDataDir,
    botmuxRelayAppId,
    botmuxRelaySessionsPath,
    botmuxRelayMention: env.BOTMUX_RELAY_MENTION || '',
    botmuxTargetMention,
    botmuxTargetName: env.BOTMUX_TARGET_NAME || mentionName(botmuxTargetMention),
    requestTimeoutMs: numberFromEnv(env.REQUEST_TIMEOUT_MS, 20000),
    sessionTtlMs: numberFromEnv(env.SESSION_TTL_MS, DEFAULT_SESSION_TTL_MS),
    mockXianyuSend: boolFromEnv(env.MOCK_XIANYU_SEND, false)
  };
}
