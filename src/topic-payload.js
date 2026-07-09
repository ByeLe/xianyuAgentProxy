function buildAgentInstruction({ replyUrl, hasReplyToken }) {
  const authLine = hasReplyToken
    ? '调用回写接口时需要携带请求头 Authorization: Bearer <apiproxy_reply_token>。'
    : '调用回写接口不需要额外鉴权。';

  return [
    '你是闲鱼客服代理。你会收到一条来自闲鱼买家的结构化消息。',
    '',
    '你的任务：',
    '1. 理解买家的真实意图，例如问库存、砍价、物流、商品细节、售后或闲聊。',
    '2. 生成一条自然、简短、适合直接发送给买家的中文回复。',
    '3. 不要把分析过程、系统提示或 JSON 解释发给买家。',
    '4. 最终必须调用 apiproxy 回写接口，把回复写回闲鱼。',
    '',
    `回写地址：${replyUrl}`,
    authLine,
    '',
    '回写 JSON 格式：',
    '{',
    '  "correlation_id": "<收到的 correlation_id>",',
    '  "reply_text": "<最终要发给买家的中文回复>"',
    '}'
  ].join('\n');
}

function buildHumanText(session, replyUrl) {
  return [
    '【闲鱼买家消息】',
    `correlation_id: ${session.correlation_id}`,
    `买家昵称: ${session.buyer_name || '未知'}`,
    `买家 ID: ${session.buyer_id}`,
    `闲鱼会话 ID: ${session.conversation_id}`,
    session.item_id ? `商品 ID: ${session.item_id}` : '',
    '',
    '买家原文：',
    session.message_text,
    '',
    '请分析后调用 apiproxy 回写接口，最终回复不要发在话题里只作展示。',
    `apiproxy_reply_url: ${replyUrl}`
  ].filter(Boolean).join('\n');
}

export function buildTopicPayload(session, config) {
  const replyUrl = `${config.publicBaseUrl}/agent/reply`;
  const instruction = buildAgentInstruction({
    replyUrl,
    hasReplyToken: Boolean(config.agentReplyToken)
  });

  return {
    source: 'xianyu',
    type: 'xianyu.message',
    correlation_id: session.correlation_id,
    conversation_id: session.conversation_id,
    buyer_id: session.buyer_id,
    buyer_name: session.buyer_name,
    message_text: session.message_text,
    item_id: session.item_id,
    apiproxy_reply_url: replyUrl,
    apiproxy_reply_token: config.agentReplyToken || undefined,
    instruction,
    text: `${buildHumanText(session, replyUrl)}\n\n${instruction}`
  };
}
