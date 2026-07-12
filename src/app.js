import Koa from 'koa';
import Router from '@koa/router';
import bodyParser from 'koa-bodyparser';

import { requireOptionalBearer } from './auth.js';
import { assertHttp, HttpError } from './errors.js';
import { postJson as defaultPostJson } from './http.js';
import { SessionStore } from './session-store.js';
import { buildTopicPayload } from './topic-payload.js';

function normalizeInboundMessage(body) {
  const messageText = body.message_text || body.text;

  assertHttp(body && typeof body === 'object', 400, '请求体必须是 JSON 对象');
  assertHttp(body.conversation_id, 400, '缺少 conversation_id');
  assertHttp(body.buyer_id, 400, '缺少 buyer_id');
  assertHttp(messageText, 400, '缺少 message_text 或 text');

  return {
    correlation_id: body.correlation_id,
    conversation_id: String(body.conversation_id),
    buyer_id: String(body.buyer_id),
    buyer_name: body.buyer_name ? String(body.buyer_name) : '',
    message_text: String(messageText),
    item_id: body.item_id ? String(body.item_id) : '',
    raw: body.raw || null
  };
}

function normalizeReply(body) {
  assertHttp(body && typeof body === 'object', 400, '请求体必须是 JSON 对象');
  assertHttp(body.correlation_id, 400, '缺少 correlation_id');
  const replyText = String(body.reply_text || '').trim();
  assertHttp(replyText, 400, '缺少 reply_text');

  return {
    correlation_id: String(body.correlation_id),
    reply_text: replyText
  };
}

