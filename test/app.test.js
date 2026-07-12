import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createApp } from '../src/app.js';
import { HttpError } from '../src/errors.js';
import { FeishuClient } from '../src/feishu-client.js';
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
    threadAnchorStorePath: '',
    mockXianyuSend: false
  };

  const app = createApp({
    config,
    store: new SessionStore({ ttlMs: config.sessionTtlMs }),
    postJson: async (url, payload, options) => {
      calls.push({ url, payload, options });
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
    assert.equal(calls[0].payload.thread_key, 'xianyu:cid_1:buyer_1');
    assert.equal(calls[0].payload.instruction, undefined);
    assert.ok(!calls[0].payload.text.includes('你是闲鱼客服代理'));
    assert.equal(calls[0].payload.apiproxy_reply_url, 'http://proxy.local/agent/reply');
  } finally {
    server.close();
  }
});

test('已有飞书话题锚点时，闲鱼消息会回复到原话题', async () => {
  const webhookCalls = [];
  const feishuCalls = [];
  const config = {
    publicBaseUrl: 'http://proxy.local',
    topicWebhookUrl: 'http://topic.local/webhook',
    xianyuSendUrl: 'http://xianyu.local/send',
    xianyuSendToken: '',
    xianyuInboundToken: '',
    agentReplyToken: '',
    requestTimeoutMs: 1000,
    sessionTtlMs: 60000,
    threadAnchorStorePath: '',
    mockXianyuSend: false
  };

  const store = new SessionStore({ ttlMs: config.sessionTtlMs });
  store.setThreadAnchor('xianyu:cid_1:buyer_1', {
    lark_message_id: 'om_anchor',
    conversation_id: 'cid_1',
    buyer_id: 'buyer_1'
  });

  const app = createApp({
    config,
    store,
    postJson: async (url, payload, options) => {
      webhookCalls.push({ url, payload, options });
      return { status: 200, body: { ok: true, action: 'queued' } };
    },
    feishuClient: {
      enabled: true,
      replyMessage: async (messageId, text) => {
        feishuCalls.push({ messageId, text });
        return { code: 0, data: { message_id: 'om_reply' } };
      }
    }
  });

  const { server, baseUrl } = await listen(app);
  try {
    const result = await postJson(`${baseUrl}/xianyu/message`, {
      conversation_id: 'cid_1',
      buyer_id: 'buyer_1',
      buyer_name: '买家',
      message_text: '继续问一句'
    });

    assert.equal(result.status, 202);
    assert.equal(result.body.status, 'thread_queued');
    assert.equal(result.body.lark_anchor_message_id, 'om_anchor');
    assert.equal(webhookCalls.length, 0);
    assert.equal(feishuCalls.length, 1);
    assert.equal(feishuCalls[0].messageId, 'om_anchor');
    assert.match(feishuCalls[0].text, /继续问一句/);
  } finally {
    server.close();
  }
});

test('飞书话题回复会带上目标机器人 mention', async () => {
  const requests = [];
  const client = new FeishuClient({
    appId: 'reply-bot',
    appSecret: 'reply-secret',
    mentionOpenId: 'ou_agent_bot',
    mentionName: '客服机器人',
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (String(url).includes('/tenant_access_token/internal')) {
        return new Response(JSON.stringify({
          code: 0,
          tenant_access_token: 'tenant-token',
          expire: 7200
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        code: 0,
        data: { message_id: 'om_reply' }
      }), { status: 200 });
    }
  });

  const result = await client.replyMessage('om_anchor', '【闲鱼买家消息】\n继续问一句');

  assert.equal(result.code, 0);
  assert.equal(requests.length, 2);
  const replyBody = JSON.parse(requests[1].options.body);
  const content = JSON.parse(replyBody.content);
  assert.equal(replyBody.reply_in_thread, true);
  assert.match(content.text, /^<at user_id="ou_agent_bot">客服机器人<\/at>\n/);
  assert.match(content.text, /继续问一句/);
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
    threadAnchorStorePath: '',
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
      reply_text: '在的，可以拍。',
      lark_message_id: 'om_anchor'
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
    assert.equal(store.getThreadAnchor('xianyu:cid_1:buyer_1').lark_message_id, 'om_anchor');
  } finally {
    server.close();
  }
});

test('agent 回写带飞书消息 ID 时，会先记录话题锚点', async () => {
  const config = {
    publicBaseUrl: 'http://proxy.local',
    topicWebhookUrl: 'http://topic.local/webhook',
    xianyuSendUrl: 'http://xianyu.local/send',
    xianyuSendToken: '',
    xianyuInboundToken: '',
    agentReplyToken: '',
    requestTimeoutMs: 1000,
    sessionTtlMs: 60000,
    threadAnchorStorePath: '',
    mockXianyuSend: false
  };

  const store = new SessionStore({ ttlMs: config.sessionTtlMs });
  const session = store.create({
    conversation_id: 'cid_2',
    buyer_id: 'buyer_2',
    buyer_name: '买家2',
    message_text: '第一条消息'
  });

  const app = createApp({
    config,
    store,
    postJson: async () => {
      throw new HttpError(502, '闲鱼桥接不可用');
    }
  });

  const { server, baseUrl } = await listen(app);
  try {
    const result = await postJson(`${baseUrl}/agent/reply`, {
      correlation_id: session.correlation_id,
      reply_text: '收到，我看一下。',
      lark_message_id: 'om_anchor_2'
    });

    assert.equal(result.status, 502);
    assert.equal(store.getThreadAnchor('xianyu:cid_2:buyer_2').lark_message_id, 'om_anchor_2');
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
    threadAnchorStorePath: '',
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
