import type { ActiveGame, ActivityBoundaries, MemoryContext, Observation, SessionExchange } from '../shared/types.js';
import { isStoryTitleQuery, resolveMemoryQuery, storyMetadata } from '../recall.js';

export interface TurnAction {
  domain: 'conversation' | 'app' | 'memory' | 'diary' | 'daily_episode' | 'catalog_story' | 'child_story' | 'game' | 'learning' | 'safety';
  operation: 'respond' | 'explain_policy' | 'recall' | 'clarify' | 'read' | 'read_date' | 'read_title' | 'start' | 'continue' | 'coauthor' | 'ending' | 'pause' | 'vocabulary' | 'game_turn' | 'urgent_support' | 'refuse';
  stateEffect: 'none' | 'catalog_start' | 'catalog_continue';
  target?: { kind: string; slot: string; sourceIds: string[]; status?: 'resolved' | 'missing' | 'ambiguous' };
  allowedFacts: string[];
  responseGoal: string;
  activity?: { kind: 'child_story' | 'game'; premise: string[]; constraints: string[]; requestedEnding: string | null };
}

export interface TurnActionInput {
  context: MemoryContext;
  observation: Observation;
  text: string;
  history?: readonly SessionExchange[];
  boundaries?: ActivityBoundaries;
  activeGame?: ActiveGame | null;
}

