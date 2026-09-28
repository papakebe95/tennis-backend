import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

// Facts about the HTTP request being handled, readable from anywhere below
// the middleware (the audit log uses them) without threading them through
// every call.
export interface RequestContext {
  requestId: string;
  ip: string | null;
  userAgent: string | null;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function currentRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

export function requestContextMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const incoming = req.headers['x-request-id'];
  const requestId =
    typeof incoming === 'string' && /^[\w-]{1,64}$/.test(incoming)
      ? incoming
      : randomUUID();
  res.setHeader('X-Request-Id', requestId);
  storage.run(
    {
      requestId,
      ip: req.ip ?? null,
      userAgent: req.headers['user-agent']?.slice(0, 256) ?? null,
    },
    next,
  );
}
