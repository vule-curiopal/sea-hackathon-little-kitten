import type { Language } from './i18n';
import type { Emotion } from './miu-pose';
import type { IconName } from '../components/Icon';

type Step = { title: string; body: string; emotion: Emotion };
type Feature = { title: string; body: string; icon: IconName };
export function getContent(language: Language): { steps: Step[]; safety: Feature[]; faq: { q: string; a: string }[] } {
  return language === 'vi' ? {
    steps: [
      { title: 'Một câu hỏi nhỏ', body: 'Nhấn giữ nút để nói với Miu. Thả tay khi nói xong để gửi một lượt trò chuyện.', emotion: 'listening' },
      { title: 'Một câu trả lời ấm áp', body: 'Miu lắng nghe, suy nghĩ rồi trả lời với gương mặt thể hiện cảm xúc.', emotion: 'thinking' },
      { title: 'Cha mẹ luôn đồng hành', body: 'Xem câu trả lời của Miu và cho Miu nghỉ bất cứ khi nào gia đình cần.', emotion: 'happy' },
    ],
    safety: [
      { title: 'Cha mẹ luôn chủ động', body: 'Cho Miu nghỉ bất cứ lúc nào. Khi nghỉ, micrô đóng và Miu giữ yên lặng.', icon: 'pause' },
      { title: 'Lịch sử trên thiết bị', body: 'Tin nhắn của bạn và Miu được lưu trên thiết bị, tối đa 200 tin gần nhất cho mỗi hồ sơ. Bắt đầu cuộc trò chuyện mới để xóa lịch sử của hồ sơ đó.', icon: 'lock' },
      { title: 'Không quảng cáo', body: 'Không mua sắm, không áp lực chơi lâu hơn. Chỉ có chỗ cho trí tò mò.', icon: 'shield' },
      { title: 'Thân quen, nhưng luôn rõ ràng', body: 'Miu là mèo AI với những cuộc phiêu lưu tưởng tượng, luôn dành chỗ cho gia đình và bạn bè thật.', icon: 'heart' },
    ],
    faq: [
      { q: 'Con có cần giữ nút khi nói không?', a: 'Có. Nhấn giữ nút trong lúc nói, rồi thả tay để kết thúc và gửi một lượt trò chuyện. Một khoảng ngừng khi vẫn giữ nút không làm gửi tin nhắn.' },
      { q: 'Miu nói được ngôn ngữ nào?', a: 'Tiếng Việt và tiếng Anh. Dùng nút ngôn ngữ trong phòng để đổi ngôn ngữ cho câu trả lời tiếp theo.' },
      { q: 'Website có dùng được trên điện thoại và máy tính bảng không?', a: 'Có. Căn phòng vừa với iPhone, mở rộng trên iPad và có bảng trò chuyện bên cạnh trên màn hình rộng.' },
      { q: 'Làm sao để bắt đầu trò chuyện với Miu?', a: 'Tạo tài khoản hoặc đăng nhập để mở góc riêng cùng Miu. Sau đó, bạn có thể nói hoặc nhập tin nhắn để bắt đầu trò chuyện.' },
      { q: 'Nếu trình duyệt chưa hỗ trợ giọng nói thì sao?', a: 'Mở nút trò chuyện để nhập tin nhắn. Tin nhắn của bạn và câu trả lời của Miu cùng xuất hiện trong lịch sử được lưu trên thiết bị.' },
    ],
  } : {
    steps: [
      { title: 'One little question', body: 'Hold the button while speaking to Miu. Release when you finish to send one conversation turn.', emotion: 'listening' },
      { title: 'One warm answer', body: 'Miu listens, has a little think, and answers with a face that shows just how it feels.', emotion: 'thinking' },
      { title: 'You stay in the loop', body: 'See what Miu answered, and let your little buddy rest whenever your family needs a break.', emotion: 'happy' },
    ],
    safety: [
      { title: 'You’re always in charge', body: 'Let Miu rest any time. While resting, the microphone is off and Miu stays quiet.', icon: 'pause' },
      { title: 'History on this device', body: 'Your messages and Miu’s replies are saved on this device, up to 200 recent messages per profile. Start a new conversation to delete that profile’s history.', icon: 'lock' },
      { title: 'No ads. No pressure.', body: 'No shopping, no streaks, no reason to stay longer. Just a little room for curiosity.', icon: 'shield' },
      { title: 'A friend with honest boundaries', body: 'Miu is an AI kitten with make-believe adventures, leaving plenty of space for real friends and family.', icon: 'heart' },
    ],
    faq: [
      { q: 'Does my child have to hold the button?', a: 'Yes. Hold the button while speaking, then release to finish and send one conversation turn. A pause while still holding does not send the message.' },
      { q: 'Which languages does Miu speak?', a: 'Vietnamese and English. Use the language button in Miu’s room to choose the language for the next answer.' },
      { q: 'Can we use it on a phone or tablet?', a: 'Yes. Miu’s room fits your iPhone, opens up on an iPad, and gives the conversation its own space on wider screens.' },
      { q: 'How do we start talking with Miu?', a: 'Create an account or sign in to open your own space with Miu. Then speak or type a message to start the conversation.' },
      { q: 'What if my browser doesn’t support voice?', a: 'Open the conversation button to type a message. Your message and Miu’s reply both appear in the history saved on this device.' },
    ],
  };
}
