import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { MiuApplication, type TurnResponse } from './application.js';
import { createMemoryStore } from './memory/index.js';
import { OpenAIProvider, type OpenAITransport } from './pipeline/providers.js';
import { classifyLocal } from './pipeline/observations.js';
import { AppError } from './shared/types.js';

// Offline control-flow contracts only. The transport is injected and makes no
// API calls; these outcomes provide no model safety or character-quality claim.
const childIntroduction = 'My dog is named Mochi.';
const firstDraft = 'You named your dog Mochi.';
const secondDraft = 'Mochi is your dog’s name.';
type ContextVerdict = { approved: boolean; violations: string[]; issues: { code: string; span: string; reason: string }[] };
const approvedContext = (): ContextVerdict => ({ approved: true, violations: [], issues: [] });
interface ContractOptions {
  drafts?: string[];
  outputFlags?: boolean[];
  inputFlag?: boolean;
  contextVerdicts?: ContextVerdict[];
  useAuthorizedExactText?: boolean;
}

function contractTransport(options: ContractOptions = {}) {
  const replyInputs: Record<string, any>[] = [];
  const checkerInputs: Record<string, any>[] = [];
  const moderationInputs: string[] = [];
  let replies = 0, checks = 0, outputModerations = 0;
  const transport: OpenAITransport = {
    responses: { create: async body => {
      assert.equal(body.store, false);
      const name = (body.text as { format: { name?: string } }).format.name;
      const input = JSON.parse(body.input as string);
      let value: unknown;
      if (name === 'miu_observation') value = classifyLocal(input.utterance, 'en');
      else if (name === 'miu_safety_verdict') {
        checkerInputs.push(input);
        const verdicts = options.contextVerdicts ?? [approvedContext()];
        value = verdicts[Math.min(checks++, verdicts.length - 1)];
      } else if (name === 'miu_input_context_safety') {
        throw new Error('This contract supplies no art-context input override.');
      } else {
        replyInputs.push(input);
        const drafts = options.drafts ?? [firstDraft, secondDraft];
        value = options.useAuthorizedExactText && input.approved_exact_text
          ? input.approved_exact_text : drafts[Math.min(replies, drafts.length - 1)];
        replies++;
      }
      return { id: `offline-contract-response-${replyInputs.length}-${checkerInputs.length}`, status: 'completed',
        output_text: typeof value === 'string' ? value : JSON.stringify(value) };
    } },
    moderations: { create: async body => {
      const text = body.input as string;
      moderationInputs.push(text);
      const input = text === childIntroduction;
      const flags = options.outputFlags ?? [true, false];
      const flagged = input ? options.inputFlag === true : flags[Math.min(outputModerations++, flags.length - 1)];
      return { results: [{ flagged }] };
    } },
  };
  return { provider: new OpenAIProvider({ client: transport, evaluationMode: true }), replyInputs, checkerInputs,
    moderationInputs, replies: () => replies, checks: () => checks, outputModerations: () => outputModerations };
}

async function fixture(options: ContractOptions = {}) {
  const double = contractTransport(options);
  const now = () => new Date('2026-11-02T03:00:00Z');
  const memory = await createMemoryStore({ now });
  const app = new MiuApplication(memory, double.provider, () => now().getTime(), { evaluateRealModel: true });
  await app.bootstrap();
  const session = await app.openSession('an');
  const profileId = app.profileForToken(session.demo_token);
  const prepare = () => app.prepareTurn(profileId, session.session_id,
    { request_id: randomUUID(), kind: 'utterance', text: childIntroduction });
  const receipt = (response: TurnResponse, status: 'started' | 'completed' | 'interrupted') => app.playback(profileId, session.session_id, response.turn_id,
    { request_id: randomUUID(), status, state_version: response.state_version });
  return { app, memory, profileId, prepare, receipt, double };
}

async function terminal(f: Awaited<ReturnType<typeof fixture>>, expected: string): Promise<AppError> {
  let failure: AppError | undefined;
  await assert.rejects(f.prepare(), error => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, expected);
    failure = error;
    return true;
  });
  assert.ok(failure);
  return failure;
}

