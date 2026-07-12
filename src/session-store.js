import { randomUUID } from 'node:crypto';

import { buildConversationKey } from './topic-payload.js';

function nowIso() {
  return new Date().toISOString();
}

export class SessionStore {
  constructor({ ttlMs }) {
    this.ttlMs = ttlMs;
    this.sessions = new Map();
  }

  create(input) {
    this.cleanupExpired();

    const correlationId = input.correlation_id || `xy_${Date.now()}_${randomUUID()}`;
    const createdAt = nowIso();
    const expiresAt = new Date(Date.now() + this.ttlMs).toISOString();

    const session = {
      correlation_id: correlationId,
      status: 'pending',
      created_at: createdAt,
      updated_at: createdAt,
      expires_at: expiresAt,
      conversation_id: input.conversation_id,
      buyer_id: input.buyer_id,
      buyer_name: input.buyer_name || '',
      thread_key: buildConversationKey(input),
      message_text: input.message_text,
      item_id: input.item_id || '',
      raw: input.raw || null,
      topic_response: null,
      xianyu_response: null,
      reply_text: ''
    };

    this.sessions.set(correlationId, session);
    return session;
  }

  get(correlationId) {
    const session = this.sessions.get(correlationId);
    if (!session) return null;

    if (Date.parse(session.expires_at) <= Date.now()) {
      this.sessions.delete(correlationId);
      return null;
    }

    return session;
  }

  update(correlationId, patch) {
    const session = this.get(correlationId);
    if (!session) return null;

    const updated = {
      ...session,
      ...patch,
      updated_at: nowIso()
    };

    this.sessions.set(correlationId, updated);
    return updated;
  }

  cleanupExpired() {
    const now = Date.now();
    for (const [correlationId, session] of this.sessions.entries()) {
      if (Date.parse(session.expires_at) <= now) {
        this.sessions.delete(correlationId);
      }
    }
  }
}
