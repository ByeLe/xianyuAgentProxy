import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

function defaultSessionsPath(appId) {
  if (!appId) return '';
  return join(process.env.HOME || '', '.botmux', 'data', `sessions-${appId}.json`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class BotmuxSessionReader {
  constructor({
    appId = '',
    sessionsPath = '',
    readFileImpl = readFile,
    retryDelayMs = 250,
    retries = 12
  } = {}) {
    this.sessionsPath = sessionsPath || defaultSessionsPath(appId);
    this.readFile = readFileImpl;
    this.retryDelayMs = retryDelayMs;
    this.retries = retries;
  }

  get enabled() {
    return Boolean(this.sessionsPath);
  }

  async getSession(sessionId) {
    if (!this.enabled || !sessionId) return null;

    try {
      const raw = await this.readFile(this.sessionsPath, 'utf8');
      const data = JSON.parse(raw);
      return data?.[sessionId] || null;
    } catch {
      return null;
    }
  }

  async waitForRootMessageId(sessionId) {
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      const session = await this.getSession(sessionId);
      const rootMessageId = session?.rootMessageId || session?.threadRootId || '';
      if (rootMessageId) {
        return {
          session,
          rootMessageId
        };
      }

      if (attempt < this.retries) {
        await sleep(this.retryDelayMs);
      }
    }

    return null;
  }
}
