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
    reply_text: replyText,
    lark_message_id: normalizeLarkMessageId(body)
  };
}

function normalizeLarkMessageId(body) {
  const value = body.lark_message_id
    || body.feishu_message_id
    || body.thread_message_id
    || body.message_id;
  return value ? String(value) : '';
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

export function createApp({
  config,
  store,
  postJson = defaultPostJson,
  feishuClient = null,
  botmuxSessionReader = null
} = {}) {
  const app = new Koa();
  const router = new Router();
  const sessionStore = store || new SessionStore({
    ttlMs: config.sessionTtlMs,
    anchorStorePath: config.threadAnchorStorePath
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
    const threadAnchor = sessionStore.getThreadAnchor(session.thread_key);

    logInfo('xianyu.message.received', {
      correlation_id: session.correlation_id,
      conversation_id: session.conversation_id,
      buyer_id: maskId(session.buyer_id),
      buyer_name: session.buyer_name,
      thread_key: session.thread_key,
      has_lark_anchor: Boolean(threadAnchor?.lark_message_id),
      message_length: session.message_text.length,
      message_preview: previewText(session.message_text)
    });

    if (threadAnchor?.lark_message_id && feishuClient?.enabled) {
      const feishuResult = await feishuClient.replyMessage(threadAnchor.lark_message_id, topicPayload.text);
      const updated = sessionStore.update(session.correlation_id, {
        status: 'thread_queued',
        topic_response: feishuResult,
        lark_anchor_message_id: threadAnchor.lark_message_id
      });

      ctx.status = 202;
      ctx.body = {
        ok: true,
        correlation_id: updated.correlation_id,
        status: updated.status,
        apiproxy_reply_url: topicPayload.apiproxy_reply_url,
        thread_key: updated.thread_key,
        lark_anchor_message_id: threadAnchor.lark_message_id,
        topic: feishuResult
      };

      logInfo('feishu.thread.reply.queued', {
        correlation_id: updated.correlation_id,
        thread_key: updated.thread_key,
        anchor_message_id: threadAnchor.lark_message_id,
        feishu_message_id: feishuResult?.data?.message_id || feishuResult?.message_id
      });
      return;
    }

    const topicResult = await postJson(config.topicWebhookUrl, topicPayload, {
      timeoutMs: config.requestTimeoutMs
    });
    const targetSessionId = topicResult.body?.target?.sessionId || topicResult.body?.sessionId || '';
    const threadAnchorFromBotmux = await rememberBotmuxRootAnchor({
      botmuxSessionReader,
      sessionStore,
      session,
      targetSessionId
    });

    const updated = sessionStore.update(session.correlation_id, {
      status: 'queued',
      topic_response: topicResult.body,
      lark_anchor_message_id: threadAnchorFromBotmux?.lark_message_id || ''
    });

    ctx.status = 202;
    ctx.body = {
      ok: true,
      correlation_id: updated.correlation_id,
      status: updated.status,
      apiproxy_reply_url: topicPayload.apiproxy_reply_url,
      thread_key: updated.thread_key,
      lark_anchor_message_id: threadAnchorFromBotmux?.lark_message_id || '',
      topic: topicResult.body
    };

    logInfo('topic.webhook.queued', {
      correlation_id: updated.correlation_id,
      thread_key: updated.thread_key,
      action: topicResult.body?.action,
      trigger_id: topicResult.body?.triggerId,
      session_id: targetSessionId,
      lark_anchor_message_id: threadAnchorFromBotmux?.lark_message_id || '',
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
      has_lark_message_id: Boolean(input.lark_message_id),
      reply_length: input.reply_text.length,
      reply_preview: previewText(input.reply_text)
    });

    const threadAnchor = rememberLarkAnchor(sessionStore, session, input.lark_message_id);

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
        lark_anchor_message_id: threadAnchor?.lark_message_id || '',
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
      lark_anchor_message_id: threadAnchor?.lark_message_id || '',
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

function rememberLarkAnchor(store, session, larkMessageId) {
  if (!larkMessageId) return null;
  const anchor = store.setThreadAnchor(session.thread_key, {
    lark_message_id: larkMessageId,
    conversation_id: session.conversation_id,
    buyer_id: session.buyer_id,
    buyer_name: session.buyer_name,
    last_correlation_id: session.correlation_id
  });
  logInfo('lark.thread.anchor.saved', {
    thread_key: anchor.thread_key,
    lark_message_id: anchor.lark_message_id,
    last_correlation_id: anchor.last_correlation_id
  });
  return anchor;
}

async function rememberBotmuxRootAnchor({
  botmuxSessionReader,
  sessionStore,
  session,
  targetSessionId
}) {
  if (!botmuxSessionReader?.enabled || !targetSessionId) return null;

  const result = await botmuxSessionReader.waitForRootMessageId(targetSessionId);
  if (!result?.rootMessageId) {
    logInfo('botmux.root_anchor.missing', {
      correlation_id: session.correlation_id,
      thread_key: session.thread_key,
      target_session_id: targetSessionId
    });
    return null;
  }

  const anchor = rememberLarkAnchor(sessionStore, session, result.rootMessageId);
  logInfo('botmux.root_anchor.saved', {
    correlation_id: session.correlation_id,
    thread_key: session.thread_key,
    target_session_id: targetSessionId,
    lark_message_id: anchor?.lark_message_id || ''
  });
  return anchor;
}
