import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createApp } from '../src/app.js';
import { BotmuxClient } from '../src/botmux-client.js';
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

test('BotmuxClient 使用参数数组发送 mention', async () => {
  const calls = [];
  const client = new BotmuxClient({
    command: 'botmux',
    execFileImpl: async (command, args, options) => {
      calls.push({ command, args, options });
      return {
        stdout: JSON.stringify({
          success: true,
          target: {
            sessionId: 'relay_session'
          }
        }),
        stderr: ''
      };
    }
  });

  const result = await client.sendMention({
    sessionId: 'target_session',
    mention: 'ou_relay:用户的嘴替',
    message: '买家原文：hello; rm -rf /'
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'botmux');
  assert.deepEqual(calls[0].args, [
    'send',
    '--session-id', 'target_session',
    '--mention', 'ou_relay:用户的嘴替',
    '买家原文：hello; rm -rf /'
  ]);
  assert.equal(result.parsed.target.sessionId, 'relay_session');
});

test('BotmuxClient 可从 relay bot 会话文件定位 session', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xianyu-agent-proxy-'));
  const sessionsPath = join(dir, 'sessions-cli_relay.json');
  await writeFile(sessionsPath, JSON.stringify({
    older: {
      sessionId: 'older_relay',
      createdAt: '2026-07-12T00:00:00.000Z',
      lastUserPrompt: 'conversation_key: xianyu:cid_1:buyer_1'
    },
    newer: {
      sessionId: 'newer_relay',
      rootMessageId: 'om_root',
      chatId: 'oc_chat',
      createdAt: '2026-07-12T00:01:00.000Z',
      lastUserPrompt: '[来自 哈喽哈 的 @mention]\nconversation_key: xianyu:cid_1:buyer_1',
      lastCliInput: '<available_bots><bot name="哈喽哈" open_id="ou_target_from_relay" /></available_bots>'
    }
  }));

  const client = new BotmuxClient({
    command: 'botmux',
    relaySessionsPath: sessionsPath
  });

  try {
    const found = await client.waitForRelaySession({
      conversationKey: 'xianyu:cid_1:buyer_1',
      excludeSessionIds: ['target_session'],
      timeoutMs: 1,
      intervalMs: 1
    });

    assert.equal(found.sessionId, 'newer_relay');
    assert.equal(found.rootMessageId, 'om_root');
    assert.equal(found.chatId, 'oc_chat');
    assert.deepEqual(found.availableBots, [{
      name: '哈喽哈',
      openId: 'ou_target_from_relay',
      mention: 'ou_target_from_relay:哈喽哈'
    }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('闲鱼消息会被投递到话题群，并返回 correlation_id', async () => {
  const calls = [];
  const config = {
    publicBaseUrl: 'http://proxy.local',
    topicWebhookUrl: 'http://topic.local/webhook',
    xianyuSendUrl: 'http://xianyu.local/send',
    xianyuSendToken: '',
    xianyuInboundToken: '',
    agentReplyToken: '',
    botmuxRelayMention: '',
    botmuxTargetMention: '',
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
    assert.equal(result.body.target_session_id, 'botmux_session_1');
    assert.equal(result.body.relay_ready, false);
  } finally {
    server.close();
  }
});

test('首条消息会初始化 relay session，后续消息走 relay 唤醒目标机器人', async () => {
  const webhookCalls = [];
  const botmuxCalls = [];
  const relayLookups = [];
  const config = {
    publicBaseUrl: 'http://proxy.local',
    topicWebhookUrl: 'http://topic.local/webhook',
    xianyuSendUrl: 'http://xianyu.local/send',
    xianyuSendToken: '',
    xianyuInboundToken: '',
    agentReplyToken: '',
    botmuxRelayMention: 'ou_relay:用户的嘴替',
    botmuxTargetMention: 'ou_target_fallback:哈喽哈',
    botmuxTargetName: '哈喽哈',
    botmuxRelayLookupTimeoutMs: 50,
    botmuxRelayLookupIntervalMs: 1,
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
            sessionId: 'target_session_1'
          }
        }
      };
    },
    botmuxClient: {
      enabled: true,
      sendMention: async (input) => {
        botmuxCalls.push(input);
        return {
          success: true,
          parsed: {
            success: true,
            target: {
              sessionId: 'target_session_1'
            }
          }
        };
      },
      waitForRelaySession: async (input) => {
        relayLookups.push(input);
        return {
          sessionId: 'relay_session_1',
          rootMessageId: 'om_root_1',
          availableBots: [{
            name: '哈喽哈',
            openId: 'ou_target_from_relay',
            mention: 'ou_target_from_relay:哈喽哈'
          }]
        };
      }
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
    assert.equal(second.body.status, 'relay_queued');
    assert.equal(webhookCalls.length, 1);
    assert.equal(webhookCalls[0].url, config.topicWebhookUrl);
    assert.equal(webhookCalls[0].options.headers['x-botmux-async'], '1');
    assert.equal(webhookCalls[0].options.headers['x-botmux-session-id'], undefined);
    assert.equal(webhookCalls[0].payload.thread_key, 'xianyu:cid_1:buyer_1');
    assert.equal(webhookCalls[0].payload.correlation_id, first.body.correlation_id);
    assert.equal(botmuxCalls.length, 2);
    assert.equal(botmuxCalls[0].sessionId, 'target_session_1');
    assert.equal(botmuxCalls[0].mention, config.botmuxRelayMention);
    assert.match(botmuxCalls[0].message, /初始化闲鱼消息中转会话/);
    assert.equal(relayLookups.length, 1);
    assert.equal(relayLookups[0].conversationKey, 'xianyu:cid_1:buyer_1');
    assert.deepEqual(relayLookups[0].excludeSessionIds, ['target_session_1']);
    assert.equal(botmuxCalls[1].sessionId, 'relay_session_1');
    assert.equal(botmuxCalls[1].mention, 'ou_target_from_relay:哈喽哈');
    assert.match(botmuxCalls[1].message, /correlation_id:/);
    assert.match(botmuxCalls[1].message, /继续问一句/);
    assert.equal(first.body.target_session_id, 'target_session_1');
    assert.equal(first.body.relay_session_id, 'relay_session_1');
    assert.equal(first.body.relay_ready, true);
    assert.equal(second.body.target_session_id, 'target_session_1');
    assert.equal(second.body.relay_session_id, 'relay_session_1');
    assert.equal(store.getConversationSession('xianyu:cid_1:buyer_1').thread_root_id, 'om_root_1');
  } finally {
    server.close();
  }
});

test('relay session 失效时会重新初始化 relay 并重试当前消息', async () => {
  const botmuxCalls = [];
  const config = {
    publicBaseUrl: 'http://proxy.local',
    topicWebhookUrl: 'http://topic.local/webhook',
    xianyuSendUrl: 'http://xianyu.local/send',
    xianyuSendToken: '',
    xianyuInboundToken: '',
    agentReplyToken: '',
    botmuxRelayMention: 'ou_relay:用户的嘴替',
    botmuxTargetMention: 'ou_target_fallback:哈喽哈',
    botmuxTargetName: '哈喽哈',
    botmuxRelayLookupTimeoutMs: 50,
    botmuxRelayLookupIntervalMs: 1,
    requestTimeoutMs: 1000,
    sessionTtlMs: 60000,
    mockXianyuSend: false
  };

  const store = new SessionStore({ ttlMs: config.sessionTtlMs });
  store.setConversationSession('xianyu:cid_2:buyer_2', {
    target_session_id: 'target_session_2',
    relay_session_id: 'stale_relay',
    conversation_id: 'cid_2',
    buyer_id: 'buyer_2'
  });

  const app = createApp({
    config,
    store,
    postJson: async () => {
      throw new Error('不应重新走 webhook');
    },
    botmuxClient: {
      enabled: true,
      sendMention: async (input) => {
        botmuxCalls.push(input);
        if (botmuxCalls.length === 1) {
          throw new Error('session not found');
        }
        return {
          success: true,
          parsed: {
            success: true,
            target: {
              sessionId: 'target_session_2'
            }
          }
        };
      },
      waitForRelaySession: async () => ({
        sessionId: 'new_relay',
        rootMessageId: 'om_root_2',
        availableBots: [{
          name: '哈喽哈',
          openId: 'ou_target_from_relay_2',
          mention: 'ou_target_from_relay_2:哈喽哈'
        }]
      })
    }
  });

  const { server, baseUrl } = await listen(app);
  try {
    const result = await postJson(`${baseUrl}/xianyu/message`, {
      conversation_id: 'cid_2',
      buyer_id: 'buyer_2',
      buyer_name: '买家2',
      message_text: '旧 relay 失效后重建'
    });

    assert.equal(result.status, 202);
    assert.equal(result.body.status, 'relay_queued');
    assert.equal(botmuxCalls.length, 3);
    assert.equal(botmuxCalls[0].sessionId, 'stale_relay');
    assert.equal(botmuxCalls[0].mention, config.botmuxTargetMention);
    assert.equal(botmuxCalls[1].sessionId, 'target_session_2');
    assert.equal(botmuxCalls[1].mention, config.botmuxRelayMention);
    assert.equal(botmuxCalls[2].sessionId, 'new_relay');
    assert.equal(botmuxCalls[2].mention, 'ou_target_from_relay_2:哈喽哈');
    assert.equal(result.body.relay_session_id, 'new_relay');
    assert.equal(result.body.relay_retried, true);
    assert.equal(store.getConversationSession('xianyu:cid_2:buyer_2').relay_session_id, 'new_relay');
  } finally {
    server.close();
  }
});

test('未启用 relay 时，后续消息仍回退到 webhook', async () => {
  const webhookCalls = [];
  const config = {
    publicBaseUrl: 'http://proxy.local',
    topicWebhookUrl: 'http://topic.local/webhook',
    xianyuSendUrl: 'http://xianyu.local/send',
    xianyuSendToken: '',
    xianyuInboundToken: '',
    agentReplyToken: '',
    botmuxRelayMention: 'ou_relay:用户的嘴替',
    botmuxTargetMention: 'ou_target:哈喽哈',
    requestTimeoutMs: 1000,
    sessionTtlMs: 60000,
    mockXianyuSend: false
  };

  const store = new SessionStore({ ttlMs: config.sessionTtlMs });
  store.setConversationSession('xianyu:cid_3:buyer_3', {
    target_session_id: 'target_session_3',
    relay_session_id: 'relay_session_3',
    conversation_id: 'cid_3',
    buyer_id: 'buyer_3'
  });

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
            sessionId: 'target_session_3'
          }
        }
      };
    }
  });

  const { server, baseUrl } = await listen(app);
  try {
    const result = await postJson(`${baseUrl}/xianyu/message`, {
      conversation_id: 'cid_3',
      buyer_id: 'buyer_3',
      buyer_name: '买家3',
      message_text: '未启用 relay 时回退 webhook'
    });

    assert.equal(result.status, 202);
    assert.equal(webhookCalls.length, 1);
    assert.equal(result.body.status, 'queued');
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
