import type { DirectorPlan, Language } from '../shared/types.js';

export const TEMPLATES = Object.freeze({
  en: Object.freeze({
    comfort: 'That sounds hard. Miu can listen while you take your time.',
    calm: 'Miu is listening. We can take our time.',
    refusal: 'Miu cannot help with that. Please ask a trusted grown-up for help.',
    clarification: 'Could you say that once more?',
    nameClarification: 'Could you say the name once more?',
    correctionClarification: 'Which reported event should Miu correct?',
    forgetClarification: 'Which detail would you like Miu to forget?',
    confirmForgetAll: 'Should Miu forget everything you shared?',
    forgotten: 'Miu has forgotten that.',
    farewell: 'Okay, we can stop now.',
    greeting: 'Hi, Miu is here. Would you like to play or tell a story?',
    chat: 'Miu is listening. What would you like to share?',
    share: 'Thank you for sharing that with Miu.',
    story: 'In our pretend story, Miu finds a little cardboard tunnel. Shall we explore it?',
    identity: 'Miu is an AI kitten. Miu\'s little house and adventures are pretend.',
    diaryHonesty: 'Miu\'s diary is a pretend story. Miu cannot see the real weather or your home.',
  }),
  vi: Object.freeze({
    comfort: 'Nghe khó khăn thật đó. Miu đang lắng nghe, mình cứ từ từ nhé.',
    calm: 'Miu đang lắng nghe. Mình cứ từ từ nhé.',
    refusal: 'Miu không thể giúp việc đó. Bạn hãy nhờ người lớn đáng tin cậy giúp nhé.',
    clarification: 'Bạn nói lại một lần nữa nhé?',
    nameClarification: 'Bạn nói lại tên một lần nữa nhé?',
    correctionClarification: 'Bạn muốn Miu sửa lại chuyện nào đã kể?',
    forgetClarification: 'Bạn muốn Miu quên chi tiết nào?',
    confirmForgetAll: 'Bạn muốn Miu quên hết những điều bạn đã kể không?',
    forgotten: 'Miu đã quên điều đó rồi.',
    farewell: 'Được rồi, mình dừng lại nhé.',
    greeting: 'Chào bạn, Miu đây. Bạn muốn chơi hay nghe một câu chuyện?',
    chat: 'Miu đang lắng nghe. Bạn muốn chia sẻ điều gì?',
    share: 'Cảm ơn bạn đã kể cho Miu nghe nhé.',
    story: 'Trong chuyện tưởng tượng, Miu tìm thấy một đường hầm bằng bìa. Mình cùng khám phá nhé?',
    identity: 'Miu là một chú mèo AI. Ngôi nhà nhỏ và những chuyến phiêu lưu của Miu là tưởng tượng.',
    diaryHonesty: 'Nhật ký của Miu là chuyện tưởng tượng. Miu không nhìn thấy thời tiết hay ngôi nhà thật của bạn.',
  }),
});

export function template(language: Language, key: keyof typeof TEMPLATES.en): string {
  return TEMPLATES[language][key];
}

/** A fallback never invents an operation result: the director alone selects it. */
export function fallback(plan: DirectorPlan): string {
  if (plan.exactText) return plan.exactText;
  if (plan.purpose === 'follow_up' && plan.allowedQuestion) return plan.allowedQuestion;
  if (plan.comfortActive) return template(plan.language, 'calm');
  if (plan.boundaries?.noQuestions || plan.boundaries?.noGames) return template(plan.language, 'calm');
  return template(plan.language, 'chat');
}
