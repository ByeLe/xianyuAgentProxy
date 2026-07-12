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

export class BotmuxClient {
  constructor({
    command = 'botmux',
    timeoutMs = 15000,
    relaySessionsPath = '',
    env = process.env,
    execFileImpl = execFileAsync
  } = {}) {
    this.command = command;
    this.timeoutMs = timeoutMs;
    this.relaySessionsPath = relaySessionsPath;
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

  async findRelaySession({ conversationKey, excludeSessionIds = [] }) {
    if (!this.relaySessionsPath || !conversationKey) return null;

    let data;
    try {
      const raw = await readFile(this.relaySessionsPath, 'utf8');
      data = JSON.parse(raw);
    } catch {
      return null;
    }

    const excluded = new Set(excludeSessionIds.filter(Boolean).map(String));
    const marker = `conversation_key: ${conversationKey}`;
    const matches = Object.entries(data)
      .map(([id, session]) => ({
        id,
        session,
        sessionId: String(session?.sessionId || id),
        searchableText: [
          session?.title,
          session?.currentTurnTitle,
          session?.lastUserPrompt,
          session?.lastCliInput
        ].filter(Boolean).join('\n')
      }))
      .filter(({ session, sessionId, searchableText }) => {
        if (!session || excluded.has(sessionId)) return false;
        return searchableText.includes(marker);
      })
      .sort((a, b) => sessionTime(b.session) - sessionTime(a.session));

    const found = matches[0];
    if (!found) return null;

    return {
      sessionId: found.sessionId,
      rootMessageId: found.session.rootMessageId || '',
      chatId: found.session.chatId || '',
      title: found.session.title || '',
      createdAt: found.session.createdAt || '',
      lastMessageAt: found.session.lastMessageAt || '',
      availableBots: parseAvailableBots(found.searchableText)
    };
  }

  async waitForRelaySession({
    conversationKey,
    excludeSessionIds = [],
    timeoutMs = 5000,
    intervalMs = 250
  }) {
    const startedAt = Date.now();

    do {
      const found = await this.findRelaySession({ conversationKey, excludeSessionIds });
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
