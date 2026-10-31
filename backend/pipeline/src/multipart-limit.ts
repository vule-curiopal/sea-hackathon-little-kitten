import type { Express, Request, RequestHandler } from 'express';
import { LIMITS } from '@miu/voice-contracts';
import { PipelineError } from './errors.js';

interface Meter { received: number; rejection?: PipelineError }
const meters = new WeakMap<Request, Meter>();

export function getMultipartLimitError(request: Request): PipelineError | undefined {
  return meters.get(request)?.rejection;
}
export function getMultipartReceivedLength(request: Request): number | undefined {
  return meters.get(request)?.received;
}

/** Count original wire bytes, including ignored multipart preamble and epilogue.
 * prependListener does not start flow, so auth can finish before Multer attaches.
 */
export function createMultipartLimitMiddleware(limit = LIMITS.requestBytes): RequestHandler {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Multipart request limit must be a positive integer');
  return (request, response, next) => {
    const mediaType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
    if (mediaType !== 'multipart/form-data') return next();
    const meter: Meter = { received: 0 };
    meters.set(request, meter);
    const closeAfterReply = () => {
      response.setHeader('Connection', 'close');
      // Let node:http finish and close its response socket gracefully. Destroying
      // the IncomingMessage on `finish` can reset a chunked client's connection
      // before it receives the 413 body (especially with unread upload bytes).
    };
    const length = request.headers['content-length'];
    if (length !== undefined && (!/^\d+$/.test(length) || BigInt(length) > BigInt(limit))) {
      const numeric = /^\d+$/.test(length);
      meter.rejection = new PipelineError(numeric ? 'recording_too_large' : 'invalid_request', numeric ? 413 : 400);
      closeAfterReply();
      return next(meter.rejection);
    }
    const reject = (error: PipelineError) => {
      if (meter.rejection) return;
      meter.rejection = error;
      request.unpipe();
      // Drain already-in-flight chunks without buffering them before closing the
      // connection. Closing while a chunked sender is still writing can cause a
      // TCP reset that hides the 413 body. Bound this grace period for a sender
      // that never completes its request.
      let forwarded = false;
      let grace: ReturnType<typeof setTimeout>;
      const forward = () => {
        if (forwarded) return;
        forwarded = true;
        clearTimeout(grace);
        request.removeListener('end', forward);
        request.removeListener('close', forward);
        if (!response.headersSent && !response.destroyed) {
          closeAfterReply();
          next(error);
        }
      };
      grace = setTimeout(forward, 250);
      grace.unref();
      request.once('end', forward);
      request.once('close', forward);
      // Multer uses request errors to release Busboy/file streams. Our error
      // listener stays until close, so this is safe even before a parser attaches.
      request.emit('error', error);
      request.resume();
    };
    const onData = (chunk: Buffer | Uint8Array | string) => {
      if (meter.rejection) return;
      meter.received += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength;
      if (meter.received > limit) reject(new PipelineError('recording_too_large', 413));
    };
    const onError = () => {
      if (meter.rejection || response.headersSent || response.destroyed) return;
      // Do not re-emit an existing transport error and recurse into parser cleanup.
      meter.rejection = new PipelineError('invalid_request', 400);
      closeAfterReply();
      next(meter.rejection);
    };
    const cleanup = () => {
      request.removeListener('data', onData);
      request.removeListener('error', onError);
      request.removeListener('close', cleanup);
    };
    request.prependListener('data', onData);
    request.on('error', onError);
    request.once('close', cleanup);
    next();
  };
}

export function registerMultipartLimit(app: Express, limit = LIMITS.requestBytes): void {
  app.use(createMultipartLimitMiddleware(limit));
}
