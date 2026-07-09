import { assertHttp } from './errors.js';

function readBearer(ctx) {
  const value = ctx.get('authorization');
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : '';
}

export function requireOptionalBearer(expectedToken) {
  return async (ctx, next) => {
    if (!expectedToken) {
      await next();
      return;
    }

    const actualToken = readBearer(ctx) || ctx.get('x-apiproxy-token');
    assertHttp(actualToken === expectedToken, 401, '鉴权失败');
    await next();
  };
}
