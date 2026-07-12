import dotenv from 'dotenv';

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

export function loadConfig(env = process.env) {
  const port = numberFromEnv(env.PORT, 7892);
  const publicBaseUrl = trimRightSlash(env.PUBLIC_BASE_URL || `http://127.0.0.1:${port}`);

  return {
    port,
    publicBaseUrl,
    topicWebhookUrl: env.TOPIC_WEBHOOK_URL || '',
    xianyuSendUrl: env.XIANYU_SEND_URL || 'http://127.0.0.1:7893/xianyu/send',
    xianyuSendToken: env.XIANYU_SEND_TOKEN || '',
    xianyuInboundToken: env.XIANYU_INBOUND_TOKEN || '',
    agentReplyToken: env.AGENT_REPLY_TOKEN || '',
    feishuAppId: env.FEISHU_APP_ID || '',
    feishuAppSecret: env.FEISHU_APP_SECRET || '',
    feishuReplyAppId: env.FEISHU_REPLY_APP_ID || env.FEISHU_APP_ID || '',
    feishuReplyAppSecret: env.FEISHU_REPLY_APP_SECRET || env.FEISHU_APP_SECRET || '',
    feishuReplyMentionOpenId: env.FEISHU_REPLY_MENTION_OPEN_ID || '',
    feishuReplyMentionName: env.FEISHU_REPLY_MENTION_NAME || '',
    feishuBaseUrl: trimRightSlash(env.FEISHU_BASE_URL || 'https://open.feishu.cn'),
    botmuxTargetAppId: env.BOTMUX_TARGET_APP_ID || env.FEISHU_APP_ID || '',
    botmuxTargetSessionsPath: env.BOTMUX_TARGET_SESSIONS_PATH || '',
    threadAnchorStorePath: env.THREAD_ANCHOR_STORE_PATH || '',
    requestTimeoutMs: numberFromEnv(env.REQUEST_TIMEOUT_MS, 20000),
    sessionTtlMs: numberFromEnv(env.SESSION_TTL_MS, DEFAULT_SESSION_TTL_MS),
    mockXianyuSend: boolFromEnv(env.MOCK_XIANYU_SEND, false)
  };
}
