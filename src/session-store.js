import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { buildConversationKey } from './topic-payload.js';

function nowIso() {
  return new Date().toISOString();
}

export class SessionStore {
  constructor({ ttlMs, botmuxSessionStorePath = '' }) {
    this.ttlMs = ttlMs;
    this.botmuxSessionStorePath = botmuxSessionStorePath;
    this.sessions = new Map();
    this.conversationSessions = new Map();
    this.loadConversationSessions();
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

  getConversationSession(conversationKey) {
    return this.conversationSessions.get(conversationKey) || null;
  }

  setConversationSession(conversationKey, patch) {
    const existing = this.conversationSessions.get(conversationKey) || {};
    const now = nowIso();
    const conversationSession = {
      ...existing,
      ...patch,
      conversation_key: conversationKey,
      updated_at: now,
      created_at: existing.created_at || now
    };
    this.conversationSessions.set(conversationKey, conversationSession);
    this.saveConversationSessions();
    return conversationSession;
  }

  deleteConversationSession(conversationKey) {
    const deleted = this.conversationSessions.delete(conversationKey);
    if (deleted) this.saveConversationSessions();
    return deleted;
  }

  loadConversationSessions() {
    if (!this.botmuxSessionStorePath || !existsSync(this.botmuxSessionStorePath)) return;

    try {
      const raw = readFileSync(this.botmuxSessionStorePath, 'utf8');
      const data = JSON.parse(raw);
      for (const item of data.conversation_sessions || []) {
        if (item.conversation_key) {
          this.conversationSessions.set(item.conversation_key, item);
        }
      }
    } catch {
      this.conversationSessions.clear();
    }
  }

  saveConversationSessions() {
    if (!this.botmuxSessionStorePath) return;

    mkdirSync(dirname(this.botmuxSessionStorePath), { recursive: true });
    const data = {
      version: 1,
      conversation_sessions: [...this.conversationSessions.values()]
    };
    const tmpPath = `${this.botmuxSessionStorePath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(data, null, 2));
    renameSync(tmpPath, this.botmuxSessionStorePath);
  }
}
