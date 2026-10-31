import type { StoryPlot } from './types.js';

/** Short authored arcs; the catalog supplies each adventure's pretend setting. */
export const PLOTS_A: readonly StoryPlot[] = [
  {
    id: 'button-orchestra', title: { en: 'The Missing Little Beat', vi: 'Nhịp Nhạc Nhỏ Còn Thiếu' }, theme: 'rhythm',
    scenes: [
      { en: 'At {place}, Miu taps three buttons, but the tune has an empty beat.', vi: 'Ở {place}, Miu gõ ba chiếc cúc, nhưng giai điệu còn thiếu một nhịp.' },
      { en: 'Pip taps faster, and the buttons tumble out of time.', vi: 'Pip gõ nhanh hơn, khiến những chiếc cúc lệch nhịp.' },
      { en: 'Miu sets {clue} beside the buttons to mark a quiet pause.', vi: 'Miu đặt {clue} cạnh các chiếc cúc để đánh dấu một nhịp nghỉ.' },
      { en: 'Tap, tap, rest, tap! Their tiny orchestra finally plays together.', vi: 'Tách, tách, nghỉ, tách! Dàn nhạc tí hon cuối cùng đã chơi cùng nhịp.' },
    ],
  },
  {
    id: 'picture-post', title: { en: 'A Letter Without Words', vi: 'Lá Thư Không Có Chữ' }, theme: 'communication',
    scenes: [
      { en: 'At {place}, Miu writes to Pip, but the pretend mailbox accepts only pictures.', vi: 'Ở {place}, Miu viết thư cho Pip, nhưng hộp thư tưởng tượng chỉ nhận tranh.' },
      { en: 'Miu draws a long squiggle, and Pip thinks it means spaghetti.', vi: 'Miu vẽ một nét ngoằn ngoèo, khiến Pip tưởng đó là mì sợi.' },
      { en: 'Miu draws their favorite game and adds {clue} to the envelope.', vi: 'Miu vẽ trò chơi cả hai thích rồi thêm {clue} vào phong bì.' },
      { en: 'Pip understands the invitation and sends back a picture of two smiling friends.', vi: 'Pip hiểu lời mời và gửi lại bức tranh hai người bạn mỉm cười.' },
    ],
  },
  {
    id: 'woven-gallery', title: { en: 'The Floor Made of Ribbons', vi: 'Tấm Sàn Dệt Từ Ruy Băng' }, theme: 'weaving',
    scenes: [
      { en: 'At {place}, Miu makes a ribbon mat, but every loose strip slips away.', vi: 'Ở {place}, Miu làm thảm ruy băng, nhưng các dải rời cứ trượt ra.' },
      { en: 'Pip lays the strips side by side, but gaps open when the mat moves.', vi: 'Pip xếp các dải sát nhau, nhưng thảm vừa động là khoảng hở lại xuất hiện.' },
      { en: 'They weave each strip over and under, marking the first corner with {clue}.', vi: 'Cả hai đan từng dải lên rồi xuống, dùng {clue} đánh dấu góc đầu tiên.' },
      { en: 'The woven mat holds together, giving their paper gallery a bright little floor.', vi: 'Tấm thảm đan giữ nguyên hình, làm sàn nhỏ rực rỡ cho phòng tranh giấy.' },
    ],
  },
  {
    id: 'shadow-color', title: { en: 'The Shadow With No Color', vi: 'Chiếc Bóng Không Có Màu' }, theme: 'observation',
    scenes: [
      { en: 'At {place}, Miu makes a colorful paper butterfly, but its shadow looks plain.', vi: 'Ở {place}, Miu làm bướm giấy nhiều màu, nhưng chiếc bóng trông thật đơn giản.' },
      { en: 'Pip adds another color, yet the shadow keeps the same outline.', vi: 'Pip thêm một màu nữa, nhưng chiếc bóng vẫn giữ nguyên hình.' },
      { en: 'They compare the butterfly with {clue} and notice each shadow follows its shape.', vi: 'Cả hai so bướm với {clue}, nhận ra bóng luôn theo hình đồ vật.' },
      { en: 'Miu makes a shadow guessing game, and Pip recognizes the butterfly by its wings.', vi: 'Miu bày trò đoán bóng, còn Pip nhận ra bướm nhờ đôi cánh.' },
    ],
  },
  {
    id: 'pretend-bakery', title: { en: 'The Blanket Bakery', vi: 'Tiệm Bánh Chăn Mềm' }, theme: 'sequencing',
    scenes: [
      { en: 'At {place}, Miu opens a bakery of round felt buns and square paper cakes.', vi: 'Ở {place}, Miu mở tiệm có bánh nỉ tròn và bánh giấy vuông.' },
      { en: 'Pip mixes up an order for round, square, round treats.', vi: 'Pip xếp nhầm đơn bánh theo thứ tự tròn, vuông, tròn.' },
      { en: 'Miu places {clue} by the order card and copies one shape at a time.', vi: 'Miu đặt {clue} bên phiếu đặt bánh rồi xếp từng hình theo mẫu.' },
      { en: 'The toy customers receive their matching plates, and the bakery closes with a bow.', vi: 'Các khách đồ chơi nhận đúng đĩa bánh, còn tiệm kết thúc bằng một cái cúi chào.' },
    ],
  },
  {
    id: 'empty-frame', title: { en: 'The Picture With Room', vi: 'Bức Tranh Còn Chỗ Trống' }, theme: 'creative-inclusion',
    scenes: [
      { en: 'At {place}, Miu finds an empty picture frame and wonders what belongs inside.', vi: 'Ở {place}, Miu thấy khung tranh trống, chưa biết nên đặt gì vào trong.' },
      { en: 'Pip fills it with paper dots until none of the background shows.', vi: 'Pip lấp đầy khung bằng chấm giấy, chẳng còn thấy nền đâu nữa.' },
      { en: 'Miu removes a few dots and gives {clue} a little space.', vi: 'Miu lấy bớt vài chấm, dành một khoảng nhỏ cho {clue}.' },
      { en: 'The space becomes a doorway in their picture, ready for an imaginary visitor.', vi: 'Khoảng trống thành cánh cửa trong tranh, sẵn sàng đón một vị khách tưởng tượng.' },
    ],
  },
  {
    id: 'quiet-museum', title: { en: 'The Museum of Quiet Sounds', vi: 'Bảo Tàng Âm Thanh Khe Khẽ' }, theme: 'listening',
    scenes: [
      { en: 'At {place}, Miu opens a quiet-sound museum, but its first exhibit is a loud clap.', vi: 'Ở {place}, Miu mở bảo tàng âm thanh khẽ, nhưng tiết mục đầu là vỗ tay lớn.' },
      { en: 'Pip tries a tiny wing rustle, and Miu leans closer to listen.', vi: 'Pip thử khẽ sột soạt đôi cánh, còn Miu nghiêng lại lắng nghe.' },
      { en: 'They add a soft tap beside {clue} and label each gentle sound.', vi: 'Cả hai thêm tiếng gõ nhẹ cạnh {clue}, rồi ghi tên từng âm thanh dịu dàng.' },
      { en: 'Their toy visitors enjoy a whole exhibition that fits inside a whisper.', vi: 'Các khách đồ chơi thích thú với cuộc triển lãm nhỏ nhẹ như lời thì thầm.' },
    ],
  },
  {
    id: 'circle-telescope', title: { en: 'The Telescope of Circles', vi: 'Ống Nhòm Những Hình Tròn' }, theme: 'perspective',
    scenes: [
      { en: 'At {place}, Miu rolls a paper telescope and searches for a pretend moon.', vi: 'Ở {place}, Miu cuộn ống nhòm giấy rồi tìm mặt trăng tưởng tượng.' },
      { en: 'A nearby button fills the view and looks bigger than the paper moon.', vi: 'Một chiếc cúc ở gần lấp đầy ống nhòm, trông còn to hơn mặt trăng giấy.' },
      { en: 'Pip moves {clue} near and far while Miu watches its size change.', vi: 'Pip đưa {clue} lại gần rồi ra xa, còn Miu ngắm kích thước thay đổi.' },
      { en: 'They draw a tiny pretend sky where one button can be a giant planet.', vi: 'Cả hai vẽ bầu trời tưởng tượng tí hon, nơi một chiếc cúc thành hành tinh khổng lồ.' },
    ],
  },
  {
    id: 'door-for-everyone', title: { en: 'The Door for Every Friend', vi: 'Cánh Cửa Cho Mọi Người Bạn' }, theme: 'accessibility',
    scenes: [
      { en: 'At {place}, Miu builds a clubhouse, but a round toy cannot fit through its door.', vi: 'Ở {place}, Miu dựng nhà bìa, nhưng bạn đồ chơi tròn không lọt cửa.' },
      { en: 'Pip measures the doorway with a folded paper strip.', vi: 'Pip đo cánh cửa bằng một dải giấy gấp.' },
      { en: 'They make the doorway wider and put {clue} beside its welcome sign.', vi: 'Cả hai mở cửa rộng hơn, đặt {clue} cạnh biển chào mừng.' },
      { en: 'Every toy friend fits inside, and the clubhouse meeting begins.', vi: 'Bạn đồ chơi nào cũng vào được, và buổi họp câu lạc bộ bắt đầu.' },
    ],
  },
  {
    id: 'cloud-puzzle', title: { en: 'The Cloud With a Corner', vi: 'Đám Mây Có Một Góc Vuông' }, theme: 'flexible-thinking',
    scenes: [
      { en: 'At {place}, Miu makes a cloud puzzle, but a square piece will not fit.', vi: 'Ở {place}, Miu ghép đám mây, nhưng mảnh vuông không khớp viền tròn.' },
      { en: 'Pip turns the piece four times and discovers a little window drawn on it.', vi: 'Pip xoay mảnh ghép bốn lần, rồi thấy hình cửa sổ nhỏ trên đó.' },
      { en: 'Miu puts {clue} below the window and builds a house beneath the cloud.', vi: 'Miu đặt {clue} dưới cửa sổ, rồi dựng ngôi nhà bên dưới đám mây.' },
      { en: 'The odd piece belongs to a cozy house, and their bigger picture is complete.', vi: 'Mảnh khác biệt thuộc về ngôi nhà ấm cúng, và bức tranh lớn hơn đã hoàn thành.' },
    ],
  },
  {
    id: 'backwards-parade', title: { en: 'The Parade That Turned Around', vi: 'Cuộc Diễu Hành Quay Đầu' }, theme: 'leadership-sharing',
    scenes: [
      { en: 'At {place}, Miu leads a toy parade, but the smallest toy cannot see the banners.', vi: 'Ở {place}, Miu dẫn đoàn đồ chơi, nhưng bạn nhỏ nhất không thấy cờ giấy.' },
      { en: 'Pip suggests raising every banner, but the little toy still sees only backs.', vi: 'Pip đề nghị giơ cờ lên cao, nhưng bạn nhỏ vẫn chỉ thấy lưng mọi người.' },
      { en: 'They turn the whole parade around and give {clue} to the new leader.', vi: 'Cả đoàn quay đầu, rồi trao {clue} cho người dẫn đầu mới.' },
      { en: 'The smallest toy leads the final lap, and everyone gets a turn to wave.', vi: 'Bạn nhỏ nhất dẫn vòng cuối, còn ai cũng được thay phiên vẫy chào.' },
    ],
  },
  {
    id: 'soft-bell', title: { en: 'The Bell That Learned Softly', vi: 'Chiếc Chuông Ngân Khe Khẽ' }, theme: 'sound-experiment',
    scenes: [
      { en: 'At {place}, Miu needs a gentle puppet-nap bell, but the little bell rings brightly.', vi: 'Ở {place}, Miu cần chuông nhẹ cho giấc ngủ rối, nhưng chuông lại reo vang.' },
      { en: 'Pip taps more slowly, though each ring stays just as bright.', vi: 'Pip gõ chậm hơn, nhưng mỗi tiếng chuông vẫn vang như cũ.' },
      { en: 'Miu rests the bell on felt and places {clue} beside the puppet pillow.', vi: 'Miu đặt chuông lên nỉ, rồi để {clue} cạnh gối của bạn rối.' },
      { en: 'A soft little chime ends the puppet play with a peaceful pretend nap.', vi: 'Tiếng leng keng khẽ khàng khép lại vở rối bằng giấc ngủ tưởng tượng yên bình.' },
    ],
  },
  {
    id: 'folded-garden', title: { en: 'The Garden That Stood Up', vi: 'Khu Vườn Đứng Dậy' }, theme: 'paper-engineering',
    scenes: [
      { en: 'At {place}, Miu makes paper flowers, but their flat stems will not stand.', vi: 'Ở {place}, Miu làm hoa giấy, nhưng thân phẳng không đứng được.' },
      { en: 'Pip leans each flower against another, and the whole row slowly slides.', vi: 'Pip tựa từng bông vào nhau, khiến cả hàng hoa từ từ trượt xuống.' },
      { en: 'Miu folds broad paper feet and uses {clue} to mark the first flower bed.', vi: 'Miu gấp chân giấy rộng, rồi dùng {clue} đánh dấu luống hoa đầu tiên.' },
      { en: 'The flowers stand in a colorful row, ready for a paper butterfly visit.', vi: 'Những bông hoa đứng thành hàng rực rỡ, sẵn sàng đón bướm giấy ghé thăm.' },
    ],
  },
  {
    id: 'harbor-labels', title: { en: 'A Dock for the Paper Boats', vi: 'Bến Đỗ Cho Thuyền Giấy' }, theme: 'organization',
    scenes: [
      { en: 'At {place}, Miu opens a harbor, but three paper boats crowd one tiny dock.', vi: 'Ở {place}, Miu mở cảng, nhưng ba thuyền giấy chen vào một bến tí hon.' },
      { en: 'Pip draws extra docks, and the boats still follow the same blue arrow.', vi: 'Pip vẽ thêm bến, nhưng các thuyền vẫn theo cùng một mũi tên xanh.' },
      { en: 'They draw matching boat symbols and set {clue} beside the harbor map.', vi: 'Cả hai vẽ ký hiệu riêng cho từng thuyền, rồi đặt {clue} cạnh bản đồ cảng.' },
      { en: 'Each boat finds its own dock, leaving room for a friendly welcome wave.', vi: 'Mỗi thuyền tìm đúng bến của mình, còn đủ chỗ cho một cái vẫy chào vui vẻ.' },
    ],
  },
  {
    id: 'touch-museum', title: { en: 'The Museum You Can Feel', vi: 'Bảo Tàng Có Thể Chạm' }, theme: 'textures',
    scenes: [
      { en: 'At {place}, Miu makes a toy museum, but its picture labels cannot describe textures.', vi: 'Ở {place}, Miu mở bảo tàng đồ chơi, nhưng nhãn tranh chưa tả được cảm giác khi chạm.' },
      { en: 'Pip sorts smooth shapes together and gives the bumpy shapes another tray.', vi: 'Pip xếp các hình nhẵn cùng nhau, dành khay khác cho những hình sần.' },
      { en: 'Miu adds {clue} and makes a label with a matching paper texture.', vi: 'Miu thêm {clue}, rồi làm nhãn có bề mặt giấy tương ứng.' },
      { en: 'Their visitors explore gently, and every exhibit has a texture story to tell.', vi: 'Các vị khách nhẹ nhàng khám phá, và món trưng bày nào cũng có câu chuyện cảm giác.' },
    ],
  },
  {
    id: 'slow-puppet', title: { en: 'The Puppet Between Words', vi: 'Bạn Rối Giữa Những Lời Nói' }, theme: 'conversation-turns',
    scenes: [
      { en: 'At {place}, Miu and Pip make puppets talk, but their words keep bumping together.', vi: 'Ở {place}, Miu và Pip cho rối trò chuyện, nhưng lời cứ chồng lên nhau.' },
      { en: 'Both puppets stop at once, leaving a very quiet stage.', vi: 'Cả hai bạn rối cùng ngừng lại, khiến sân khấu bỗng thật im ắng.' },
      { en: 'They pass {clue} between the puppets to show whose turn it is.', vi: 'Cả hai chuyền {clue} giữa hai bạn rối để đánh dấu lượt nói.' },
      { en: 'One puppet tells a joke, the other replies, and their little play finally flows.', vi: 'Một bạn rối kể chuyện vui, bạn kia đáp lại, và vở diễn cuối cùng cũng trôi chảy.' },
    ],
  },
  {
    id: 'paper-breeze', title: { en: 'The Little Breeze Machine', vi: 'Cỗ Máy Gió Nhỏ' }, theme: 'cause-and-effect',
    scenes: [
      { en: 'At {place}, Miu builds a windmill, but its paper wheel sits still.', vi: 'Ở {place}, Miu dựng cối xay gió, nhưng bánh xe giấy cứ đứng yên.' },
      { en: 'Pip waves one flat card, making only a tiny breeze.', vi: 'Pip quạt một tấm bìa phẳng, tạo ra làn gió rất nhẹ.' },
      { en: 'Miu folds a paper fan and places {clue} where the breeze reaches.', vi: 'Miu gấp quạt giấy, rồi đặt {clue} ở nơi làn gió thổi tới.' },
      { en: 'The wheel turns slowly, and the breeze machine earns its first paper flag.', vi: 'Bánh xe quay chậm rãi, và cỗ máy gió nhận lá cờ giấy đầu tiên.' },
    ],
  },
  {
    id: 'three-stop-train', title: { en: 'The Train With Three Stops', vi: 'Chuyến Tàu Ba Trạm' }, theme: 'route-planning',
    scenes: [
      { en: 'At {place}, Miu lays a toy railway with library, bakery, and garden stops.', vi: 'Ở {place}, Miu đặt tàu đồ chơi qua thư viện, tiệm bánh và khu vườn.' },
      { en: 'Pip sends every carriage to the bakery, so the library books miss their stop.', vi: 'Pip cho mọi toa đến tiệm bánh, khiến sách thư viện lỡ mất trạm.' },
      { en: 'They line up three station cards and use {clue} as the train marker.', vi: 'Cả hai xếp ba thẻ nhà ga, rồi dùng {clue} đánh dấu vị trí tàu.' },
      { en: 'The books reach the library before the train finishes its cheerful garden loop.', vi: 'Sách đến được thư viện trước khi tàu hoàn thành vòng chạy vui vẻ quanh vườn.' },
    ],
  },
  {
    id: 'cup-echo', title: { en: 'The Echo in a Paper Cup', vi: 'Tiếng Vang Trong Cốc Giấy' }, theme: 'sound-discovery',
    scenes: [
      { en: 'At {place}, Miu hums into a paper cup and hears a funny, round sound.', vi: 'Ở {place}, Miu ngân nga vào cốc giấy, nghe âm thanh tròn tròn vui tai.' },
      { en: 'Pip hums beside the cup, but the sound feels different.', vi: 'Pip ngân nga cạnh chiếc cốc, nhưng âm thanh lại khác.' },
      { en: 'They compare both sounds, marking each turn with {clue}.', vi: 'Cả hai so sánh hai âm thanh, dùng {clue} đánh dấu từng lượt.' },
      { en: 'Their puppet announcer chooses the cup voice for a wonderfully wobbly pretend radio show.', vi: 'Bạn rối dẫn chương trình chọn giọng trong cốc cho buổi phát thanh tưởng tượng ngộ nghĩnh.' },
    ],
  },
  {
    id: 'ribbon-maze', title: { en: 'The Maze With a Meeting Place', vi: 'Mê Cung Có Chỗ Gặp Nhau' }, theme: 'cooperative-planning',
    scenes: [
      { en: 'At {place}, Miu and Pip draw ribbon paths, but their toy walkers never meet.', vi: 'Ở {place}, Miu và Pip vẽ lối ruy băng, nhưng các bạn đồ chơi chẳng gặp nhau.' },
      { en: 'They add more twists, making the paths even harder to follow.', vi: 'Cả hai thêm nhiều đoạn ngoằn ngoèo, khiến đường càng khó lần theo.' },
      { en: 'Miu places {clue} in the middle and draws two simple paths toward it.', vi: 'Miu đặt {clue} ở giữa, rồi vẽ hai lối đơn giản cùng hướng đến đó.' },
      { en: 'Both walkers arrive at one little square, just in time for a pretend picnic.', vi: 'Hai bạn cùng đến quảng trường nhỏ, vừa kịp buổi dã ngoại tưởng tượng.' },
    ],
  },
  {
    id: 'theatre-seats', title: { en: 'The Theatre With a Front Row', vi: 'Rạp Hát Có Hàng Ghế Đầu' }, theme: 'welcoming-design',
    scenes: [
      { en: 'At {place}, Miu builds a puppet theatre, but a tall cushion hides the audience.', vi: 'Ở {place}, Miu dựng rạp rối, nhưng chiếc gối cao che mất khán giả.' },
      { en: 'Pip lifts the curtain higher, though the shortest toys still cannot see.', vi: 'Pip kéo rèm cao hơn, nhưng các bạn đồ chơi thấp nhất vẫn không nhìn được.' },
      { en: 'They move the stage forward and mark the front row with {clue}.', vi: 'Cả hai đưa sân khấu ra trước, rồi dùng {clue} đánh dấu hàng ghế đầu.' },
      { en: 'Every toy sees the puppet bow, and the little theatre fills with pretend applause.', vi: 'Bạn nào cũng thấy rối cúi chào, và rạp nhỏ vang tiếng vỗ tay tưởng tượng.' },
    ],
  },
  {
    id: 'unfinished-book', title: { en: 'The Book With a Blank Ending', vi: 'Cuốn Sách Còn Trang Cuối Trống' }, theme: 'story-making',
    scenes: [
      { en: 'At {place}, Miu opens a paper-snail book, but its last page is blank.', vi: 'Ở {place}, Miu mở sách về ốc sên giấy, nhưng trang cuối còn trống.' },
      { en: 'Pip suggests a giant party, while Miu remembers the snail wanted a quiet shelf.', vi: 'Pip đề nghị tiệc lớn, còn Miu nhớ ốc sên muốn một chiếc kệ yên tĩnh.' },
      { en: 'They draw a cozy shelf with {clue} beside the snail bookend.', vi: 'Cả hai vẽ chiếc kệ ấm cúng, có {clue} bên chặn sách hình ốc sên.' },
      { en: 'The snail finds its reading spot, and Miu closes the finished book with a smile.', vi: 'Ốc sên tìm được chỗ đọc, còn Miu mỉm cười khép cuốn sách đã hoàn thành.' },
    ],
  },
  {
    id: 'balanced-mobile', title: { en: 'The Lopsided Star Mobile', vi: 'Chiếc Chuông Sao Bị Lệch' }, theme: 'balance',
    scenes: [
      { en: 'At {place}, Miu hangs paper stars on a mobile, but one side droops.', vi: 'Ở {place}, Miu treo sao giấy lên đồ treo, nhưng một bên bị nghiêng.' },
      { en: 'Pip adds another star to the low side, making the tilt bigger.', vi: 'Pip thêm sao vào bên thấp, khiến đồ treo nghiêng hơn nữa.' },
      { en: 'They move a star across and hang {clue} near the center.', vi: 'Cả hai chuyển một ngôi sao sang bên kia, rồi treo {clue} gần giữa.' },
      { en: 'The mobile rests level, with a whole tiny sky balanced beneath its paper moon.', vi: 'Đồ treo nằm cân bằng, mang bầu trời tí hon bên dưới mặt trăng giấy.' },
    ],
  },
  {
    id: 'turtle-footprints', title: { en: 'The Turtle Who Drew a Path', vi: 'Bạn Rùa Vẽ Đường Đi' }, theme: 'steady-progress',
    scenes: [
      { en: 'At {place}, a toy turtle wants to visit a paper pond, but the map has no path.', vi: 'Ở {place}, rùa đồ chơi muốn thăm ao giấy, nhưng bản đồ chưa có đường.' },
      { en: 'Miu draws giant steps, and the tiny turtle cannot reach between them.', vi: 'Miu vẽ bước thật dài, khiến rùa nhỏ không với tới bước tiếp theo.' },
      { en: 'Pip makes small footprints and places {clue} at the pond entrance.', vi: 'Pip vẽ dấu chân nhỏ, rồi đặt {clue} ở lối vào ao.' },
      { en: 'The turtle follows every little step and arrives beside its own reflection drawing.', vi: 'Rùa theo từng bước nhỏ, rồi đến bên bức vẽ bóng mình dưới ao.' },
    ],
  },
  {
    id: 'shape-delivery', title: { en: 'The Parcel With Four Corners', vi: 'Bưu Kiện Có Bốn Góc' }, theme: 'shape-reasoning',
    scenes: [
      { en: 'At {place}, Miu packs a square picture in a round parcel, but its corners stick out.', vi: 'Ở {place}, Miu gói tranh vuông trong bưu kiện tròn, nhưng các góc lòi ra.' },
      { en: 'Pip turns the picture sideways, and the same corners still peek out.', vi: 'Pip xoay bức tranh sang ngang, nhưng những góc ấy vẫn nhô ra.' },
      { en: 'They fold a square envelope and decorate its corner with {clue}.', vi: 'Cả hai gấp phong bì vuông, rồi trang trí một góc bằng {clue}.' },
      { en: 'The picture fits neatly, and their pretend post office stamps its first square parcel.', vi: 'Bức tranh vừa khít, và bưu điện tưởng tượng đóng dấu bưu kiện vuông đầu tiên.' },
    ],
  },
  {
    id: 'picture-song', title: { en: 'The Song Made of Pictures', vi: 'Bài Hát Ghép Bằng Tranh' }, theme: 'visual-rhythm',
    scenes: [
      { en: 'At {place}, Pip invents a tune, but Miu cannot remember where its soft hum belongs.', vi: 'Ở {place}, Pip nghĩ ra giai điệu, nhưng Miu quên mất đoạn ngân nhẹ.' },
      { en: 'Miu draws a dot for a tap and a wavy line for a hum.', vi: 'Miu vẽ chấm tròn cho tiếng gõ và nét lượn sóng cho tiếng ngân.' },
      { en: 'They place {clue} beside the first picture and follow the row together.', vi: 'Cả hai đặt {clue} cạnh hình đầu tiên, rồi cùng theo cả hàng.' },
      { en: 'Tap, hum, tap! Their picture song sounds the same every time they choose to play.', vi: 'Gõ, ngân, gõ! Bài hát bằng tranh luôn đúng giai điệu mỗi khi cả hai muốn chơi.' },
    ],
  },
  {
    id: 'paper-snow', title: { en: 'The Snow Globe Without Snow', vi: 'Quả Cầu Tuyết Không Có Tuyết' }, theme: 'imaginative-substitution',
    scenes: [
      { en: 'At {place}, Miu draws a pretend snow globe, but it looks empty.', vi: 'Ở {place}, Miu vẽ quả cầu tuyết, nhưng bên trong trông thật trống.' },
      { en: 'Pip adds white paper dots, and Miu notices they look like tiny floating moons.', vi: 'Pip thêm chấm giấy trắng, khiến Miu thấy chúng giống những mặt trăng bé xíu.' },
      { en: 'They draw a moon village below and place {clue} at its gate.', vi: 'Cả hai vẽ làng mặt trăng bên dưới, rồi đặt {clue} nơi cổng làng.' },
      { en: 'Their empty globe becomes a whole pretend world with a softly spotted sky.', vi: 'Quả cầu trống thành cả thế giới tưởng tượng dưới bầu trời chấm trắng dịu dàng.' },
    ],
  },
  {
    id: 'picnic-places', title: { en: 'The Picnic With One More Place', vi: 'Buổi Dã Ngoại Thêm Một Chỗ' }, theme: 'counting-and-inclusion',
    scenes: [
      { en: 'At {place}, Miu sets a picnic for four toys, then a fifth toy rolls over.', vi: 'Ở {place}, Miu bày dã ngoại cho bốn bạn đồ chơi, rồi bạn thứ năm lăn tới.' },
      { en: 'Pip counts the cups again and finds only four little places.', vi: 'Pip đếm lại các cốc, chỉ thấy bốn chỗ ngồi nhỏ.' },
      { en: 'They add a fifth paper cup and place {clue} beside the new seat.', vi: 'Cả hai thêm cốc giấy thứ năm, rồi đặt {clue} cạnh chỗ ngồi mới.' },
      { en: 'Five toys toast with empty cups, and every picnic place has a friend.', vi: 'Năm bạn nâng cốc trống chúc vui, và mỗi chỗ dã ngoại đều có bạn ngồi.' },
    ],
  },
  {
    id: 'mixed-mittens', title: { en: 'The Mittens With Mixed-Up Spots', vi: 'Những Chiếc Găng Tay Lẫn Chấm' }, theme: 'matching',
    scenes: [
      { en: 'At {place}, Miu sorts paper mittens for puppets, but their patterns are mixed up.', vi: 'Ở {place}, Miu xếp găng giấy cho các bạn rối, nhưng họa tiết bị lẫn.' },
      { en: 'Pip matches colors first and finds a striped mitten beside a dotted one.', vi: 'Pip ghép theo màu trước, rồi thấy găng sọc nằm cạnh găng chấm.' },
      { en: 'They match both color and pattern, using {clue} to mark each finished pair.', vi: 'Cả hai ghép cả màu lẫn họa tiết, dùng {clue} đánh dấu từng đôi đã xong.' },
      { en: 'Every puppet receives two matching mittens for the pretend snow dance.', vi: 'Bạn rối nào cũng nhận đôi găng giống nhau để múa giữa tuyết tưởng tượng.' },
    ],
  },
  {
    id: 'bubble-aquarium', title: { en: 'The Aquarium of Paper Bubbles', vi: 'Bể Cá Bong Bóng Giấy' }, theme: 'grouping',
    scenes: [
      { en: 'At {place}, Miu decorates an aquarium, but paper bubbles cover every fish.', vi: 'Ở {place}, Miu trang trí bể cá, nhưng bong bóng giấy che kín các bạn cá.' },
      { en: 'Pip gathers the biggest bubbles into one corner and uncovers a tiny paper fin.', vi: 'Pip gom bong bóng lớn vào một góc, để lộ chiếc vây giấy nhỏ.' },
      { en: 'They sort three bubble trails by size and put {clue} beside the aquarium sign.', vi: 'Cả hai xếp ba dải bong bóng theo cỡ, rồi đặt {clue} cạnh biển bể cá.' },
      { en: 'The fish pictures peek between the trails, and their paper aquarium is ready to view.', vi: 'Những hình cá ló giữa các dải bong bóng, và bể cá giấy đã sẵn sàng trưng bày.' },
    ],
  },
  {
    id: 'clock-with-pictures', title: { en: 'The Clock With Picture Hours', vi: 'Chiếc Đồng Hồ Giờ Bằng Tranh' }, theme: 'routine-sequencing',
    scenes: [
      { en: 'At {place}, Miu makes a clock, but its hands point to two games at once.', vi: 'Ở {place}, Miu làm đồng hồ, nhưng kim chỉ vào hai trò chơi cùng lúc.' },
      { en: 'Pip draws a book, a stretch, and a quiet rest around the clock.', vi: 'Pip vẽ sách, động tác vươn vai và giờ nghỉ yên tĩnh quanh đồng hồ.' },
      { en: 'Miu adds one movable hand and marks the starting picture with {clue}.', vi: 'Miu thêm một kim di chuyển được, rồi dùng {clue} đánh dấu hình bắt đầu.' },
      { en: 'Their puppet chooses one picture at a time and finishes its gentle pretend afternoon.', vi: 'Bạn rối chọn từng hình một, rồi hoàn thành buổi chiều tưởng tượng nhẹ nhàng.' },
    ],
  },
  {
    id: 'umbrella-patchwork', title: { en: 'The Umbrella of Different Dots', vi: 'Chiếc Ô Những Chấm Khác Nhau' }, theme: 'repair-and-design',
    scenes: [
      { en: 'At {place}, Miu draws an umbrella, but one patch of its dotted pattern is missing.', vi: 'Ở {place}, Miu vẽ chiếc ô, nhưng thiếu một mảng họa tiết chấm tròn.' },
      { en: 'Pip searches for an exact matching dot and finds only stripes.', vi: 'Pip tìm chấm tròn giống hệt, nhưng chỉ thấy các dải sọc.' },
      { en: 'They make a striped patch and decorate its edge with {clue}.', vi: 'Cả hai làm mảng vá sọc, rồi trang trí viền bằng {clue}.' },
      { en: 'The umbrella becomes a patchwork picture, with one special panel that tells its own story.', vi: 'Chiếc ô thành tranh chắp ghép, có một mảng đặc biệt kể câu chuyện riêng.' },
    ],
  },
  {
    id: 'moon-craters', title: { en: 'The Moon Rug', vi: 'Tấm Thảm Mặt Trăng' }, theme: 'size-comparison',
    scenes: [
      { en: 'At {place}, Miu makes a moon rug, but every paper crater has the same size.', vi: 'Ở {place}, Miu làm thảm mặt trăng, nhưng mọi hố giấy đều cùng một cỡ.' },
      { en: 'Pip lays out a cup, a button, and a big paper circle.', vi: 'Pip bày chiếc cốc, chiếc cúc và hình tròn giấy lớn.' },
      { en: 'They trace three crater sizes and leave {clue} beside the smallest one.', vi: 'Cả hai vẽ ba cỡ hố, rồi để {clue} cạnh hố nhỏ nhất.' },
      { en: 'A toy moon walker visits small, medium, and big craters before resting on the rug.', vi: 'Bạn thám hiểm đồ chơi ghé hố nhỏ, vừa và lớn, rồi nghỉ trên tấm thảm.' },
    ],
  },
  {
    id: 'toy-bus-ramp', title: { en: 'The Bus With a Wide Welcome', vi: 'Chiếc Xe Buýt Đón Mọi Bạn' }, theme: 'inclusive-invention',
    scenes: [
      { en: 'At {place}, Miu builds a bus, but a wheeled toy cannot climb its paper step.', vi: 'Ở {place}, Miu dựng xe buýt, nhưng bạn đồ chơi có bánh không lên được bậc giấy.' },
      { en: 'Pip offers a taller step, and Miu notices it makes boarding harder.', vi: 'Pip đưa bậc cao hơn, còn Miu nhận ra như vậy càng khó lên.' },
      { en: 'They fold a wide ramp and mark its edge with {clue}.', vi: 'Cả hai gấp dốc lên rộng, rồi đánh dấu mép bằng {clue}.' },
      { en: 'The wheeled toy rolls aboard, and the whole pretend bus sets off together.', vi: 'Bạn đồ chơi lăn lên xe, và cả chuyến xe buýt tưởng tượng cùng khởi hành.' },
    ],
  },
  {
    id: 'ribbon-measure', title: { en: 'The Ribbon That Measured a Smile', vi: 'Dải Ruy Băng Đo Nụ Cười' }, theme: 'measurement',
    scenes: [
      { en: 'At {place}, Miu frames a puppet portrait with ribbon, but the strip looks too short.', vi: 'Ở {place}, Miu viền tranh rối bằng ruy băng, nhưng dải trông quá ngắn.' },
      { en: 'Pip measures one side and forgets the other three.', vi: 'Pip đo một cạnh rồi quên mất ba cạnh còn lại.' },
      { en: 'They mark every corner with {clue}, moving it as they measure around.', vi: 'Cả hai đánh dấu từng góc bằng {clue}, di chuyển nó khi đo vòng quanh.' },
      { en: 'Four measured strips frame the portrait, leaving the puppet smile right in the middle.', vi: 'Bốn dải vừa đo tạo thành khung tranh, để nụ cười bạn rối ngay chính giữa.' },
    ],
  },
  {
    id: 'paper-mosaic', title: { en: 'The Mosaic With a Missing Piece', vi: 'Bức Tranh Ghép Thiếu Một Mảnh' }, theme: 'part-and-whole',
    scenes: [
      { en: 'At {place}, Miu makes a paper mosaic, but a gap remains in its smiling face.', vi: 'Ở {place}, Miu ghép tranh giấy, nhưng gương mặt cười vẫn còn một khe trống.' },
      { en: 'Pip tries a large square, which covers the whole little nose.', vi: 'Pip thử miếng vuông lớn, khiến cả chiếc mũi nhỏ bị che mất.' },
      { en: 'They fold a smaller piece and place {clue} beside the completed picture.', vi: 'Cả hai gấp mảnh nhỏ hơn, rồi đặt {clue} cạnh bức tranh hoàn chỉnh.' },
      { en: 'The tiny piece becomes a nose, and their mosaic smiles back at the toy gallery.', vi: 'Mảnh bé xíu thành chiếc mũi, và bức tranh mỉm cười giữa phòng tranh đồ chơi.' },
    ],
  },
  {
    id: 'gentle-dragon', title: { en: 'The Dragon Who Collected Cushions', vi: 'Bạn Rồng Sưu Tầm Gối' }, theme: 'asking-and-sharing',
    scenes: [
      { en: 'At {place}, a paper dragon gathers every cushion, leaving toy readers nowhere to sit.', vi: 'Ở {place}, rồng giấy gom hết gối, khiến các bạn đọc sách không còn chỗ ngồi.' },
      { en: 'Miu asks what the dragon needs and learns it wants one soft reading nest.', vi: 'Miu hỏi bạn rồng cần gì, rồi biết bạn muốn một tổ đọc sách mềm.' },
      { en: 'They make a small nest and add {clue} as its book marker.', vi: 'Cả hai làm tổ nhỏ, rồi thêm {clue} làm dấu chỗ sách.' },
      { en: 'The dragon returns the spare cushions, and everyone settles into the shared reading circle.', vi: 'Rồng trả lại gối thừa, và mọi người cùng ngồi vào vòng đọc sách.' },
    ],
  },
  {
    id: 'paper-kite-tail', title: { en: 'The Kite With Two Tails', vi: 'Chiếc Diều Hai Đuôi' }, theme: 'testing-ideas',
    scenes: [
      { en: 'At {place}, Miu draws a kite with one huge tail, making the picture look tilted.', vi: 'Ở {place}, Miu vẽ diều có một đuôi khổng lồ, khiến hình trông nghiêng hẳn.' },
      { en: 'Pip draws a second huge tail, filling the whole page.', vi: 'Pip vẽ thêm chiếc đuôi khổng lồ thứ hai, lấp kín cả trang.' },
      { en: 'They try two short tails and add {clue} as the kite emblem.', vi: 'Cả hai thử hai đuôi ngắn, rồi thêm {clue} làm huy hiệu cho diều.' },
      { en: 'The kite fits neatly in their pretend sky, with room for a smiling paper cloud.', vi: 'Chiếc diều nằm vừa trên trời tưởng tượng, còn chỗ cho đám mây giấy mỉm cười.' },
    ],
  },
  {
    id: 'soup-of-shapes', title: { en: 'The Soup of Three Shapes', vi: 'Nồi Súp Ba Hình' }, theme: 'classification',
    scenes: [
      { en: 'At {place}, Miu makes pretend soup with a recipe for circles, triangles, and stars.', vi: 'Ở {place}, Miu nấu súp giấy cần hình tròn, tam giác và ngôi sao.' },
      { en: 'Pip adds every paper shape, including a square pretending to be a star.', vi: 'Pip cho mọi hình giấy vào, cả hình vuông đang giả làm ngôi sao.' },
      { en: 'They sort three bowls and use {clue} to mark the finished recipe card.', vi: 'Cả hai xếp ba bát riêng, rồi dùng {clue} đánh dấu thẻ công thức đã xong.' },
      { en: 'Their soup picture has exactly three kinds of shapes, ready for the puppet cafe.', vi: 'Bức tranh súp có đúng ba loại hình, sẵn sàng cho quán ăn của các bạn rối.' },
    ],
  },
  {
    id: 'winding-welcome', title: { en: 'The Welcome Sign That Wandered', vi: 'Tấm Biển Chào Đi Lạc' }, theme: 'clear-directions',
    scenes: [
      { en: 'At {place}, Miu hangs a welcome arrow, but toy guests follow it toward the wrong picture.', vi: 'Ở {place}, Miu treo mũi tên chào mừng, nhưng khách đồ chơi theo nó đến nhầm tranh.' },
      { en: 'Pip adds a second arrow that points back to the first.', vi: 'Pip thêm mũi tên thứ hai, nhưng nó lại chỉ về mũi tên đầu.' },
      { en: 'They draw one clear arrow and place {clue} beside the meeting spot.', vi: 'Cả hai vẽ một mũi tên rõ ràng, rồi đặt {clue} cạnh chỗ gặp.' },
      { en: 'Every toy guest reaches the welcome mat, and the pretend gathering begins.', vi: 'Bạn khách đồ chơi nào cũng đến thảm chào mừng, và buổi gặp tưởng tượng bắt đầu.' },
    ],
  },
  {
    id: 'patchwork-river', title: { en: 'The River With a Paper Bend', vi: 'Dòng Sông Có Khúc Cong Giấy' }, theme: 'spatial-design',
    scenes: [
      { en: 'At {place}, Miu lays a paper river, but a straight piece points through a toy house.', vi: 'Ở {place}, Miu xếp sông giấy, nhưng một đoạn thẳng chạy xuyên nhà đồ chơi.' },
      { en: 'Pip tries moving the house, but its pretend garden is already attached.', vi: 'Pip thử chuyển nhà, nhưng khu vườn tưởng tượng đã gắn liền bên cạnh.' },
      { en: 'They fold a river bend around the house and set {clue} on its bank.', vi: 'Cả hai gấp khúc sông vòng quanh nhà, rồi đặt {clue} bên bờ.' },
      { en: 'The blue river reaches its paper lake, and the little house keeps its garden.', vi: 'Dòng sông xanh đến được hồ giấy, còn ngôi nhà nhỏ giữ nguyên khu vườn.' },
    ],
  },
  {
    id: 'different-clouds', title: { en: 'The Cloud Costume', vi: 'Bộ Trang Phục Đám Mây' }, theme: 'creative-confidence',
    scenes: [
      { en: 'At {place}, Miu makes a cloud costume, but Pip thinks it looks like a potato.', vi: 'Ở {place}, Miu làm trang phục mây, nhưng Pip thấy giống củ khoai tây.' },
      { en: 'They turn the costume sideways and discover a shape like a sleeping sheep.', vi: 'Cả hai xoay trang phục sang ngang, rồi thấy hình giống cừu đang ngủ.' },
      { en: 'Miu adds {clue} as a costume badge and keeps the wonderfully wobbly outline.', vi: 'Miu thêm {clue} làm huy hiệu trang phục, giữ nguyên đường viền lượn lờ vui mắt.' },
      { en: 'Their puppet wears the cloud-potato-sheep costume, earning three happy names in one little play.', vi: 'Bạn rối mặc trang phục mây-khoai-cừu, có ba cái tên vui trong cùng vở diễn nhỏ.' },
    ],
  },
  {
    id: 'patient-print', title: { en: 'The Stamp That Needed Space', vi: 'Con Dấu Cần Chỗ Trống' }, theme: 'art-experiment',
    scenes: [
      { en: 'At {place}, Miu designs pretend stamps, but their pictures overlap into one large blob.', vi: 'Ở {place}, Miu thiết kế dấu in, nhưng các hình chồng thành một mảng lớn.' },
      { en: 'Pip tries a smaller stamp and notices the pictures still touch.', vi: 'Pip thử dấu nhỏ hơn, rồi thấy các hình vẫn chạm nhau.' },
      { en: 'They leave a gap between stamps and mark the first row with {clue}.', vi: 'Cả hai chừa khoảng giữa các dấu, rồi dùng {clue} đánh dấu hàng đầu.' },
      { en: 'Each tiny print has room to show, making a patterned border for their storybook.', vi: 'Mỗi hình in nhỏ đều hiện rõ, tạo thành viền họa tiết cho sách truyện.' },
    ],
  },
  {
    id: 'lost-lid', title: { en: 'The Lid That Belonged Elsewhere', vi: 'Chiếc Nắp Thuộc Về Hộp Khác' }, theme: 'comparing-evidence',
    scenes: [
      { en: 'At {place}, Miu finds a round paper lid, but it will not fit the button box.', vi: 'Ở {place}, Miu thấy nắp giấy tròn, nhưng nó không vừa hộp cúc.' },
      { en: 'Pip compares three toy boxes and spots one with the same wavy edge.', vi: 'Pip so ba hộp đồ chơi, rồi thấy một hộp có viền lượn sóng giống hệt.' },
      { en: 'They test the match and place {clue} beside the button box instead.', vi: 'Cả hai thử ghép nắp, rồi đặt {clue} cạnh hộp cúc để làm dấu.' },
      { en: 'The lid fits its wavy box, and Miu makes a new square lid for the buttons.', vi: 'Nắp vừa hộp lượn sóng, còn Miu làm nắp vuông mới cho những chiếc cúc.' },
    ],
  },
  {
    id: 'long-name-sign', title: { en: 'The Sign With a Long Name', vi: 'Tấm Biển Có Tên Thật Dài' }, theme: 'layout-and-language',
    scenes: [
      { en: 'At {place}, Miu names a pretend shop, but the last word slips off its sign.', vi: 'Ở {place}, Miu đặt tên cửa tiệm, nhưng từ cuối vượt khỏi tấm biển giấy.' },
      { en: 'Pip squeezes the letters until none of the words look clear.', vi: 'Pip ép các chữ sát nhau, khiến chẳng từ nào còn rõ.' },
      { en: 'They put the name on two lines and add {clue} below it.', vi: 'Cả hai viết tên thành hai dòng, rồi thêm {clue} bên dưới.' },
      { en: 'The whole name fits, and the pretend shop opens with a wonderfully readable sign.', vi: 'Cả tên đã vừa chỗ, và tiệm tưởng tượng mở cửa với tấm biển thật dễ đọc.' },
    ],
  },
  {
    id: 'gentle-dominoes', title: { en: 'The Dominoes That Stopped Early', vi: 'Hàng Quân Đổ Dừng Giữa Chừng' }, theme: 'spacing',
    scenes: [
      { en: 'At {place}, Miu lines up pretend dominoes, but the little chain stops halfway.', vi: 'Ở {place}, Miu xếp hàng quân đổ, nhưng cả chuỗi dừng giữa chừng.' },
      { en: 'Pip spots a wide gap where two paper tiles cannot reach each other.', vi: 'Pip thấy khoảng hở rộng, khiến hai quân giấy không chạm được nhau.' },
      { en: 'They even out the gaps and place {clue} beside the finish mark.', vi: 'Cả hai chỉnh khoảng cách đều nhau, rồi đặt {clue} cạnh vạch cuối.' },
      { en: 'The tiny chain reaches the last tile, which reveals a smiling paper flower.', vi: 'Chuỗi nhỏ đến được quân cuối, để lộ một bông hoa giấy mỉm cười.' },
    ],
  },
  {
    id: 'mixed-weather-theatre', title: { en: 'The Weather in a Shoebox', vi: 'Thời Tiết Trong Hộp Giày' }, theme: 'pretend-worlds',
    scenes: [
      { en: 'At {place}, Miu builds a shoebox theatre where paper sun and rain appear together.', vi: 'Ở {place}, Miu dựng rạp hộp giày, nơi nắng và mưa giấy cùng xuất hiện.' },
      { en: 'Pip makes separate sky cards, but their puppet wants both for its garden scene.', vi: 'Pip làm thẻ trời riêng, nhưng bạn rối cần cả hai cho cảnh khu vườn.' },
      { en: 'They draw a pretend rainbow and put {clue} at the garden gate.', vi: 'Cả hai vẽ cầu vồng tưởng tượng, rồi đặt {clue} nơi cổng vườn.' },
      { en: 'The garden play ends beneath a paper rainbow, with every cloud safely inside the shoebox.', vi: 'Vở vườn kết thúc dưới cầu vồng giấy, mọi đám mây đều nằm gọn trong hộp giày.' },
    ],
  },
  {
    id: 'cushion-compass', title: { en: 'The Compass With Picture Points', vi: 'Chiếc La Bàn Chỉ Bằng Tranh' }, theme: 'relative-position',
    scenes: [
      { en: 'At {place}, Miu makes a pretend compass, but its arrow keeps pointing at Pip.', vi: 'Ở {place}, Miu làm la bàn, nhưng mũi tên cứ chỉ về phía Pip.' },
      { en: 'Pip moves around the map, making the direction change every time.', vi: 'Pip đi quanh bản đồ, khiến hướng chỉ đổi theo mỗi lần.' },
      { en: 'They draw fixed picture points and set {clue} beside the starting arrow.', vi: 'Cả hai vẽ các mốc tranh cố định, rồi đặt {clue} cạnh mũi tên bắt đầu.' },
      { en: 'Miu follows the book symbol to the reading nook, even when Pip changes seats.', vi: 'Miu theo hình sách đến góc đọc, dù Pip có đổi chỗ ngồi.' },
    ],
  },
  {
    id: 'paper-dance-floor', title: { en: 'The Dance With a Resting Spot', vi: 'Điệu Nhảy Có Chỗ Nghỉ' }, theme: 'different-needs',
    scenes: [
      { en: 'At {place}, Miu draws a dance floor, but one toy wants to watch before joining.', vi: 'Ở {place}, Miu vẽ sàn nhảy, nhưng một bạn đồ chơi muốn xem trước khi tham gia.' },
      { en: 'Pip makes every square a dancing square, leaving no place to sit.', vi: 'Pip biến mọi ô thành ô nhảy, chẳng còn chỗ nào để ngồi.' },
      { en: 'They add a quiet bench and put {clue} beside its welcome card.', vi: 'Cả hai thêm ghế yên tĩnh, rồi đặt {clue} cạnh thẻ chào mừng.' },
      { en: 'Some toys dance while others watch, and the pretend music has room for everyone.', vi: 'Có bạn nhảy, có bạn xem, và âm nhạc tưởng tượng có chỗ cho tất cả.' },
    ],
  },
  {
    id: 'paper-bridge-arch', title: { en: 'The Bridge With a Space Below', vi: 'Chiếc Cầu Có Khoảng Trống Bên Dưới' }, theme: 'structures',
    scenes: [
      { en: 'At {place}, Miu builds a paper bridge, but a toy boat cannot fit underneath.', vi: 'Ở {place}, Miu dựng cầu giấy, nhưng thuyền đồ chơi không chui lọt bên dưới.' },
      { en: 'Pip shortens the boat sail, though its cabin still touches the flat bridge.', vi: 'Pip làm buồm thấp hơn, nhưng khoang thuyền vẫn chạm mặt cầu phẳng.' },
      { en: 'They fold a broad arch and set {clue} beside the bridge entrance.', vi: 'Cả hai gấp vòm cầu rộng, rồi đặt {clue} cạnh lối lên cầu.' },
      { en: 'The boat passes through the paper arch while a toy walker crosses above.', vi: 'Thuyền đi qua vòm giấy, trong khi bạn đồ chơi bước qua phía trên.' },
    ],
  },
];
