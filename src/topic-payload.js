export function buildConversationKey(session) {
  return `xianyu:${session.conversation_id}:${session.buyer_id}`;
}

function buyerDisplayName(session) {
  const name = String(session.buyer_name || '').trim();
  if (name) return name;
  const buyerId = String(session.buyer_id || '').trim();
  return buyerId || '未知买家';
}

function buildHumanText(session) {
  return String(session.message_text || '');
}

function buildBootstrapText(session) {
  return buyerDisplayName(session);
}

export function buildTopicPayload(session, config) {
  const replyUrl = `${config.publicBaseUrl}/agent/reply`;
  const conversationKey = session.thread_key || buildConversationKey(session);
  const topicTitle = buyerDisplayName(session);

  return {
    source: 'xianyu',
    type: 'xianyu.message',
    title: topicTitle,
    topic_title: topicTitle,
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
    text: buildHumanText({ ...session, thread_key: conversationKey })
  };
}

export function buildTopicBootstrapPayload(session, config) {
  const replyUrl = `${config.publicBaseUrl}/agent/reply`;
  const conversationKey = session.thread_key || buildConversationKey(session);
  const topicTitle = buyerDisplayName(session);

  return {
    source: 'xianyu',
    type: 'xianyu.thread_bootstrap',
    bootstrap_only: true,
    title: topicTitle,
    topic_title: topicTitle,
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
    text: buildBootstrapText({ ...session, thread_key: conversationKey })
  };
}
