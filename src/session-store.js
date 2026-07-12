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