function previewText(value, max = 80) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...`;
}

function maskId(value) {
  const text = String(value || '');
  if (text.length <= 8) return `${text.slice(0, 2)}***`;
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

function logInfo(event, details = {}) {
  console.info(JSON.stringify({
    ts: new Date().toISOString(),
    event,
    ...details
  }));
}

function buildXianyuSendPayload(session, replyText) {
  return {
    correlation_id: session.correlation_id,
    conversation_id: session.conversation_id,
    buyer_id: session.buyer_id,
    text: replyText,
    reply_text: replyText
  };
}

function extractBotmuxSessionId(topicBody) {
  const value = topicBody?.target?.sessionId || topicBody?.sessionId;
  return value ? String(value) : '';
}

function extractRelaySessionId(result) {
  const parsed = result?.parsed || {};
  const value = parsed?.target?.sessionId
    || parsed?.sessionId
    || parsed?.session?.id
    || parsed?.data?.target?.sessionId
    || parsed?.data?.sessionId;
  return value ? String(value) : '';
}

function resolveTargetMentionFromRelay(relaySessionInfo, config) {
  const targetName = config.botmuxTargetName;
  const bot = relaySessionInfo?.availableBots?.find((item) => item.name === targetName);
  return bot?.mention || config.botmuxTargetMention;
}

async function resolveRelaySessionInfo({ config, botmuxClient, session, targetSessionId, sendResult }) {
  const returnedSessionId = extractRelaySessionId(sendResult);
  if (returnedSessionId && returnedSessionId !== targetSessionId) {
    return {
      sessionId: returnedSessionId,
      source: 'send_response'
    };
  }

  const found = await botmuxClient.waitForRelaySession?.({
    conversationKey: session.thread_key,
    excludeSessionIds: [targetSessionId],
    notBeforeMs: sendResult?.notBeforeMs || 0,
    timeoutMs: config.botmuxRelayLookupTimeoutMs,
    intervalMs: config.botmuxRelayLookupIntervalMs
  });

  if (!found?.sessionId) return null;

  return {
    ...found,
    targetMention: resolveTargetMentionFromRelay(found, config),
    source: 'session_store'
  };
}

async function resolveTargetSessionInfo({ config, botmuxClient, session, topicResult, notBeforeMs = 0 }) {
  const returnedSessionId = extractBotmuxSessionId(topicResult.body);
  if (returnedSessionId) {
    const found = await botmuxClient?.findTargetSessionById?.(returnedSessionId);
    return {
      ...found,
      sessionId: returnedSessionId,
      source: 'webhook_response',
      agentFrozen: Boolean(found?.agentFrozen)
    };
  }

  const found = await botmuxClient?.waitForTargetSession?.({
    conversationKey: session.thread_key,
    notBeforeMs,
    timeoutMs: config.botmuxRelayLookupTimeoutMs,
    intervalMs: config.botmuxRelayLookupIntervalMs
  });
  if (!found?.sessionId) return null;

  return {
    ...found,
    source: 'target_session_store'
  };
}

function isStaleRelayError(error) {
  const text = `${error.message || ''} ${error.botmux?.stdout || ''} ${error.botmux?.stderr || ''}`;
  return /session/i.test(text)
    && /(not found|missing|expired|invalid|不存在|过期|无效)/i.test(text);
}

function buildRelayInitMessage(session) {
  return [
    '初始化闲鱼消息中转会话。',
    `conversation_key: ${session.thread_key}`,
    `conversation_id: ${session.conversation_id}`,
    `buyer_id: ${session.buyer_id}`,
    `buyer_name: ${session.buyer_name || ''}`
  ].join('\n');
}

function buildWakeMessage(session) {
  return [
    '请处理以下闲鱼买家消息，并按客服规则回写。',
    `correlation_id: ${session.correlation_id}`,
    `conversation_key: ${session.thread_key}`,
    `conversation_id: ${session.conversation_id}`,
    `buyer_id: ${session.buyer_id}`,
    `buyer_name: ${session.buyer_name || ''}`,
    `item_id: ${session.item_id || ''}`,
    '买家原文：',
    session.message_text
  ].join('\n');
}

function createRelayError(message, details = undefined) {
  return new HttpError(502, message, details);
}

function requireRelayConfig(config, botmuxClient) {
  if (!botmuxClient?.enabled) {
    throw createRelayError('botmux relay 未启用');
  }
  if (!config.botmuxRelayMention) {
    throw createRelayError('缺少 BOTMUX_RELAY_MENTION');
  }
  if (!config.botmuxTargetMention) {
    throw createRelayError('缺少 BOTMUX_TARGET_MENTION');
  }
}

async function triggerFirstWebhook({ config, postJson, session, topicPayload }) {
  return postJson(config.topicWebhookUrl, topicPayload, {
    timeoutMs: config.requestTimeoutMs
  });
}

async function initializeRelaySession({ config, botmuxClient, sessionStore, session, mapping }) {
  requireRelayConfig(config, botmuxClient);

  const targetSessionId = mapping?.target_session_id || mapping?.botmux_session_id;
  if (!targetSessionId) {
    throw createRelayError('缺少 target_session_id，无法初始化 relay session');
  }

  const relayStartedAt = Date.now();
  const result = await botmuxClient.sendMention({
    sessionId: targetSessionId,
    mention: config.botmuxRelayMention,
    message: buildRelayInitMessage(session)
  });
  result.notBeforeMs = Math.max(0, relayStartedAt - 1000);

  const relaySessionInfo = await resolveRelaySessionInfo({
    config,
    botmuxClient,
    session,
    targetSessionId,
    sendResult: result
  });
  if (!relaySessionInfo?.sessionId) {
    throw createRelayError('未能定位 relay sessionId', result);
  }

  const conversationSession = sessionStore.setConversationSession(session.thread_key, {
    ...mapping,
    target_session_id: targetSessionId,
    target_session_source: mapping?.target_session_source || '',
    target_agent_frozen: Boolean(mapping?.target_agent_frozen),
    relay_session_id: relaySessionInfo.sessionId,
    thread_root_id: relaySessionInfo.rootMessageId || mapping?.thread_root_id || '',
    relay_session_source: relaySessionInfo.source,
    target_mention: relaySessionInfo.targetMention || mapping?.target_mention || config.botmuxTargetMention,
    conversation_id: session.conversation_id,
    buyer_id: session.buyer_id,
    buyer_name: session.buyer_name,
    last_correlation_id: session.correlation_id,
    relay_init_response: result.parsed || result.stdout || ''
  });

  logInfo('botmux.relay.session.saved', {
    thread_key: conversationSession.conversation_key,
    target_session_id: conversationSession.target_session_id,
    relay_session_id: conversationSession.relay_session_id,
    relay_session_source: conversationSession.relay_session_source,
    thread_root_id: conversationSession.thread_root_id,
    target_mention: conversationSession.target_mention,
    last_correlation_id: conversationSession.last_correlation_id
  });
  return conversationSession;
}

async function wakeTargetAgent({ config, botmuxClient, session, relaySessionId, targetMention }) {
  requireRelayConfig(config, botmuxClient);
  return botmuxClient.sendMention({
    sessionId: relaySessionId,
    mention: targetMention || config.botmuxTargetMention,
    message: buildWakeMessage(session)
  });
}

function applyErrorMiddleware(app) {
  app.use(async (ctx, next) => {
    try {
      await next();
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      ctx.status = status;
      ctx.body = {
        ok: false,
        error: error.message || '服务异常',
        details: error.details
      };

      if (status >= 500) {
        console.error(error);
      }
    }
  });
}

export function createApp({ config, store, postJson = defaultPostJson, botmuxClient = null } = {}) {
  const app = new Koa();
  const router = new Router();
  const sessionStore = store || new SessionStore({
    ttlMs: config.sessionTtlMs,
    botmuxSessionStorePath: config.botmuxSessionStorePath
  });

  applyErrorMiddleware(app);
  app.use(bodyParser({ jsonLimit: '2mb' }));

  router.get('/health', (ctx) => {
    ctx.body = {
      ok: true,
      service: 'xianyu-agent-proxy'
    };
  });

  router.post('/xianyu/message', requireOptionalBearer(config.xianyuInboundToken), async (ctx) => {
    const input = normalizeInboundMessage(ctx.request.body);
    const session = sessionStore.create(input);
    const topicPayload = buildTopicPayload(session, config);
    let conversationSession = sessionStore.getConversationSession(session.thread_key);

    logInfo('xianyu.message.received', {
      correlation_id: session.correlation_id,
      conversation_id: session.conversation_id,
      buyer_id: maskId(session.buyer_id),
      buyer_name: session.buyer_name,
      thread_key: session.thread_key,
      has_target_session: Boolean(conversationSession?.target_session_id || conversationSession?.botmux_session_id),
      has_relay_session: Boolean(conversationSession?.relay_session_id),
      message_length: session.message_text.length,
      message_preview: previewText(session.message_text)
    });

    if (conversationSession?.relay_session_id && botmuxClient?.enabled) {
      let relaySession = conversationSession;
      let retried = false;
      let relayResult;

      try {
        relayResult = await wakeTargetAgent({
          config,
          botmuxClient,
          session,
          relaySessionId: relaySession.relay_session_id,
          targetMention: relaySession.target_mention
        });
      } catch (error) {
        if (!isStaleRelayError(error)) throw error;

        retried = true;
        relaySession = await initializeRelaySession({
          config,
          botmuxClient,
          sessionStore,
          session,
          mapping: {
            ...conversationSession,
            relay_session_id: ''
          }
        });
        relayResult = await wakeTargetAgent({
          config,
          botmuxClient,
          session,
          relaySessionId: relaySession.relay_session_id,
          targetMention: relaySession.target_mention
        });
      }

      const updated = sessionStore.update(session.correlation_id, {
        status: 'relay_queued',
        relay_response: relayResult.parsed || relayResult.stdout || '',
        target_session_id: relaySession.target_session_id,
        relay_session_id: relaySession.relay_session_id
      });

      ctx.status = 202;
      ctx.body = {
        ok: true,
        correlation_id: updated.correlation_id,
        status: updated.status,
        apiproxy_reply_url: topicPayload.apiproxy_reply_url,
        thread_key: updated.thread_key,
        target_session_id: relaySession.target_session_id,
        relay_session_id: relaySession.relay_session_id,
        relay_retried: retried,
        relay: relayResult.parsed || relayResult.stdout || ''
      };

      logInfo('botmux.relay.queued', {
        correlation_id: updated.correlation_id,
        thread_key: updated.thread_key,
        target_session_id: relaySession.target_session_id,
        relay_session_id: relaySession.relay_session_id,
        retried
      });
      return;
    }

    const webhookStartedAt = Date.now();
    const topicResult = await triggerFirstWebhook({
      config,
      postJson,
      session,
      topicPayload
    });
    const targetSessionInfo = await resolveTargetSessionInfo({
      config,
      botmuxClient,
      session,
      topicResult,
      notBeforeMs: Math.max(0, webhookStartedAt - 1000)
    });
    const targetSessionId = targetSessionInfo?.sessionId || '';
    let relaySession = null;
    let relayInitError = null;

    if (targetSessionId) {
      const targetSession = sessionStore.setConversationSession(session.thread_key, {
        ...conversationSession,
        target_session_id: targetSessionId,
        target_session_source: targetSessionInfo.source,
        target_agent_frozen: Boolean(targetSessionInfo.agentFrozen),
        conversation_id: session.conversation_id,
        buyer_id: session.buyer_id,
        buyer_name: session.buyer_name,
        last_correlation_id: session.correlation_id,
        topic_response: topicResult.body
      });

      if (botmuxClient?.enabled && config.botmuxRelayMention && config.botmuxTargetMention) {
        try {
          relaySession = await initializeRelaySession({
            config,
            botmuxClient,
            sessionStore,
            session,
            mapping: targetSession
          });
        } catch (error) {
          relayInitError = error.message || 'relay 初始化失败';
          logInfo('botmux.relay.init_failed', {
            correlation_id: session.correlation_id,
            thread_key: session.thread_key,
            target_session_id: targetSessionId,
            error: relayInitError
          });
        }
      }
    } else if (botmuxClient?.enabled && config.botmuxRelayMention && config.botmuxTargetMention) {
      relayInitError = '未能定位哈喽哈 target_session_id，无法初始化 relay session';
      logInfo('botmux.target_session.lookup_failed', {
        correlation_id: session.correlation_id,
        thread_key: session.thread_key
      });
    }

    const updated = sessionStore.update(session.correlation_id, {
      status: 'queued',
      topic_response: topicResult.body,
      target_session_id: targetSessionId,
      target_session_source: targetSessionInfo?.source || '',
      target_agent_frozen: Boolean(targetSessionInfo?.agentFrozen),
      relay_session_id: relaySession?.relay_session_id || '',
      relay_init_error: relayInitError
    });

    ctx.status = 202;
    ctx.body = {
      ok: true,
      correlation_id: updated.correlation_id,
      status: updated.status,
      apiproxy_reply_url: topicPayload.apiproxy_reply_url,
      thread_key: updated.thread_key,
      target_session_id: targetSessionId,
      target_session_source: targetSessionInfo?.source || '',
      target_agent_frozen: Boolean(targetSessionInfo?.agentFrozen),
      relay_session_id: relaySession?.relay_session_id || '',
      relay_ready: Boolean(relaySession?.relay_session_id),
      relay_init_error: relayInitError,
      topic: topicResult.body
    };

    logInfo('topic.webhook.queued', {
      correlation_id: updated.correlation_id,
      thread_key: updated.thread_key,
      action: topicResult.body?.action,
      trigger_id: topicResult.body?.triggerId,
      session_id: topicResult.body?.target?.sessionId,
      target_session_id: targetSessionId,
      target_session_source: targetSessionInfo?.source || '',
      target_agent_frozen: Boolean(targetSessionInfo?.agentFrozen),
      relay_session_id: relaySession?.relay_session_id || '',
      chat_id: topicResult.body?.target?.chatId
    });
  });

  router.post('/agent/reply', requireOptionalBearer(config.agentReplyToken), async (ctx) => {
    const input = normalizeReply(ctx.request.body);
    const session = sessionStore.get(input.correlation_id);
    assertHttp(session, 404, '找不到 correlation_id 对应的闲鱼会话');

    logInfo('agent.reply.received', {
      correlation_id: input.correlation_id,
      conversation_id: session.conversation_id,
      thread_key: session.thread_key,
      reply_length: input.reply_text.length,
      reply_preview: previewText(input.reply_text)
    });

    if (config.mockXianyuSend) {
      const updated = sessionStore.update(input.correlation_id, {
        status: 'mock_sent',
        reply_text: input.reply_text,
        xianyu_response: {
          ok: true,
          mocked: true
        }
      });

      ctx.body = {
        ok: true,
        correlation_id: updated.correlation_id,
        status: updated.status,
        xianyu: updated.xianyu_response
      };
      logInfo('xianyu.reply.mock_sent', {
        correlation_id: updated.correlation_id
      });
      return;
    }

    const sendPayload = buildXianyuSendPayload(session, input.reply_text);
    const sendHeaders = config.xianyuSendToken
      ? { Authorization: `Bearer ${config.xianyuSendToken}` }
      : {};
    const xianyuResult = await postJson(config.xianyuSendUrl, sendPayload, {
      timeoutMs: config.requestTimeoutMs,
      headers: sendHeaders
    });

    const updated = sessionStore.update(input.correlation_id, {
      status: 'sent',
      reply_text: input.reply_text,
      xianyu_response: xianyuResult.body
    });

    ctx.body = {
      ok: true,
      correlation_id: updated.correlation_id,
      status: updated.status,
      xianyu: xianyuResult.body
    };

    logInfo('xianyu.reply.sent', {
      correlation_id: updated.correlation_id,
      conversation_id: updated.conversation_id,
      thread_key: updated.thread_key,
      xianyu_ok: xianyuResult.body?.ok
    });
  });

  router.get('/sessions/:correlation_id', (ctx) => {
    const session = sessionStore.get(ctx.params.correlation_id);
    assertHttp(session, 404, '找不到 correlation_id 对应的闲鱼会话');
    ctx.body = {
      ok: true,
      session
    };
  });

  app.use(router.routes());
  app.use(router.allowedMethods());

  return app;
}
