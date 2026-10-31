import type { NextFunction, Request, Response } from 'express';
import type { PlaybackReceipt } from '@miu/voice-contracts';
import { PipelineError } from '../../errors.js';
import type { RequestContexts } from '../../http/error-handler.js';
import { readTurnSubmission } from '../../http/multipart.js';
import { bearerToken, identifier, object } from '../../http/request.js';
import type { SessionService } from '../sessions/session.service.js';
import type { Session } from '../sessions/session.types.js';
import type { TurnService } from './turn.service.js';

/** HTTP authentication, transport lifetime and mapping into the application service. */
export class TurnController {
  private readonly authenticatedSessions = new WeakMap<Request, Session>();

  constructor(
    private readonly sessions: SessionService,
    private readonly turns: TurnService,
    private readonly contexts: RequestContexts,
  ) {}

  private session(request: Request): Session {
    return this.sessions.session(identifier(object(request.params).session_id), bearerToken(request));
  }

  /** Authenticate before Multer consumes/buffers an upload. */
  readonly authorize = (request: Request, _response: Response, next: NextFunction) => {
    const session = this.session(request);
    this.authenticatedSessions.set(request, session);
    this.contexts.set(request, { language: session.profile.configuration.language_mode });
    next();
  };

  readonly submit = async (request: Request, response: Response) => {
    const session = this.authenticatedSessions.get(request) ?? this.session(request);
    const language = session.profile.configuration.language_mode;
    this.contexts.set(request, { language });
    const transport = new AbortController();
    const onDisconnect = () => transport.abort();
    const onClose = () => { if (!response.writableEnded) transport.abort(); };
    request.once('aborted', onDisconnect);
    response.once('close', onClose);
    try {
      const input = await readTurnSubmission(request, transport.signal, turnId => {
        this.contexts.set(request, { language, turnId });
      });
      const result = await this.turns.execute(session, input, transport.signal);
      return response.json(result);
    } finally {
      request.removeListener('aborted', onDisconnect);
      response.removeListener('close', onClose);
      this.authenticatedSessions.delete(request);
    }
  };

  readonly cancel = async (request: Request, response: Response) => {
    const session = this.session(request);
    return response.json(this.turns.cancel(session, identifier(object(request.params).turn_id)));
  };

  readonly playback = async (request: Request, response: Response) => {
    const session = this.session(request);
    const id = identifier(object(request.params).turn_id);
    const body = object(request.body);
    const allowed = ['request_id', 'status', 'played_ms', 'state_version', 'client_audio_start_latency_ms', 'autoplay_blocked'];
    if (Object.keys(body).some(key => !allowed.includes(key))) throw new PipelineError('invalid_request', 400);
    const requestId = identifier(body.request_id);
    if (!['started', 'completed', 'interrupted'].includes(String(body.status))
      || !Number.isSafeInteger(body.played_ms) || Number(body.played_ms) < 0
      || !Number.isSafeInteger(body.state_version)) {
      throw new PipelineError('invalid_request', 400);
    }
    return response.json(this.turns.receipt(session, id, {
      request_id: requestId,
      status: body.status as PlaybackReceipt['status'],
      played_ms: body.played_ms as number,
      state_version: body.state_version as number,
    }));
  };
}
