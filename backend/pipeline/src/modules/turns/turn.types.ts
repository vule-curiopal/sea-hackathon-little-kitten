/** Application input: no HTTP framework or multipart objects cross into TurnService. */
export interface IncomingAudio {
  bytes: Buffer;
  mimeType: string;
  filename: string;
}

export interface TurnSubmission {
  requestId: string;
  kind: 'utterance' | 'greeting';
  languageHint?: string;
  fixtureId?: string;
  audio?: IncomingAudio;
  text?: string;
  textOnly?: boolean;
  /** Internal only: authenticated realtime input reservation, never read from request JSON. */
  reservationId?: string;
  inputSource?: 'realtime_stt';
}
