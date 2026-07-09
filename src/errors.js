export class HttpError extends Error {
  constructor(status, message, details = undefined) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.details = details;
  }
}

export function assertHttp(condition, status, message, details = undefined) {
  if (!condition) {
    throw new HttpError(status, message, details);
  }
}
