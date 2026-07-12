import { HttpError } from './errors.js';

function trimRightSlash(value) {
  return value.replace(/\/+$/, '');
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export class FeishuClient {
  constructor({
    appId,
    appSecret,
    baseUrl = 'https://open.feishu.cn',
    timeoutMs = 20000,
    mentionOpenId = '',
    mentionName = '',
    fetchImpl = fetch
  }) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.baseUrl = trimRightSlash(baseUrl);
    this.timeoutMs = timeoutMs;
    this.mentionOpenId = mentionOpenId;
    this.mentionName = mentionName || mentionOpenId;
    this.fetch = fetchImpl;
    this.cachedToken = null;
  }

  get enabled() {
    return Boolean(this.appId && this.appSecret);
  }

  async post(path, payload, headers = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...headers
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      const body = await readJsonResponse(response);
      if (!response.ok) {
        throw new HttpError(response.status, `POST ${path} 失败`, body);
      }
      if (body && typeof body === 'object' && body.code != null && body.code !== 0) {
        throw new HttpError(502, `飞书接口 ${path} 返回错误`, body);
      }
      return body;
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new HttpError(504, `POST ${path} 超时`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async getTenantAccessToken() {
    if (this.cachedToken && this.cachedToken.expiresAt > Date.now()) {
      return this.cachedToken.value;
    }

    const body = await this.post('/open-apis/auth/v3/tenant_access_token/internal', {
      app_id: this.appId,
      app_secret: this.appSecret
    });

    const token = body.tenant_access_token;
    if (!token) {
      throw new HttpError(502, '飞书 tenant_access_token 为空', body);
    }

    const expireSeconds = Number(body.expire) || 7200;
    this.cachedToken = {
      value: token,
      expiresAt: Date.now() + Math.max(60, expireSeconds - 120) * 1000
    };
    return token;
  }

  async replyMessage(messageId, text) {
    if (!this.enabled) {
      throw new HttpError(500, '飞书应用凭证未配置');
    }

    const token = await this.getTenantAccessToken();
    return this.post(`/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
      msg_type: 'text',
      content: JSON.stringify({ text: this.buildReplyText(text) }),
      reply_in_thread: true
    }, {
      authorization: `Bearer ${token}`
    });
  }

  buildReplyText(text) {
    if (!this.mentionOpenId) return text;
    return `<at user_id="${this.mentionOpenId}">${this.mentionName}</at>\n${text}`;
  }
}
