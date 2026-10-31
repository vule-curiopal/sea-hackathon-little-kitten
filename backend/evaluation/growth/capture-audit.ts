import { classifyLocal } from '../../pipeline/observations.js';
import { validateCandidate } from '../../memory/evidence.js';
import type { ReferenceSession } from '../../memory/import-history.js';
import type { Language, MemoryCandidate, Observation } from '../../shared/types.js';

interface Counts { userMessages: number; proposedCandidates: number; acceptedCandidates: number; rejectedCandidates: number }
interface CandidateEvidence {
  sourceId: string; sessionId: string; localDate: string; fixtureLanguage: string;
  text: string; intent: Observation['intent']; candidate: MemoryCandidate;
}
interface IntentEvidence { sourceId: string; date: string; text: string; intent: Observation['intent'] }
const empty = (): Counts => ({ userMessages: 0, proposedCandidates: 0, acceptedCandidates: 0, rejectedCandidates: 0 });
const increment = (counts: Record<string, number>, key: string) => { counts[key] = (counts[key] ?? 0) + 1; };

/** Parser diagnostics only. Independent expectations must never be derived from these outputs. */
export function auditCapture(sessions: readonly ReferenceSession[]) {
  const acceptedCandidates: CandidateEvidence[] = []; const rejectedCandidates: CandidateEvidence[] = [];
  const intentDistribution: Record<string, number> = {};
  const proposedByKind: Record<string, number> = {}; const acceptedByKind: Record<string, number> = {}; const rejectedByKind: Record<string, number> = {};
  const byMonth: Record<string, Counts> = {}; const byFixtureLanguage: Record<string, Counts> = {};
  const intentExamples: Record<'story' | 'stop' | 'forget' | 'stopCueReview' | 'forgetCueReview', IntentEvidence[]> = { story: [], stop: [], forget: [], stopCueReview: [], forgetCueReview: [] };
  let userMessages = 0; let ignoredAssistantMessages = 0; let messagesWithCandidates = 0; let suppressedMessages = 0; let uncertainMessages = 0;
  for (const session of sessions) {
    let language: Language = 'en';
    for (const message of session.messages) {
      if (message.role !== 'user') { ignoredAssistantMessages++; continue; }
      const observation = classifyLocal(message.content, language); language = observation.language;
      userMessages++;
      if (observation.candidates.length) messagesWithCandidates++;
      if (observation.suppressLearning) suppressedMessages++;
      if (observation.uncertain) uncertainMessages++;
      increment(intentDistribution, observation.intent);
      const monthly = byMonth[session.local_date.slice(0, 7)] ??= empty();
      const languageCounts = byFixtureLanguage[session.language] ??= empty();
      for (const counts of [monthly, languageCounts]) counts.userMessages++;
      for (const candidate of observation.candidates) {
        const accepted = validateCandidate(candidate);
        const kind = candidate.kind === 'preference' ? `preference:${candidate.category}` : candidate.kind;
        increment(proposedByKind, kind); increment(accepted ? acceptedByKind : rejectedByKind, kind);
        const evidence = { sourceId: message.id, sessionId: session.session_id, localDate: session.local_date, fixtureLanguage: session.language, text: message.content, intent: observation.intent, candidate };
        (accepted ? acceptedCandidates : rejectedCandidates).push(evidence);
        for (const counts of [monthly, languageCounts]) { counts.proposedCandidates++; counts[accepted ? 'acceptedCandidates' : 'rejectedCandidates']++; }
      }
      const evidence = { sourceId: message.id, date: session.local_date, text: message.content, intent: observation.intent };
      if (observation.intent === 'story' || observation.intent === 'continue_story') intentExamples.story.push(evidence);
      if (observation.intent === 'stop') intentExamples.stop.push(evidence);
      if (observation.intent === 'forget') intentExamples.forget.push(evidence);
      // These literal cues are review candidates, not automatic intended-intent labels.
      if (/\b(?:stop|goodbye)\b|dừng|nghỉ|thôi nhé|không chơi nữa/iu.test(message.content)) intentExamples.stopCueReview.push(evidence);
      if (/\b(?:forget|delete|erase)\b|xóa|quên|đừng (?:nhớ|lưu|nhắc)/iu.test(message.content)) intentExamples.forgetCueReview.push(evidence);
    }
  }
  return {
    diagnosticOnly: true as const,
    method: 'Source child words → current local classifier → memory evidence validator. No application delivery or database writes.',
    summary: { sessions: sessions.length, userMessages, ignoredAssistantMessages, messagesWithCandidates,
      proposedCandidates: acceptedCandidates.length + rejectedCandidates.length, acceptedCandidates: acceptedCandidates.length, rejectedCandidates: rejectedCandidates.length,
      suppressedMessages, uncertainMessages },
    intentDistribution, proposedByKind, acceptedByKind, rejectedByKind, byMonth, byFixtureLanguage,
    acceptedCandidates, rejectedCandidates, intentExamples,
    limitations: [
      'Counts are candidate diagnostics, not storage counts, memory accuracy, or a target for how many facts should be collected.',
      'Fixture language labels describe sessions; mixed sessions contain both languages.',
      'Lexical stop/delete cues are review prompts and do not by themselves establish an intended operation.',
      'Only the independent source-anchored expectation catalog supplies expected behavior.',
    ],
  };
}
