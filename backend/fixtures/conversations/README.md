# One year of Miu conversations

Synthetic testing data for **An**, a fictional Vietnamese child who turns seven on 14 May 2026, and **Miu**, the project's AI kitten. The history covers every day from **1 November 2025 through 31 October 2026**, in `Asia/Ho_Chi_Minh` time. It contains no real child records and requires no API key to regenerate.

Each day has one distinct authored conversation with four to six child/Miu exchanges. Most conversations are Vietnamese; others use English or switch languages within the conversation. Topics include meals, chores, school, family, friendship, Mochi the dog, games with actual turns and outcomes, nonsense, questions and answers, creative stories, tâm sự, boredom, conflict, bedtime, and changing moods. Some conversations end sad, frustrated, or tired.

## Files

| File | Contents |
| --- | --- |
| [generated/sessions.jsonl](generated/sessions.jsonl) | One JSON object per daily session, with complete messages and annotations. |
| [generated/messages.jsonl](generated/messages.jsonl) | One JSON object per message, in chronological order, with session/profile IDs and `user`/`assistant` roles. |
| [generated/manifest.json](generated/manifest.json) | Exact counts, language/topic/mood distributions, fictional persona, and limitations. |
| [generated/evaluation-cases.json](generated/evaluation-cases.json) | Behavior review cases anchored to message IDs, with relevant earlier sessions. These are evaluation prompts, not executed model checks. |
| [source/](source/) | Four editable files containing the authored dialogue. |

Each session includes `local_date`, `started_at`, `ended_at`, `language` (`vi`, `en`, or `mixed`), `tags`, `child_age_years`, `child_mood.start`, `child_mood.end`, `miu_daily_mood`, and `messages`. Message timestamps use an explicit `+07:00` offset. IDs, timestamps, and Miu's daily mood are deterministic. Child moods are author annotations; Miu's daily mood uses the project's `content`, `curious`, and `mellow` values and is independent of the child's mood.

Continuity includes Mochi's puddle and next-day bath report, plans that get canceled, corrected names, a birthday, a favorite color changing from green to turquoise, a withdrawn nickname, a school-year teacher change, an unfinished story resumed the next day, and requests for privacy or stopping. Later callbacks usually use a recent event or a detail the child has just reintroduced. Do not assume runtime memories persist for the full year.

## Generate and validate

From the repository root, using Node.js 22.18 or newer:

```sh
node backend/scripts/generate-conversation-history.mjs
node backend/scripts/generate-conversation-history.mjs --check
node --test backend/fixtures/conversations/history.test.mjs
```

An optional first argument chooses a different output directory. `--check` verifies the existing exports without writing them. Generation checks every expected date, unique session titles, unique conversation bodies, four to six complete pairs, supported moods/tags/languages, short Miu replies, and at most one question per reply. Export validation checks role order, ID uniqueness, increasing local timestamps, and the birthday age transition. The tests also check malformed data rejection, required topic coverage, evaluation anchors, and agreement between source and exported files.

## Use in tests

```js
import { readFile } from 'node:fs/promises';

const text = await readFile('backend/fixtures/conversations/generated/sessions.jsonl', 'utf8');
const sessions = text.trimEnd().split('\n').map(line => JSON.parse(line));

for (const session of sessions) {
  const history = session.messages.map(({ role, content }) => ({ role, content }));
  // Supply bounded context to your test harness, or inspect this reference history.
  console.log(session.local_date, history.length, session.child_mood);
}
```

For application replay, use a separate fictional test profile and the demo clock, submit each `user` message through the normal turn path, and inspect the newly generated reply. Advance dates through normal rollover and finalize playback/learning through the application's receipt flow. The fixture profile ID is a stable dataset identifier, not an authenticated application profile ID. Do not seed reference assistant replies as heard turns or treat them as generated application output.

The exported conversations are offline reference text. They do not prove that memory learning, deletion, state transitions, or safety checks ran. For privacy scenarios, an application test must verify the actual operation and receipt. The references deliberately avoid claiming deletion happened.

To store the complete generated year in the database, run `npm run db:import-history`, then `npm run db:verify-history`. The [backend import guide](../../README.md#import-the-generated-year-of-conversations) describes destination selection and duplicate handling. The archive uses dedicated synthetic-history tables and preserves authored-reference provenance. It does not insert assistant replies as heard runtime turns or bypass the memory service's retention and deletion rules.

This dataset covers one fictional child and one daily session, rather than a representative population or natural engagement frequency. It contains no audio, speech recognition artifacts, real provider outputs, or latency measurements. Mood labels are test annotations, not clinical assessments.