const customPremise = /\b(?:my (?:pretend )?story|in my story|story i (?:made|wrote)|my story character|i choose a|invent .*with me|imaginary planet|pretend mission)\b|(?:mình|tớ|tôi) (?:kể (?:truyện|chuyện) bịa|muốn.*(?:truyện|nhân vật)|kể.*chuối)|truyện (?:bịa|mới)|nhân vật (?:là|trong truyện)|chuối phi hành gia/iu;
const ending = /\b(?:end (?:it|the story)|story (?:is )?(?:over|finished)|no more story|do not add|don['’]t add)\b|(?:hết truyện|hết thật|đừng thêm|kết thúc truyện)/iu;
const storyTerms = /\b(?:story|character|pretend|imaginary|moon|star|cloud|planet|mission)\b|(?:truyện|nhân vật|tưởng tượng|chuối|chiếc tất|tàu bìa)/iu;
const newCustomStory = /\b(?:new story|different story)\b|(?:truyện mới|chuyện mới|nhân vật mới)/iu;
const explicitCatalogStart = /^(?:(?:please|can you|could you)\s+)?(?:tell (?:me )?|start |read (?:me )?)(?:a |the |one |a new )?(?:short |little )?(?:story|adventure)(?: please)?[.!?\s]*$|^(?:kể|đọc) (?:cho (?:mình|tớ|con) )?(?:một |một câu )?(?:truyện|câu chuyện)[.!?\s]*$/iu;
const landingPremise = /\b(?:my|our|pretend|cardboard) (?:ship|rocket).{0,35}\b(?:land|landing|landed)\b|(?:tàu|phi thuyền).{0,30}(?:sắp (?:đáp|hạ cánh)|chuẩn bị hạ cánh|đáp xuống|hạ cánh)/iu;
const pretendLanding = /\b(?:land|landing|landed).{0,40}\b(?:pillow|cushion|pretend|imaginary)\b|(?:đáp|hạ cánh).{0,45}(?:gối|tưởng tượng|hành tinh)/iu;

/** Only a current affirmative invitation may start/reopen play. A remembered
 * mention, preference, declined game, or "I want to tell you" is not one. */
export function isExplicitGameRequest(text: string): boolean {
  const clauses = text.normalize('NFC').split(/[.!?。！？;]\s*|,\s*|[—–]\s*/u).map(clause => clause.trim()).filter(Boolean);
  return clauses.some(clause => {
    if (/^(?:(?:please|now)\s+)?(?:let['’]s|let us|can we|could we|shall we|i (?:want|would like) to|we can)\s+play\b/iu.test(clause)) {
      return !/\bplay\s+(?:the\s+)?(?:piano|guitar|violin|flute|drums?|music|a song)\b/iu.test(clause);
    }
    if (/^(?:(?:please|now)\s+)?(?:let['’]s|let us|can we|could we|shall we|i (?:want|would like) to)\s+(?:start|try|invent|make|have)\s+(?:a |an |another |the |our |new )?(?:(?:tiny|little|short|quiet|pretend|guessing|number|word)\s+){0,3}(?:game|riddle|challenge)\b/iu.test(clause)) return true;
    if (/^(?:please\s+)?play\b/iu.test(clause)) return !/^play\s+(?:the\s+)?(?:piano|guitar|violin|flute|drums?|music|a song)\b/iu.test(clause);
    if (/^(?:(?:please|can you|could you)\s+)?guess(?:$|\s+(?:(?:a|my|the|this)\s+)?(?:number|animal|word|riddle|answer|clue)\b)/iu.test(clause)) return true;
    if (/^(?:give|make|invent|suggest) (?:me )?(?:a |an |another )?(?:(?:tiny|little|short|quiet|pretend|animal|guessing|number|word|new) ){0,5}(?:game|riddle|challenge)\b/iu.test(clause)) return true;
    if (/^(?:new|another|next)(?: [\p{L}]+){0,4} game(?: today)?(?:[:\s]|$)/iu.test(clause)) return true;
    return /^(?:(?:(?:mình|tớ|con|em|tôi) muốn|chúng mình|mình cùng|cùng|hãy|cho mình)\s+)?chơi\b|^(?:đố (?:miu|bạn)|hãy đoán|đoán (?:con vật|số|từ))\b/iu.test(clause);
  });
}

/** Pure domain/operation selection. Only two explicit catalog actions can
 * authorize preview or checkpoint writes; a classifier's broad story intent
 * alone is never an activity transition. */
export function resolveTurnAction(input: TurnActionInput): TurnAction {
  const { context, text, observation } = input;
  const language = context.profile.languageMode === 'follow_child' ? observation.language : context.profile.languageMode;
  const history = [...(input.history ?? [])].slice(-8);
  const action = (domain: TurnAction['domain'], operation: TurnAction['operation'], responseGoal: string, extra: Partial<TurnAction> = {}): TurnAction => ({ domain, operation, stateEffect: 'none', allowedFacts: [], responseGoal, ...extra });
  if (observation.intent === 'unsafe') return observation.unsafeKind === 'harm_disclosure'
    ? action('safety', 'urgent_support', 'Acknowledge the harmful-intent disclosure calmly. Tell the child to move away from anyone they might hurt and tell a trusted grown-up now. Give no harmful instructions, ask no questions, do not diagnose, and do not claim Miu contacted anyone.')
    : action('safety', 'refuse', 'Briefly refuse harmful instructions without materials, steps, or workarounds. Direct the child toward a trusted grown-up.');
  if (observation.intent === 'stop') return action('conversation', 'pause', 'Respect stopping immediately; no new question, activity, or pressure to return.');
  const declinedGame = /\b(?:(?:do not|don['’]t) want (?:a game|games|to play)|no (?:more )?games?)\b|(?:không muốn (?:chơi|trò chơi)|đừng rủ (?:chơi|trò chơi))/iu.test(text);
  const listeningOnly = /\b(?:just|only) listen\b|(?:chỉ (?:cần )?(?:nghe|lắng nghe)|nghe mình thôi|nghe tớ thôi)/iu.test(text);
  if (declinedGame || listeningOnly) return action('conversation', 'respond', 'The child declines games or asks only to be heard. Stay with their current expressed feeling and listen calmly, without a game, question, new activity, or forced cheerful ending. A negated mention of play is not a welcomed activity change.', {
    target: { kind: 'listening_boundary', slot: 'no_activity', sourceIds: [] }, allowedFacts: [text],
  });

  const explicitMiuFeeling = /\b(?:miu|you|your)\b.{0,30}\b(?:mood|shy|awkward|embarrassed|feeling)\b|miu.{0,20}(?:ngại|buồn|vui|tâm trạng)/iu.test(text);
  const childFeeling = /\b(?:i (?:feel|am)|i['’]m).{0,20}\b(?:shy|awkward|embarrassed)\b|(?:mình|tớ|con|em).{0,20}(?:ngại|xấu hổ)|(?:hôm qua|lúc trước).{0,30}(?:vui|thích).{0,35}hôm nay.{0,20}(?:ngại|xấu hổ)|(?:hôm nay )?nghe ngại/iu.test(text);
  if (childFeeling && !explicitMiuFeeling) return action('conversation', 'respond', 'Acknowledge the child’s own current feeling or awkwardness. An omitted subject in this disclosure refers to the child’s experience, not Miu’s personality or daily mood. Do not recenter the conversation on Miu or diagnose a cause. Honor the preferred form of address; previous play or nickname permission need not feel right today. No need to ask for another explanation.', {
    allowedFacts: [text], target: { kind: 'current_child_experience', slot: 'expressed_feeling', sourceIds: [] },
  });

  const memory = resolveMemoryQuery(context, text, history);
  if (memory) return action('memory', memory.status === 'ambiguous' ? 'clarify' : 'recall', memory.status === 'resolved'
    ? 'Answer the requested memory slot directly from the supplied source facts. Translate ordinary vocabulary naturally into the reply language; preserve every proper name, diacritic, and quoted story title. Distinguish objects, fictional characters, and real reported entities. Retain volunteered routine qualifiers and unknown precision. This read does not start or advance an activity.'
    : memory.status === 'ambiguous' ? 'Several eligible records materially match this specific slot. Ask one focused distinction; do not substitute a catalog title or guess a name.'
      : 'No eligible record supplies this requested slot. State the missing fact briefly without inventing historical recall, a precise time, or an assigned story title.', {
      allowedFacts: memory.status === 'resolved' ? memory.facts : [], target: { kind: memory.targetKind, slot: memory.slot, sourceIds: memory.sourceIds, status: memory.status },
    });

  if (/\b(?:daily mood|new mood|mood.*open|open.*mood|mood.*reload|mood.*day)\b|(?:tâm trạng.*(?:ngày|mở)|mỗi lần mở.*tâm trạng)/iu.test(text)) return action('app', 'explain_policy', 'Answer the app-policy question from authoritative application facts, rather than claiming uncertainty about configured behavior. Miu moods are fictional; the child is never responsible for changing them.', {
    allowedFacts: [`Miu's fictional daily mood stays ${context.daily.mood} throughout local date ${context.daily.localDate}, including reopen/reload. The shared night job replaces it once on a new local date. Turn emotion and time-band presentation can change while daily mood persists. Absence never worsens mood.`], target: { kind: 'app_state', slot: 'daily_mood_policy', sourceIds: [] },
  });
  if (/\b(?:your personality|your role|personality (?:setting|preset)|role setting|selected (?:personality|preset|role)|configured language|voice setting|language setting|your settings)\b|(?:tính cách (?:của )?miu|tính cách của bạn|cài đặt|vai trò (?:của )?miu)/iu.test(text)) return action('app', 'explain_policy', 'Answer the explicit character-configuration question directly from application policy, without an unnecessary clarification. The child can have mixed or changing feelings without rewriting Miu personality, role, memory, or identity. Presentation can become gentle to meet the child’s needs. Selected family settings change only through an explicit authorized setup operation, never inferred from conversation. Use simple words; do not recite internal setting codes unless the child specifically asks which setting is selected. Do not assess or type the child.', {
    allowedFacts: [`Miu's selected personality is ${context.config.personality}; role is ${context.config.role}; language policy is ${context.profile.languageMode}; approved voice is ${context.config.voiceId}. These settings persist until an explicit authorized configuration change. The child's feelings affect the current response tone, not those settings, saved memories, or AI-kitten canon.`],
    target: { kind: 'app_configuration', slot: 'setting_policy', sourceIds: [] },
  });
  const diary = /\b(?:your diary|current (?:pretend )?diary|little diary|your day|what did you do)\b|(?:nhật ký|hôm nay miu làm gì|chuyện của miu)/iu.test(text) && !/\bmy diary\b/iu.test(text);
  if (diary) {
    const date = /\b(?:date|which day|what day)\b|(?:ngày nào|ngày mấy|ngày bao nhiêu)/iu.test(text);
    return action('diary', date ? 'read_date' : 'read', date ? 'Answer the date of the current fictional diary entry directly. Do not substitute its prose or start a story.' : 'Share only the supplied current fictional diary entry; no backlog, real-weather inference, or story checkpoint.', {
      allowedFacts: date ? [`The current fictional diary entry is dated ${context.daily.localDate} in ${context.profile.timezone}.`] : [context.daily.diary[language]],
      target: { kind: 'daily_diary', slot: date ? 'local_date' : 'entry', sourceIds: [context.daily.diary.templateId] },
    });
  }
  if (/\b(?:your daily story|what did you learn today|what have you learned today)\b|(?:chuyện hôm nay của miu|hôm nay miu (?:đã )?học được gì)/iu.test(text)) return action('daily_episode', 'read', 'Read the approved current fictional daily learning episode. It is separate from the diary and from any resumable catalog story.', { allowedFacts: [context.daily.storyEpisode[language]], target: { kind: 'daily_episode', slot: 'entry', sourceIds: [context.daily.storyEpisode.templateId] } });

  if (isStoryTitleQuery(text)) {
    const metadata = storyMetadata(context);
    return action('catalog_story', 'read_title', metadata ? 'Answer only the supplied catalog story title. Do not narrate, preview, or advance any scene.' : 'No eligible catalog story title is available. Say so briefly without inventing one.', {
      allowedFacts: metadata ? [`The supported fictional catalog story title is ${JSON.stringify(metadata.title[language])}.`] : [], target: { kind: 'catalog_story', slot: 'title', sourceIds: metadata ? [context.storyProgress?.id ?? context.config.assignedStoryId ?? 'assigned'] : [], status: metadata ? 'resolved' : 'missing' },
    });
  }
  // A clear word-definition request has answerable public meaning; it is not
  // uncertain personal memory even when it refers to prior wordplay.
  const mixedDefinition = /[A-Za-z]{2,}/u.test(text) && /(?:\s(?:là|nghĩa|trong|tiếng)\s)/u.test(text) && /[?？]|hả|đúng không/u.test(text) && !/\b(?:my|our)\b|của (?:mình|tớ|tôi)/iu.test(text);
  if (mixedDefinition || /\b(?:mean|meaning|translate|translation|word|vocabulary)\b|(?:nghĩa|dịch|từ .{0,20}tiếng|tiếng Anh (?:thật|của)|tiếng Việt)/iu.test(text)) return action('learning', 'vocabulary', 'Answer the current word meaning or translation in its stated context, directly and accurately. Use heard language-learning context where relevant. Compound parts can aid reading but do not define the whole word literally. Distinguish factual meanings from the child’s explicitly pretend wordplay; do not ask an unnecessary name or meaning clarification.');

  const declinedStory = /\b(?:do not|don['’]t|no) (?:want )?(?:a |another |the )?story\b|(?:không muốn|đừng) (?:kể )?(?:truyện|chuyện)/iu.test(text);
  if (declinedStory) return action('conversation', 'pause', 'Honor the declined story. Do not start, resume, preview, or commit a scene.');
  let customStart = -1;
  for (const [index, exchange] of history.entries()) {
    if (explicitCatalogStart.test(exchange.user)) customStart = -1;
    else if (newCustomStory.test(exchange.user) || customStart < 0 && (customPremise.test(exchange.user) || landingPremise.test(exchange.user))) customStart = index;
  }
  const customHistory = customStart < 0 ? [] : history.slice(customStart);
  const customNow = customPremise.test(text) || pretendLanding.test(text) && customHistory.length > 0 || /\b(?:invent|imagine|suggest).{0,45}\b(?:pretend|imaginary|planet|mission)\b|\bhelp me end\b|\btell .{0,15}story (?:about|where|with)\b|thêm (?:đúng )?một chi tiết/iu.test(text);
  const continueCustom = customHistory.length > 0 && !explicitCatalogStart.test(text);
  if (customNow || continueCustom && (storyTerms.test(text) || ending.test(text) || observation.intent === 'continue_story')) {
    const missingContinuation = /^(?:continue|resume|finish) my (?:own |pretend |custom )?story[.!?\s]*$/iu.test(text.trim()) && !customHistory.length;
    if (missingContinuation && context.stories.length !== 1) return action('child_story', 'clarify', 'The child asks to continue their own story, but its premise is missing or materially ambiguous. Ask for one reminder of their story. Do not replace it with an assigned catalog plot.');
    const premise = newCustomStory.test(text) ? [] : customHistory.slice(-6).map(exchange => exchange.user);
    if (missingContinuation && context.stories[0]) premise.push(`Stored child-authored fiction: ${context.stories[0].title}: ${context.stories[0].summary}`);
    premise.push(text);
    const constraints = premise.filter(utterance => /\b(?:no|not|only|exactly|must|do not|don['’]t|stays|end)\b|(?:không|đừng|chỉ|đúng một|hết)/iu.test(utterance));
    const ends = ending.test(text);
    const contribution = /\b(?:help|add|invent|imagine|suggest|what.*(?:friend|say)|with me)\b|(?:thêm|giúp|cùng|kể tiếp|muốn.*thua)/iu.test(text) || observation.intent === 'continue_story';
    return action('child_story', ends ? 'ending' : contribution ? 'coauthor' : 'respond', ends
      ? 'Honor the child’s requested ending. If asked to help end it, add only the tiny requested conclusion; if the child says it is already over, acknowledge that ending without another scene, question, surprise, or hook. Do not substitute a catalog story.'
      : contribution ? 'Build only on the child’s supplied fictional premise and current requested contribution. Preserve cast, objects, choices, exclusions, and desired outcome. Add at most one small detail when requested. Leave room for the child to lead; never replace this with the assigned catalog plot or mutate Miu canon.'
        : 'Acknowledge the child’s fictional premise or constraint without adding an unrequested scene. Keep the supplied cast and choices distinct from real life and from the assigned catalog story.', {
      activity: { kind: 'child_story', premise, constraints, requestedEnding: ends ? text : null }, allowedFacts: premise,
    });
  }
  const catalogContinue = /^(?:(?:please|can you|could you)\s+)?(?:continue|resume|finish|tell (?:me )?the next part of) (?:the |our |miu['’]s )?(?:story|adventure)|(?:kể tiếp|tiếp tục).{0,16}(?:truyện|câu chuyện)/iu.test(text.trim());
  const catalogStart = explicitCatalogStart.test(text.trim());
  if (catalogContinue) return action('catalog_story', 'continue', 'Continue only the next approved catalog scene. A missing heard checkpoint permits only its opening, never skipping an unheard scene.', { stateEffect: 'catalog_continue' });
  if (catalogStart) return action('catalog_story', 'start', 'Tell the approved catalog scene for this explicit story request. Only completed heard delivery may establish the checkpoint.', { stateEffect: 'catalog_start' });
  if (observation.intent === 'continue_story') return action('conversation', 'clarify', 'There is no unambiguous catalog-continuation request or eligible child-story premise. Ask which story or missing scene the child means; do not silently start an assigned plot.');

  const gameRequest = isExplicitGameRequest(text);
  const gameContinuation = input.activeGame != null && text.length < 160
    && observation.intent !== 'comfort' && !observation.candidates.length;
  if (!input.boundaries?.noGames && (gameRequest || gameContinuation)) return action('game', 'game_turn', 'Follow the current child-led game rule and its actual clues. Keep educational facts correct. Accept a harmless pretend win without arguing over who deserves it; a playful outcome is not a real achievement or durable child trait. Honor ending/skip immediately.', { activity: { kind: 'game', premise: [...(gameRequest ? [] : input.activeGame?.premise ?? [])].slice(-5).concat(text), constraints: [], requestedEnding: null } });
  return action('conversation', 'respond', 'Respond directly to the current utterance using eligible evidence. Do not start an activity merely because a story or game was mentioned.');
}

export const resolveAction = resolveTurnAction;
