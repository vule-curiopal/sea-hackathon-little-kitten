import type { Language } from './i18n';
import type { Emotion } from './miu-pose';
import type { IconName } from '../components/Icon';

type Step = { title: string; body: string; emotion: Emotion };
type Feature = { title: string; body: string; icon: IconName };
export function getContent(language: Language): { steps: Step[]; safety: Feature[]; faq: { q: string; a: string }[] } {
  return language === 'vi' ? {
    steps: [
      { title: 'Một câu hỏi nhỏ', body: 'Với món đồ chơi, một lần chạm bắt đầu câu hỏi. Trên website, bật micrô và trò chuyện tự nhiên.', emotion: 'listening' },
      { title: 'Một câu trả lời ấm áp', body: 'Miu lắng nghe, suy nghĩ rồi trả lời với gương mặt thể hiện cảm xúc.', emotion: 'thinking' },
      { title: 'Cha mẹ luôn đồng hành', body: 'Xem câu trả lời của Miu và cho Miu nghỉ bất cứ khi nào gia đình cần.', emotion: 'happy' },
    ],
    safety: [
      { title: 'Cha mẹ luôn chủ động', body: 'Cho Miu nghỉ bất cứ lúc nào. Khi nghỉ, micrô đóng và Miu giữ yên lặng.', icon: 'pause' },
      { title: 'Lời của con vẫn thuộc về con', body: 'Giao diện chỉ hiển thị câu trả lời của Miu, không hiển thị lời của trẻ.', icon: 'lock' },
      { title: 'Không quảng cáo', body: 'Không mua sắm, không áp lực chơi lâu hơn. Chỉ có chỗ cho trí tò mò.', icon: 'shield' },
      { title: 'Thân quen, nhưng luôn rõ ràng', body: 'Miu là mèo AI với những cuộc phiêu lưu tưởng tượng, luôn dành chỗ cho gia đình và bạn bè thật.', icon: 'heart' },
    ],
    faq: [
      { q: 'Con có cần giữ nút khi nói không?', a: 'Không. Trên trang trò chuyện, bật micrô một lần rồi nói tự nhiên. Miu chờ khoảng hai giây yên lặng trước khi trả lời. Bạn luôn có thể tắt micrô.' },
      { q: 'Miu nói được ngôn ngữ nào?', a: 'Tiếng Việt và tiếng Anh. Dùng nút ngôn ngữ trong phòng để đổi ngôn ngữ cho câu trả lời tiếp theo.' },
      { q: 'Website có dùng được trên điện thoại và máy tính bảng không?', a: 'Có. Căn phòng vừa với iPhone, mở rộng trên iPad và có bảng trò chuyện bên cạnh trên màn hình rộng.' },
      { q: 'Có thể thử trước không?', a: 'Có. Bản demo tương tác có sẵn để làm quen với Miu. Hiện tại câu trả lời là mẫu, chưa kết nối dịch vụ AI hoặc tạo tài khoản thật.' },
      { q: 'Nếu trình duyệt chưa hỗ trợ giọng nói thì sao?', a: 'Mở nút trò chuyện để nhập tin nhắn. Lời bạn nhập được xóa sau khi gửi và không xuất hiện trong lịch sử.' },
    ],
  } : {
    steps: [
      { title: 'One little question', body: 'One tap starts a question on the toy. On the website, enable the microphone and talk naturally.', emotion: 'listening' },
      { title: 'One warm answer', body: 'Miu listens, has a little think, and answers with a face that shows just how it feels.', emotion: 'thinking' },
      { title: 'You stay in the loop', body: 'See what Miu answered, and let your little buddy rest whenever your family needs a break.', emotion: 'happy' },
    ],
    safety: [
      { title: 'You’re always in charge', body: 'Let Miu rest any time. While resting, the microphone is off and Miu stays quiet.', icon: 'pause' },
      { title: 'Their words stay theirs', body: 'The website shows Miu’s answers, never what your child said.', icon: 'lock' },
      { title: 'No ads. No pressure.', body: 'No shopping, no streaks, no reason to stay longer. Just a little room for curiosity.', icon: 'shield' },
      { title: 'A friend with honest boundaries', body: 'Miu is an AI kitten with make-believe adventures, leaving plenty of space for real friends and family.', icon: 'heart' },
    ],
    faq: [
      { q: 'Does my child have to hold the button?', a: 'No. In the web room, enable the microphone once, then talk naturally. Miu waits for about two seconds of quiet before replying. You can mute the microphone at any time.' },
      { q: 'Which languages does Miu speak?', a: 'Vietnamese and English. Use the language button in Miu’s room to choose the language for the next answer.' },
      { q: 'Can we use it on a phone or tablet?', a: 'Yes. Miu’s room fits your iPhone, opens up on an iPad, and gives the conversation its own space on wider screens.' },
      { q: 'Can we try it first?', a: 'Absolutely. The interactive demo lets you get to know Miu. Replies are samples for now, with live AI and real accounts to come.' },
      { q: 'What if my browser doesn’t support voice?', a: 'Open the conversation button to type a message. Your message is cleared after sending and never appears in the history.' },
    ],
  };
}
