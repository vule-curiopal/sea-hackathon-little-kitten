import type { Request } from 'express';
import { PipelineError } from '../errors.js';
import { uuid } from '../modules/sessions/session.utils.js';

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PipelineError('invalid_request', 400);
  }
  return value as Record<string, unknown>;
}

export function identifier(value: unknown): string {
  if (!uuid(value)) throw new PipelineError('invalid_request', 400);
  return value;
}

export function bearerToken(request: Request): string | undefined {
  const header = request.headers.authorization;
  return header?.startsWith('Bearer ') ? header.slice(7) : undefined;
}