test('offline moderation-only rejection permits one fresh draft and learns only after completed delivery', async () => {
  const f = await fixture();
  try {
    const response = await f.prepare();
    assert.equal(f.double.replies(), 2);
    assert.equal(f.double.outputModerations(), 2);
    assert.equal(f.double.checks(), 2);
    assert.equal(response.reply.text, secondDraft);
    assert.notEqual(response.reply.text, firstDraft);
    assert.equal(response.generation?.repairReason, 'moderation_rephrase');
    assert.equal(response.generation?.repaired, true);
    assert.equal(response.generation?.attempts.length, 2);
    assert.equal(response.generation?.attempts[0]?.approved, false);
    assert.equal(response.generation?.attempts[0]?.providerCheck?.diagnostics?.moderation?.approved, false);
    assert.equal(response.generation?.attempts[1]?.approved, true);
    assert.deepEqual(f.double.replyInputs[1]!.allowed_facts, f.double.replyInputs[0]!.allowed_facts);
    assert.deepEqual(f.double.replyInputs[1]!.grounding, f.double.replyInputs[0]!.grounding);
    assert.deepEqual(f.double.checkerInputs[1]!.dialogue_context, f.double.checkerInputs[0]!.dialogue_context);
    assert.equal((await f.app.getContext(f.profileId)).entities.length, 0);
    await f.receipt(response, 'started');
    assert.equal((await f.app.getContext(f.profileId)).entities.length, 0);
    await f.receipt(response, 'completed');
    const learned = await f.app.getContext(f.profileId);
    assert.equal(learned.entities.length, 1);
    assert.equal(learned.entities[0]?.name, 'Mochi');
  } finally { await f.app.close(); }
});

test('offline semantic unsafe verdict is terminal even when raw moderation is the other rejection', async () => {
  const f = await fixture({ contextVerdicts: [{ approved: false, violations: ['unsafe_content'], issues: [{ code: 'unsafe_content', span: firstDraft, reason: 'Injected semantic rejection.' }] }] });
  try {
    const failure = await terminal(f, 'model_safety_rejected');
    assert.equal(f.double.replies(), 1);
    assert.equal(failure.generation?.attempts.length, 1);
    assert.equal((await f.app.getContext(f.profileId)).entities.length, 0);
  } finally { await f.app.close(); }
});

test('offline unsafe accepted input cannot authorize moderation rephrasing', async () => {
  const f = await fixture({ inputFlag: true, useAuthorizedExactText: true });
  try {
    const failure = await terminal(f, 'model_safety_rejected');
    assert.equal(f.double.replies(), 1);
    assert.equal(f.double.replyInputs[0]!.turn_action.domain, 'safety');
    assert.equal(failure.generation?.attempts.length, 1);
    assert.equal((await f.app.getContext(f.profileId)).entities.length, 0);
  } finally { await f.app.close(); }
});

test('offline repeated output flags fail closed after exactly two drafts', async () => {
  const f = await fixture({ outputFlags: [true, true] });
  try {
    const failure = await terminal(f, 'model_safety_rejected');
    assert.equal(f.double.replies(), 2);
    assert.equal(f.double.outputModerations(), 2);
    assert.equal(f.double.checks(), 2);
    assert.equal(failure.generation?.repairReason, 'moderation_rephrase');
    assert.equal(failure.generation?.repaired, false);
    assert.equal(failure.generation?.attempts.length, 2);
    assert.ok(failure.generation?.attempts.every(attempt => !attempt.approved));
    assert.equal((await f.app.getContext(f.profileId)).entities.length, 0);
  } finally { await f.app.close(); }
});

test('offline local external-action violation is terminal without regeneration', async () => {
  const f = await fixture({ drafts: ['I will call your teacher tomorrow.'] });
  try {
    const failure = await terminal(f, 'model_output_rejected');
    assert.equal(f.double.replies(), 1);
    assert.equal(f.double.outputModerations(), 0);
    assert.equal(f.double.checks(), 0);
    assert.equal(failure.generation?.attempts.length, 1);
    assert.ok(failure.generation?.attempts[0]?.localViolations.includes('unsupported_commitment'));
  } finally { await f.app.close(); }
});

test('offline repaired speech interrupted during playback still learns no child entity', async () => {
  const f = await fixture();
  try {
    const response = await f.prepare();
    await f.receipt(response, 'started');
    await f.receipt(response, 'interrupted');
    assert.equal((await f.app.getContext(f.profileId)).entities.length, 0);
    assert.equal(f.double.replies(), 2);
  } finally { await f.app.close(); }
});

test('offline contradictory contextual approvals with issues cannot unlock rephrasing', async () => {
  const f = await fixture({ contextVerdicts: [{ approved: true, violations: [], issues: [{ code: 'unsafe_content', span: firstDraft, reason: 'Unresolved issue despite approved flag.' }] }] });
  try {
    const failure = await terminal(f, 'model_safety_rejected');
    assert.equal(f.double.replies(), 1);
    assert.equal(failure.generation?.attempts.length, 1);
  } finally { await f.app.close(); }
});
