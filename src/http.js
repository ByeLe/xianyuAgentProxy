import { HttpError } from './errors.js';

export async function postJson(url, payload, { timeoutMs = 20000, headers = {} } = {}) {
  if (!url) {
    throw new HttpError(500, '目标 URL 未配置');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...headers
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    const text = await response.text();
    let body = text;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }

    if (!response.ok) {
      throw new HttpError(response.status, `POST ${url} 失败`, body);
    }

    return {
      status: response.status,
      body
    };
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new HttpError(504, `POST ${url} 超时`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
