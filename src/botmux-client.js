import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function parseJsonOutput(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseAvailableBots(text) {
  const bots = [];
  const pattern = /<bot name="([^"]+)" open_id="([^"]+)"\s*\/>/g;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    bots.push({
      name: match[1],
      openId: match[2],
      mention: `${match[2]}:${match[1]}`
    });
  }

  return bots;
}

function sessionSearchText(session) {
  return [
    session?.title,
    session?.currentTurnTitle,
    session?.lastUserPrompt,
    session?.lastCliInput
  ].filter(Boolean).join('\n');
}

function normalizeSessionRecord(id, session, searchableText = sessionSearchText(session)) {
  return {
    sessionId: String(session?.sessionId || id),
    rootMessageId: session?.rootMessageId || '',
    chatId: session?.chatId || '',
    title: session?.title || '',
    createdAt: session?.createdAt || '',
    lastMessageAt: session?.lastMessageAt || '',
    agentFrozen: Boolean(session?.agentFrozen),
    availableBots: parseAvailableBots(searchableText)
  };
}

export class BotmuxClient {
  constructor({
    command = 'botmux',
    timeoutMs = 15000,
    relaySessionsPath = '',
    targetSessionsPath = '',
    env = process.env,
    execFileImpl = execFileAsync
  } = {}) {
    this.command = command;
    this.timeoutMs = timeoutMs;
    this.relaySessionsPath = relaySessionsPath;
    this.targetSessionsPath = targetSessionsPath;
    this.env = env;
    this.execFile = execFileImpl;
  }

  get enabled() {
    return Boolean(this.command);
  }

  async sendMention({ sessionId, mention, message }) {
    if (!sessionId) {
      throw new Error('缺少 botmux sessionId');
    }
    if (!mention) {
      throw new Error('缺少 botmux mention');
    }

    try {
      const { stdout = '', stderr = '' } = await this.execFile(
        this.command,
        [
          'send',
          '--session-id', sessionId,
          '--mention', mention,
          message
        ],
        {
          encoding: 'utf8',
          timeout: this.timeoutMs,
          maxBuffer: 1024 * 1024,
          env: this.env
        }
      );
      return this.normalizeResult(stdout, stderr);
    } catch (error) {
      const stdout = error.stdout || '';
      const stderr = error.stderr || '';
      const parsed = parseJsonOutput(stdout);
      error.botmux = {
        stdout,
        stderr,
        parsed
      };
      throw error;
    }
  }

  normalizeResult(stdout, stderr) {
    const parsed = parseJsonOutput(stdout);
    if (parsed && parsed.success === false) {
      throw new Error(`botmux send 失败：${stdout}\n${stderr}`);
    }

    return {
      success: true,
      stdout,
      stderr,
      parsed
    };
  }

  async readSessionFile(sessionsPath) {
    let data;
    try {
      const raw = await readFile(sessionsPath, 'utf8');
      data = JSON.parse(raw);
    } catch {
      return null;
    }

    return data && typeof data === 'object' ? data : null;
  }

  async findSessionInFile({
    sessionsPath,
    conversationKey,
    excludeSessionIds = [],
    notBeforeMs = 0
  }) {
    if (!sessionsPath || !conversationKey) return null;

    const data = await this.readSessionFile(sessionsPath);
    if (!data) return null;

    const excluded = new Set(excludeSessionIds.filter(Boolean).map(String));
    const marker = `conversation_key: ${conversationKey}`;
    const matches = Object.entries(data)
      .map(([id, session]) => ({
        id,
        session,
        sessionId: String(session?.sessionId || id),
        searchableText: sessionSearchText(session)
      }))
      .filter(({ session, sessionId, searchableText }) => {
        if (!session || excluded.has(sessionId)) return false;
        if (notBeforeMs && sessionTime(session) < notBeforeMs) return false;
        return searchableText.includes(marker);
      })
      .sort((a, b) => sessionTime(b.session) - sessionTime(a.session));

    const found = matches[0];
    if (!found) return null;

    return normalizeSessionRecord(found.id, found.session, found.searchableText);
  }

  async findSessionById({ sessionsPath, sessionId }) {
    if (!sessionsPath || !sessionId) return null;

    const data = await this.readSessionFile(sessionsPath);
    if (!data) return null;

    const expected = String(sessionId);
    const match = Object.entries(data).find(([id, session]) => {
      return String(id) === expected || String(session?.sessionId || '') === expected;
    });
    if (!match) return null;

    const [id, session] = match;
    return normalizeSessionRecord(id, session);
  }

  async findRelaySession({ conversationKey, excludeSessionIds = [], notBeforeMs = 0 }) {
    return this.findSessionInFile({
      sessionsPath: this.relaySessionsPath,
      conversationKey,
      excludeSessionIds,
      notBeforeMs
    });
  }

  async findTargetSession({ conversationKey, excludeSessionIds = [], notBeforeMs = 0 }) {
    return this.findSessionInFile({
      sessionsPath: this.targetSessionsPath,
      conversationKey,
      excludeSessionIds,
      notBeforeMs
    });
  }

  async findTargetSessionById(sessionId) {
    return this.findSessionById({
      sessionsPath: this.targetSessionsPath,
      sessionId
    });
  }

  async waitForRelaySession({
    conversationKey,
    excludeSessionIds = [],
    notBeforeMs = 0,
    timeoutMs = 5000,
    intervalMs = 250
  }) {
    return this.waitForSession({
      find: () => this.findRelaySession({ conversationKey, excludeSessionIds, notBeforeMs }),
      timeoutMs,
      intervalMs
    });
  }

  async waitForTargetSession({
    conversationKey,
    excludeSessionIds = [],
    notBeforeMs = 0,
    timeoutMs = 5000,
    intervalMs = 250
  }) {
    return this.waitForSession({
      find: () => this.findTargetSession({ conversationKey, excludeSessionIds, notBeforeMs }),
      timeoutMs,
      intervalMs
    });
  }

  async waitForSession({ find, timeoutMs = 5000, intervalMs = 250 }) {
    const startedAt = Date.now();

    do {
      const found = await find();
      if (found) return found;

      if (Date.now() - startedAt >= timeoutMs) break;
      await delay(Math.max(intervalMs, 1));
    } while (true);

    return null;
  }
}

function sessionTime(session) {
  return Date.parse(session?.lastMessageAt || session?.updatedAt || session?.createdAt || '') || 0;
}
