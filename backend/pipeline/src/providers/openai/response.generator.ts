import OpenAI from 'openai';
import type { Language } from '@miu/voice-contracts';
import type { VoiceConfig } from '../../config.js';
import { PipelineError } from '../../errors.js';
import type { ResponseGenerator } from '../../ports.js';
import { isRecord, runStage } from '../helpers.js';
import { assertReplyInput, validateReplyText } from '../validation.js';

function parseReply(payload: unknown): string {
  if (!isRecord(payload) || payload.status !== 'completed' || payload.error != null
    || payload.incomplete_details != null || !Array.isArray(payload.output) || !payload.output.length) {
    throw new PipelineError('invalid_reply', 503);
  }
  const texts: string[] = [];
  for (const message of payload.output) {
    // Standard API reasoning metadata is not spoken or reused as conversation state.
    if (isRecord(message) && message.type === 'reasoning') continue;
    if (!isRecord(message) || message.type !== 'message' || message.role !== 'assistant'
      || message.status !== 'completed' || !Array.isArray(message.content) || !message.content.length) {
      throw new PipelineError('invalid_reply', 503);
    }
    for (const content of message.content) {
      if (!isRecord(content) || content.type !== 'output_text' || typeof content.text !== 'string') {
        throw new PipelineError('invalid_reply', 503);
      }
      texts.push(content.text);
    }
  }
  const text = texts.join(' ').trim();
  validateReplyText(text);
  return text;
}

function instructions(language: Language): string {
  return `You are Miu, an imaginary AI kitten talking gently with a young child. Reply only in ${language === 'vi' ? 'Vietnamese' : 'English'}. Use one to three short sentences and at most one question. Return only speakable words, without Markdown, stage directions, tags or tool calls. Be honest that you are an AI kitten when asked. Do not claim memories of previous turns or promise unsupported future actions. This request contains only the current turn.`;
}

/** Temporary stateless response engine, replaceable through the ResponseGenerator port. */
export function createOpenAiResponseGenerator(config: VoiceConfig, fetchImpl: typeof fetch): ResponseGenerator {
  if (!config.openaiApiKey) throw new PipelineError('provider_configuration', 503);
  const client = new OpenAI({
    apiKey: config.openaiApiKey,
    baseURL: config.openaiBaseUrl,
    maxRetries: 0,
    timeout: config.replyTimeoutMs,
    fetch: fetchImpl,
    logLevel: 'off',
  });
  return {
    generate: (input, parentSignal) => runStage(parentSignal, config.replyTimeoutMs, async signal => {
      assertReplyInput(input);
      const payload: unknown = await client.responses.create({
        model: config.replyModel,
        instructions: instructions(input.language),
        input: [{ role: 'user', content: [{ type: 'input_text', text: input.text || 'Say a short hello.' }] }],
        reasoning: { effort: 'none' },
        max_output_tokens: config.maxOutputTokens,
        store: false,
        stream: false,
        tools: [],
      }, { signal, maxRetries: 0, timeout: config.replyTimeoutMs });
      return { turnId: input.turnId, replyText: parseReply(payload), language: input.language };
    }),
  };
}
