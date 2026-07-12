import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { buildConversationKey } from './topic-payload.js';

function nowIso() {
  return new Date().toISOString();
}

export class SessionStore {
  constructor({ ttlMs, anchorStorePath = '' }) {
    this.ttlMs = ttlMs;
    this.anchorStorePath = anchorStorePath;
    this.sessions = new Map();
    this.threadAnchors = new Map();
    this.larkMessageIndex = new Map();
    this.loadThreadAnchors();
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
      reply_text: '',
      lark_message_ids: []
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

  recordLarkMessage(correlationId, larkMessageId) {
    const messageId = String(larkMessageId || '').trim();
    if (!messageId) return null;

    const session = this.get(correlationId);
    if (!session) return null;

    this.larkMessageIndex.set(messageId, correlationId);
    const existing = new Set(session.lark_message_ids || []);
    existing.add(messageId);
    return this.update(correlationId, {
      lark_message_ids: [...existing]
    });
  }

  getByLarkMessageId(larkMessageId) {
    const correlationId = this.larkMessageIndex.get(String(larkMessageId || '').trim());
    if (!correlationId) return null;
    return this.get(correlationId);
  }

  cleanupExpired() {
    const now = Date.now();
    for (const [correlationId, session] of this.sessions.entries()) {
      if (Date.parse(session.expires_at) <= now) {
        this.sessions.delete(correlationId);
      }
    }
    for (const [larkMessageId, correlationId] of this.larkMessageIndex.entries()) {
      if (!this.sessions.has(correlationId)) {
        this.larkMessageIndex.delete(larkMessageId);
      }
    }
  }

  getThreadAnchor(threadKey) {
    return this.threadAnchors.get(threadKey) || null;
  }

  setThreadAnchor(threadKey, patch) {
    const existing = this.threadAnchors.get(threadKey) || {};
    const now = nowIso();
    const anchor = {
      ...existing,
      ...patch,
      thread_key: threadKey,
      updated_at: now,
      created_at: existing.created_at || now
    };
    this.threadAnchors.set(threadKey, anchor);
    this.saveThreadAnchors();
    return anchor;
  }

  loadThreadAnchors() {
    if (!this.anchorStorePath || !existsSync(this.anchorStorePath)) return;

    try {
      const raw = readFileSync(this.anchorStorePath, 'utf8');
      const data = JSON.parse(raw);
      for (const anchor of data.anchors || []) {
        if (anchor.thread_key) {
          this.threadAnchors.set(anchor.thread_key, anchor);
        }
      }
    } catch {
      this.threadAnchors.clear();
    }
  }

  saveThreadAnchors() {
    if (!this.anchorStorePath) return;

    mkdirSync(dirname(this.anchorStorePath), { recursive: true });
    const data = {
      version: 1,
      anchors: [...this.threadAnchors.values()]
    };
    const tmpPath = `${this.anchorStorePath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(data, null, 2));
    renameSync(tmpPath, this.anchorStorePath);
  }
}
