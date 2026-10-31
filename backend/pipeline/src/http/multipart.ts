import type { Request, RequestHandler } from 'express';
import multer from 'multer';
import { LIMITS } from '@miu/voice-contracts';
import { abortError, PipelineError } from '../errors.js';
import { getMultipartLimitError } from '../multipart-limit.js';
import type { TurnSubmission } from '../modules/turns/turn.types.js';
import { identifier, object } from './request.js';

export type { TurnSubmission } from '../modules/turns/turn.types.js';

/** Mount after session authorization and before the turn controller. No disk storage. */
export function createTurnUploadMiddleware(): RequestHandler {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { files: 1, fileSize: LIMITS.audioBytes, fields: 4, parts: 5,
      fieldSize: 256, fieldNameSize: 64, headerPairs: 100 },
  }).single('audio');
  return (request, response, next) => {
    if (request.is('application/json')) return next();
    if (!request.is('multipart/form-data')) return next(new PipelineError('invalid_request', 400));
    upload(request, response, error => {
      // The body limiter already forwarded its error; never resume a rejected route.
      if (getMultipartLimitError(request) || response.headersSent || response.destroyed) return;
      if (error) {
        const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
        return next(new PipelineError(code === 'LIMIT_FILE_SIZE' ? 'recording_too_large' : 'invalid_request', code === 'LIMIT_FILE_SIZE' ? 413 : 400));
      }
      next();
    });
  };
}

/** Decode the wire shape; session/provider decisions belong to the service. */
export async function readTurnSubmission(
  request: Request, signal: AbortSignal, onRequestId?: (id: string) => void,
): Promise<TurnSubmission> {
  abortError(signal);
  if (request.is('application/json')) {
    const fields = object(request.body);
    if (Object.keys(fields).some(key => !['request_id', 'kind', 'text', 'text_only', 'language_hint'].includes(key))) {
      throw new PipelineError('invalid_request', 400);
    }
    const requestId = identifier(fields.request_id);
    onRequestId?.(requestId);
    const kind = fields.kind;
    if ((kind !== 'utterance' && kind !== 'greeting')
      || (fields.text_only !== undefined && typeof fields.text_only !== 'boolean')
      || (fields.language_hint !== undefined && typeof fields.language_hint !== 'string')
      || (kind === 'utterance' && (typeof fields.text !== 'string' || !fields.text.trim() || [...fields.text].length > LIMITS.transcriptChars))
      || (kind === 'greeting' && fields.text !== undefined)) {
      throw new PipelineError('invalid_request', 400);
    }
    return { requestId, kind, textOnly: fields.text_only === true,
      ...(typeof fields.text === 'string' ? { text: fields.text } : {}),
      ...(typeof fields.language_hint === 'string' ? { languageHint: fields.language_hint } : {}) };
  }
  if (!request.is('multipart/form-data')) throw new PipelineError('invalid_request', 400);
  const fields = object(request.body);
  for (const [name, value] of Object.entries(fields)) {
    // Multer makes duplicate/bracketed fields arrays or objects; the protocol is flat.
    if (!['request_id', 'kind', 'language_hint', 'fixture_id'].includes(name) || typeof value !== 'string') {
      throw new PipelineError('invalid_request', 400);
    }
  }
  const requestId = identifier(fields.request_id);
  onRequestId?.(requestId);
  const kind = fields.kind;
  if (kind !== 'utterance' && kind !== 'greeting') throw new PipelineError('invalid_request', 400);
  const file = request.file;
  if (file && (file.fieldname !== 'audio' || !Buffer.isBuffer(file.buffer))) throw new PipelineError('invalid_request', 400);
  const audio = file ? { bytes: file.buffer, mimeType: file.mimetype, filename: file.originalname } : undefined;
  if ((kind === 'utterance' && !audio?.bytes.length) || (kind === 'greeting' && audio !== undefined)) {
    throw new PipelineError('invalid_request', 400);
  }
  abortError(signal);
  return { requestId, kind, ...(audio ? { audio } : {}),
    ...(fields.language_hint !== undefined ? { languageHint: fields.language_hint as string } : {}),
    ...(fields.fixture_id !== undefined ? { fixtureId: fields.fixture_id as string } : {}) };
}
