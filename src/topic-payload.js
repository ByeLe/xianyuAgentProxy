export function buildConversationKey(session) {
  return `xianyu:${session.conversation_id}:${session.buyer_id}`;
}

function buildHumanText(session, replyUrl) {
  return [
    '【闲鱼买家消息】',
    'message_kind: xianyu.buyer_message',
    `correlation_id: ${session.correlation_id}`,
    `conversation_key: ${session.thread_key || buildConversationKey(session)}`,
    `买家昵称: ${session.buyer_name || '未知'}`,
    `买家 ID: ${session.buyer_id}`,
    `闲鱼会话 ID: ${session.conversation_id}`,
    session.item_id ? `商品 ID: ${session.item_id}` : '',
    '',
    '买家原文：',
    session.message_text,
    '',
    `apiproxy_reply_url: ${replyUrl}`
  ].filter(Boolean).join('\n');
}

function buildBootstrapText(session, replyUrl) {
  return [
    '【闲鱼会话初始化】',
    'message_kind: xianyu.thread_bootstrap',
    `conversation_key: ${session.thread_key || buildConversationKey(session)}`,
    `买家昵称: ${session.buyer_name || '未知'}`,
    `买家 ID: ${session.buyer_id}`,
    `闲鱼会话 ID: ${session.conversation_id}`,
    session.item_id ? `商品 ID: ${session.item_id}` : '',
    '',
    '这条消息只用于创建和定位飞书话题，不代表买家发言。',
    '不要回写闲鱼，也不要回复买家。',
    '后续所有买家消息都会由 apiproxy 通过飞书 API 发送到本话题。',
    '',
    `apiproxy_reply_url: ${replyUrl}`
  ].filter(Boolean).join('\n');
}

export function buildTopicPayload(session, config) {
  const replyUrl = `${config.publicBaseUrl}/agent/reply`;
  const conversationKey = session.thread_key || buildConversationKey(session);

  return {
    source: 'xianyu',
    type: 'xianyu.message',
    correlation_id: session.correlation_id,
    conversation_key: conversationKey,
    thread_key: conversationKey,
    conversation_id: session.conversation_id,
    buyer_id: session.buyer_id,
    buyer_name: session.buyer_name,
    message_text: session.message_text,
    item_id: session.item_id,
    apiproxy_reply_url: replyUrl,
    apiproxy_reply_token: config.agentReplyToken || undefined,
    text: buildHumanText({ ...session, thread_key: conversationKey }, replyUrl)
  };
}

export function buildTopicBootstrapPayload(session, config) {
  const replyUrl = `${config.publicBaseUrl}/agent/reply`;
  const conversationKey = session.thread_key || buildConversationKey(session);

  return {
    source: 'xianyu',
    type: 'xianyu.thread_bootstrap',
    bootstrap_only: true,
    correlation_id: '',
    conversation_key: conversationKey,
    thread_key: conversationKey,
    conversation_id: session.conversation_id,
    buyer_id: session.buyer_id,
    buyer_name: session.buyer_name,
    message_text: '',
    item_id: session.item_id,
    apiproxy_reply_url: replyUrl,
    apiproxy_reply_token: config.agentReplyToken || undefined,
    text: buildBootstrapText({ ...session, thread_key: conversationKey }, replyUrl)
  };
}
