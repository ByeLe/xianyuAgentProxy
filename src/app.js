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
  assertHttp(body.reply_text, 400, '缺少 reply_text');

  return {
    correlation_id: String(body.correlation_id),
    reply_text: String(body.reply_text)
  };
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

export function createApp({ config, store = new SessionStore({ ttlMs: config.sessionTtlMs }), postJson = defaultPostJson } = {}) {
  const app = new Koa();
  const router = new Router();

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
    const session = store.create(input);
    const topicPayload = buildTopicPayload(session, config);

    const topicResult = await postJson(config.topicWebhookUrl, topicPayload, {
      timeoutMs: config.requestTimeoutMs
    });

    const updated = store.update(session.correlation_id, {
      status: 'queued',
      topic_response: topicResult.body
    });

    ctx.status = 202;
    ctx.body = {
      ok: true,
      correlation_id: updated.correlation_id,
      status: updated.status,
      apiproxy_reply_url: topicPayload.apiproxy_reply_url,
      topic: topicResult.body
    };
  });

  router.post('/agent/reply', requireOptionalBearer(config.agentReplyToken), async (ctx) => {
    const input = normalizeReply(ctx.request.body);
    const session = store.get(input.correlation_id);
    assertHttp(session, 404, '找不到 correlation_id 对应的闲鱼会话');

    if (config.mockXianyuSend) {
      const updated = store.update(input.correlation_id, {
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

    const updated = store.update(input.correlation_id, {
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
  });

  router.get('/sessions/:correlation_id', (ctx) => {
    const session = store.get(ctx.params.correlation_id);
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
