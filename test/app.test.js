import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createApp } from '../src/app.js';
import { HttpError } from '../src/errors.js';
import { SessionStore } from '../src/session-store.js';

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${port}`
      });
    });
  });
}

async function postJson(url, body, headers = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...headers
    },
    body: JSON.stringify(body)
  });

  return {
    status: response.status,
    body: await response.json()
  };
}

test('闲鱼消息会被投递到话题群，并返回 correlation_id', async () => {
  const calls = [];
  const config = {
    publicBaseUrl: 'http://proxy.local',
    topicWebhookUrl: 'http://topic.local/webhook',
    xianyuSendUrl: 'http://xianyu.local/send',
    xianyuSendToken: '',
    xianyuInboundToken: '',
    agentReplyToken: '',
    requestTimeoutMs: 1000,
    sessionTtlMs: 60000,
    mockXianyuSend: false
  };

  const app = createApp({
    config,
    store: new SessionStore({ ttlMs: config.sessionTtlMs }),
    postJson: async (url, payload, options) => {
      calls.push({ url, payload, options });
      return {
        status: 200,
        body: {
          ok: true,
          action: 'queued',
          target: {
            sessionId: 'botmux_session_1'
          }
        }
      };
    }
  });

  const { server, baseUrl } = await listen(app);
  try {
    const result = await postJson(`${baseUrl}/xianyu/message`, {
      conversation_id: 'cid_1',
      buyer_id: 'buyer_1',
      buyer_name: '买家',
      message_text: '还在吗'
    });

    assert.equal(result.status, 202);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.status, 'queued');
    assert.match(result.body.correlation_id, /^xy_/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, config.topicWebhookUrl);
    assert.equal(calls[0].options.headers['x-botmux-async'], '1');
    assert.equal(calls[0].options.headers['x-botmux-session-id'], undefined);
    assert.equal(calls[0].payload.message_text, '还在吗');
    assert.equal(calls[0].payload.thread_key, 'xianyu:cid_1:buyer_1');
    assert.equal(calls[0].payload.instruction, undefined);
    assert.ok(!calls[0].payload.text.includes('你是闲鱼客服代理'));
    assert.equal(calls[0].payload.apiproxy_reply_url, 'http://proxy.local/agent/reply');
    assert.equal(result.body.botmux_session_id, 'botmux_session_1');
  } finally {
    server.close();
  }
});

test('同一买家的后续消息会复用已保存的 botmux session', async () => {
  const webhookCalls = [];
  const config = {
    publicBaseUrl: 'http://proxy.local',
    topicWebhookUrl: 'http://topic.local/webhook',
    xianyuSendUrl: 'http://xianyu.local/send',
    xianyuSendToken: '',
    xianyuInboundToken: '',
    agentReplyToken: '',
    requestTimeoutMs: 1000,
    sessionTtlMs: 60000,
    mockXianyuSend: false
  };

  const store = new SessionStore({ ttlMs: config.sessionTtlMs });

  const app = createApp({
    config,
    store,
    postJson: async (url, payload, options) => {
      webhookCalls.push({ url, payload, options });
      return {
        status: 200,
        body: {
          ok: true,
          action: 'queued',
          target: {
            sessionId: 'botmux_session_1'
          }
        }
      };
    }
  });

  const { server, baseUrl } = await listen(app);
  try {
    const first = await postJson(`${baseUrl}/xianyu/message`, {
      conversation_id: 'cid_1',
      buyer_id: 'buyer_1',
      buyer_name: '买家',
      message_text: '第一句'
    });
    const second = await postJson(`${baseUrl}/xianyu/message`, {
      conversation_id: 'cid_1',
      buyer_id: 'buyer_1',
      buyer_name: '买家',
      message_text: '继续问一句'
    });

    assert.equal(first.status, 202);
    assert.equal(second.status, 202);
    assert.equal(first.body.status, 'queued');
    assert.equal(second.body.status, 'queued');
    assert.equal(webhookCalls.length, 2);
    assert.equal(webhookCalls[0].url, config.topicWebhookUrl);
    assert.equal(webhookCalls[1].url, config.topicWebhookUrl);
    assert.equal(webhookCalls[0].options.headers['x-botmux-async'], '1');
    assert.equal(webhookCalls[0].options.headers['x-botmux-session-id'], undefined);
    assert.equal(webhookCalls[1].options.headers['x-botmux-async'], '1');
    assert.equal(webhookCalls[1].options.headers['x-botmux-session-id'], 'botmux_session_1');
    assert.equal(webhookCalls[0].payload.thread_key, 'xianyu:cid_1:buyer_1');
    assert.equal(webhookCalls[1].payload.thread_key, 'xianyu:cid_1:buyer_1');
    assert.equal(webhookCalls[0].payload.correlation_id, first.body.correlation_id);
    assert.equal(webhookCalls[1].payload.correlation_id, second.body.correlation_id);
    assert.match(webhookCalls[1].payload.text, /继续问一句/);
    assert.equal(first.body.botmux_session_id, 'botmux_session_1');
    assert.equal(first.body.botmux_session_reused, false);
    assert.equal(second.body.botmux_session_id, 'botmux_session_1');
    assert.equal(second.body.botmux_session_reused, true);
  } finally {
    server.close();
  }
});

test('已保存的 botmux session 失效时会清理映射并重建', async () => {
  const webhookCalls = [];
  const config = {
    publicBaseUrl: 'http://proxy.local',
    topicWebhookUrl: 'http://topic.local/webhook',
    xianyuSendUrl: 'http://xianyu.local/send',
    xianyuSendToken: '',
    xianyuInboundToken: '',
    agentReplyToken: '',
    requestTimeoutMs: 1000,
    sessionTtlMs: 60000,
    mockXianyuSend: false
  };

  const store = new SessionStore({ ttlMs: config.sessionTtlMs });
  store.setConversationSession('xianyu:cid_2:buyer_2', {
    botmux_session_id: 'stale_session',
    conversation_id: 'cid_2',
    buyer_id: 'buyer_2'
  });

  const app = createApp({
    config,
    store,
    postJson: async (url, payload, options) => {
      webhookCalls.push({ url, payload, options });
      if (webhookCalls.length === 1) {
        throw new HttpError(404, 'botmux session not found');
      }
      return {
        status: 200,
        body: {
          ok: true,
          action: 'queued',
          target: {
            sessionId: 'new_session'
          }
        }
      };
    }
  });

  const { server, baseUrl } = await listen(app);
  try {
    const result = await postJson(`${baseUrl}/xianyu/message`, {
      conversation_id: 'cid_2',
      buyer_id: 'buyer_2',
      buyer_name: '买家2',
      message_text: '旧 session 失效后重建'
    });

    assert.equal(result.status, 202);
    assert.equal(webhookCalls.length, 2);
    assert.equal(webhookCalls[0].options.headers['x-botmux-session-id'], 'stale_session');
    assert.equal(webhookCalls[1].options.headers['x-botmux-session-id'], undefined);
    assert.equal(result.body.botmux_session_id, 'new_session');
    assert.equal(result.body.botmux_session_retried, true);
    assert.equal(store.getConversationSession('xianyu:cid_2:buyer_2').botmux_session_id, 'new_session');
  } finally {
    server.close();
  }
});

test('agent 回写会转发到闲鱼发送接口', async () => {
  const calls = [];
  const config = {
    publicBaseUrl: 'http://proxy.local',
    topicWebhookUrl: 'http://topic.local/webhook',
    xianyuSendUrl: 'http://xianyu.local/send',
    xianyuSendToken: 'send-secret',
    xianyuInboundToken: '',
    agentReplyToken: 'secret',
    requestTimeoutMs: 1000,
    sessionTtlMs: 60000,
    mockXianyuSend: false
  };

  const store = new SessionStore({ ttlMs: config.sessionTtlMs });
  const session = store.create({
    conversation_id: 'cid_1',
    buyer_id: 'buyer_1',
    buyer_name: '买家',
    message_text: '还在吗'
  });

  const app = createApp({
    config,
    store,
    postJson: async (url, payload, options) => {
      calls.push({ url, payload, options });
      return { status: 200, body: { ok: true, sent: true } };
    }
  });

  const { server, baseUrl } = await listen(app);
  try {
    const result = await postJson(`${baseUrl}/agent/reply`, {
      correlation_id: session.correlation_id,
      reply_text: '在的，可以拍。'
    }, {
      authorization: 'Bearer secret'
    });

    assert.equal(result.status, 200);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.status, 'sent');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, config.xianyuSendUrl);
    assert.equal(calls[0].payload.conversation_id, 'cid_1');
    assert.equal(calls[0].payload.buyer_id, 'buyer_1');
    assert.equal(calls[0].payload.text, '在的，可以拍。');
    assert.equal(calls[0].options.headers.Authorization, 'Bearer send-secret');
  } finally {
    server.close();
  }
});

test('agent 回写鉴权失败会返回 401', async () => {
  const config = {
    publicBaseUrl: 'http://proxy.local',
    topicWebhookUrl: 'http://topic.local/webhook',
    xianyuSendUrl: 'http://xianyu.local/send',
    xianyuSendToken: '',
    xianyuInboundToken: '',
    agentReplyToken: 'secret',
    requestTimeoutMs: 1000,
    sessionTtlMs: 60000,
    mockXianyuSend: true
  };

  const app = createApp({
    config,
    store: new SessionStore({ ttlMs: config.sessionTtlMs }),
    postJson: async () => ({ status: 200, body: { ok: true } })
  });

  const { server, baseUrl } = await listen(app);
  try {
    const result = await postJson(`${baseUrl}/agent/reply`, {
      correlation_id: 'missing',
      reply_text: '测试'
    });

    assert.equal(result.status, 401);
    assert.equal(result.body.ok, false);
  } finally {
    server.close();
  }
});
