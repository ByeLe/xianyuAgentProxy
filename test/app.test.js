import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createApp } from '../src/app.js';
import { SessionStore } from '../src/session-store.js';

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
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
    xianyuInboundToken: '',
    agentReplyToken: '',
    requestTimeoutMs: 1000,
    sessionTtlMs: 60000,
    mockXianyuSend: false
  };

  const app = createApp({
    config,
    store: new SessionStore({ ttlMs: config.sessionTtlMs }),
    postJson: async (url, payload) => {
      calls.push({ url, payload });
      return { status: 200, body: { ok: true, action: 'queued' } };
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
    assert.equal(calls[0].payload.message_text, '还在吗');
    assert.equal(calls[0].payload.apiproxy_reply_url, 'http://proxy.local/agent/reply');
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
    postJson: async (url, payload) => {
      calls.push({ url, payload });
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
  } finally {
    server.close();
  }
});

test('agent 回写鉴权失败会返回 401', async () => {
  const config = {
    publicBaseUrl: 'http://proxy.local',
    topicWebhookUrl: 'http://topic.local/webhook',
    xianyuSendUrl: 'http://xianyu.local/send',
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
