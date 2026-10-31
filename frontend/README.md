# Little Buddy frontend

Responsive React and TypeScript implementation of the Miu design, built with Vite.

## Run locally

Use Node.js 22.19 or later. Install the root workspace and start the voice API in one terminal:

```sh
npm ci
npm run dev
```

In a second terminal, install and start the frontend:

```sh
cd frontend
npm ci
npm run dev
```

Open `http://localhost:5173`. On Windows PowerShell, use `npm.cmd` if script execution is restricted. The frontend's predev/prebuild scripts compile the shared packages. Vite proxies `/api` to `http://127.0.0.1:3001` in development and preview.

The integrated application uses the real character and memory provider. Load provider credentials only in the server environment, as described in [the backend README](../backend/README.md). The frontend never receives provider keys. The standalone voice pipeline can still be used for development; its provider mode is displayed explicitly. MP4/WebM capture and real MP3 output require `ffprobe` on the server PATH or `FFPROBE_PATH`.

For an iPhone or iPad on the same Wi-Fi, open the **Wi-Fi Network URL** printed by Vite. For example, `http://192.168.x.x:5173`. Do not use the computer's `localhost` address on another device. Keep the development server running while you try the app. Typed messages work over local HTTP when the backend is connected. Microphone input on another device requires HTTPS and browser support; `localhost` is only treated as secure on the computer itself.

## Screens

| Path | Screen |
| --- | --- |
| `/` | Landing page, expression picker, FAQ |
| `/register` | Frontend registration preview with username and password validation |
| `/login` | Sign-in form with validation |
| `/app/talk` | Miu's interactive room |
| `/demo/miu?lang=en` | Direct, no-sign-in room with the prepared demo buddy |
| `/presentation` | Four-slide Meet Miu pitch, using the supplied PowerPoint artwork and copy |

The presentation shares the app's Baloo 2 headings, Nunito body text, colour tokens, room illustrations, rounded cards and tactile controls, including dark-mode colours. It supports Previous/Next, arrow keys, Page Up/Down, Space, Home/End, touch swipes, an overview, and fullscreen with **Present** or **F**. Direct links such as `/presentation#slide-3` open a particular slide. **Notes** contains concise Vietnamese and English pitch scripts without references. Its **VI / EN** button switches only the notes language, defaults to Vietnamese, and remembers the choice across slides, closing/reopening and page reloads when browser storage is available. **Download PowerPoint** returns the source deck at `src/pages/slide/Meet Miu.pptx`.

The demo slide embeds the supplied [YouTube video](https://www.youtube.com/watch?v=yMPZn1eiUbA), with playback controls and fullscreen. The player loads only on slide 3 and is removed when leaving that slide to stop playback; returning shows it from the start. **Watch on YouTube** opens the source video separately. **Use local video** plays a local recording through native browser controls, without uploading it; **Use YouTube video** restores the embedded demo. Local playback pauses when moving to another slide. The recording is held only for the current page visit and must be selected again after reload. The page also links to the existing live demo room. On narrow portrait screens, the slides reflow for readable text.

Every slide includes a compact QR in its top-right corner, without visible labels or URL text, also visible in fullscreen. It links to `/presentation` using the current website origin, so a cloud deployment automatically uses its own domain. When opened on `localhost` in Vite development, it resolves the presenter's Wi-Fi address automatically. Attendees must join the same network for a local link. QR codes are generated locally with a four-module quiet zone and fixed dark-on-white contrast.

The downloadable PowerPoint matches the current four-slide design, including embedded Baloo 2/Nunito fonts, the three future improvements, and a native online YouTube player on slide 3. Online playback requires Internet and a PowerPoint version that supports online video; **Watch on YouTube** provides a fallback. Its QR codes use the fixed URL `https://miu.curiopal.com/presentation`, as a PPTX cannot derive a browser origin at runtime.

Presentation artwork lives under `public/presentation-assets`, so static hosting does not confuse the `/presentation` route with an asset directory.

The room supports petting, pause/wake, starting a new session, Vietnamese/English switching, typed and voice messages through the shared character and memory engine and `@miu/voice-client`. The conversation shows both the user's messages and Miu's replies. Text history is saved in localStorage under `miu.conversations.v1`, separately for An and Bình, with up to 200 recent messages per profile. Typed messages appear immediately; submitted voice messages display "Sending your voice message" until the response arrives. Live transcripts replace that progress label; reference/demo replies explain that the user's speech is not transcribed. A turn without returned text or a reference reply displays the missing-transcript message. These distinctions apply in both the room and history, including old saved entries. Uncertain transcripts are labeled, and fake fixtures never stand in for the user's words. Audio recordings are not saved in this history; they go to the configured voice server and, in real mode, its speech providers. If device storage is blocked or full, the panel explains that messages will only remain for the current visit. Language, profile, and read-aloud preferences are also stored on the device. Demo tokens are never persisted.

Reloading restores history in the ready state without microphone capture or replaying saved replies. Switching languages, selecting a voice, reconnecting, and switching profiles preserve saved messages. **New conversation** deletes both sides of the active profile's saved history on this device. Stored history is a frontend transcript; it is not supplied as model memory or synchronized between devices. Server-requested replay invalidation and demo-day rollover clear local captions as well. Settings retain the server's personality, role and voice choices, and the Adult demo panel remains available for memory and Next day controls.

The main room shows the latest sent user sentence above Miu's reply, with separate speaker labels. The sentence remains visible while Miu thinks and speaks and after the reply finishes or history is restored. Reply captions and conversation history are independent of audio playback, including when playback is blocked. Opening the panel to read a pending reply keeps that request running; Stop remains available in the panel. Each pending reply has a frontend request ID so connection setup and stale voice completions cannot discard a typed answer or replace a newer reply. Stop, pause, and a new conversation still invalidate pending responses. New replies scroll into view when the panel is closed, respecting reduced-motion preferences; the open panel scrolls to the start of the latest grouped exchange so the user's sentence is not pushed above the viewport by a long reply.

## Keeping company with Miu

Miu begins breathing, blinking, and gently moving its tail as soon as the room opens. After 4.5–7 quiet seconds, Miu independently chooses little activities: looking around, ear flicks, paw grooming, stretching, playing with yarn, and having a pretend fish snack. A shuffled bag randomizes the order and quiet pauses, includes both snack and play, and avoids repeating the same activity consecutively. Miu brings its own snack to its mouth; the child never needs to feed it or authorize its activities. After 82 seconds Miu becomes drowsy, settling into a catnap at 90 seconds. Touch a dozing Miu to wake it with a stretch. Petting Miu directly gives a visual purr and affectionate expression, with no separate pet or play buttons.

**Let Miu rest** explicitly pauses conversation, cancels pending replies and speech, turns off the microphone, and keeps Miu asleep until touched or **Wake Miu** is selected. Waking by touch or Wake does not enable the microphone; deliberately pressing Talk wakes Miu and begins one recording. Idle actions run without network or model calls, yield to listening/thinking/speaking, and stop scheduling while the tab is hidden. The engine’s comfort state suppresses lively idle actions, purring, giggling, and toy play. Reduced-motion preferences keep the poses and readable activity cues without repeated animation. Activity captions are available in Vietnamese and English and do not repeatedly announce themselves to screen readers.

Miu also has a gentle **Dỗi nhẹ / A little pout** expression: puffy cheeks, pursed lips, a sideways glance, relaxed brows, and folded paws. Occasionally, a yarn-playing moment ends with this 2.4-second pretend disappointment before Miu settles on its own. It is never triggered by the child's absence or withheld care. Petting still gives the usual affectionate response, and comfort, conversation, and rest override the pout. The expression is also available in the landing page's fifteen-expression picker.

### Daily mood and emotion strength

Each fictional profile has a local-day mood with separate happiness, curiosity, calm, affection, sadness, sleepiness, and light-pouting levels. The generated baseline is saved on this device and reused on reload. The next local calendar day selects a fresh baseline; midnight, returning to the tab, and regaining focus refresh it. Changing profiles isolates both mood and conversational context. There is no absence penalty or need to pet, feed, or play to maintain a mood.

Application rules combine the daily baseline with each typed turn or clear live transcript to choose Miu's immediate expression and intensity. Emotion levels appear through the rendered kitten itself; the room and landing preview have no numeric readouts, meters, or emotion-level panels. All fifteen expressions vary through eye openness, brow shape, mouth width and height, blush, cheek puffing, ear and paw positions, head lean, and restrained body and tail movement. Mild happiness uses open eyes and a small closed smile, while strong happiness has smiling eyes and a broad grin. Mild sadness has a subtle frown without tears; a stronger pose has more drooped ears and visible tears. A light pout has smaller cheeks and less head turning than a full pout. Direct touch gestures retain their full reach, sleeping Miu keeps closed eyes, and reduced-motion mode keeps the graded static poses. Daily energy also changes quiet pauses between independent activities, and its light-pouting level adjusts the chance of a brief yarn pout. Listening, thinking, rest, and the child's expressed need for comfort take priority. Explicit corrections such as “I'm not sad” or “Mình không còn buồn nữa” immediately end the comfort override.

Ordinary turn expressions return to the daily baseline after 18 seconds, without expiring during recording, processing, or speech. Comfort persists until a new explicit context or a new conversation. Mood storage contains only Miu's generated daily baseline, with no child emotion score; message text is stored separately in the local conversation history described above. A new conversation clears messages and transient affect while retaining today's mood. Reference recordings and uncertain transcripts never determine the child's emotional context. The voice backend and generated reply wording are unchanged; this policy controls Miu's presentation in the frontend.

### Direct touch and toys

Touch Miu directly with a finger, Apple Pencil, or mouse. Stroke the head to purr, tap the nose for a boop, rub the belly for giggles, tap a paw for a high-five, or hold gently for 650 milliseconds to cuddle. Both the automatically dozing and explicitly resting kitten can be woken by a direct touch. Drag the yarn and Miu watches it; drag the fish to Miu's face to offer a pretend snack. Tapping either toy is an alternative to dragging. There are no hunger or affection meters.

For play gestures, pointer capture and `touch-action: none` apply to Miu and the two toys, so vertical strokes are handled as petting while the surrounding page keeps normal scrolling and zoom. The hold-to-talk button has its own pointer capture behavior described below. Long-press selection/callouts are suppressed on these surfaces. Hit regions use SVG coordinates and scale with the character on phones and tablets. Extra fingers are ignored; pointer cancellation, lost capture, hidden tabs, and conversation transitions clear held gestures and dragged toys. Pointer responses do not depend on a synthesized click. Keyboard and screen-reader actions remain available directly through the character and toys. Interaction descriptions are provided to screen readers without a visible instruction guide or separate pet/play buttons.

The implementation targets the same Safari 16.4+ baseline as the frontend. Desktop Chrome direct nose taps and head strokes were verified. Real iPhone/iPad Safari verification remains outstanding; the automated geometry tests cover phone, tablet, and desktop character sizes.

## Ready-to-scan demo

Open `/app/talk` on the presenting laptop. The QR hangs on the wall inside Miu's room, next to the window. The room retains its full responsive layout. Attendees can scan immediately while you talk with Miu.

The typing-demo buddy is Miu: **ENFP, friend, curious, playful, imaginative**. Its greeting, sample responses, default read-aloud setting, and device speech delivery use the preset in `src/lib/demo-buddy.ts`. The voice backend does not implement that personality yet. Scanning opens `/demo/miu` directly, without account forms. Language is carried in the link. Each device has its own saved conversation history. Voice uses the server's two shared fictional profiles, An and Bình; opening the same profile elsewhere closes its previous session, so this voice prototype does not support an independent voice session for every attendee.

For local demos, attendees must join the laptop's Wi-Fi. When the presenter opens `localhost`, Vite supplies the preferred LAN address through its development-only `/__demo/network` endpoint. Microphones on phones require HTTPS; local HTTP can use typed messages against the connected backend.

Generate a reusable local QR file at `public/demo-qr.svg`:

```sh
npm run demo:qr
```

Regenerate it when the laptop's Wi-Fi address changes. The QR on the Talk screen resolves the current address automatically on page load, independently of this exported file.

For a published, publicly accessible HTTPS demo, set `VITE_DEMO_PUBLIC_URL` to its origin before starting or building the frontend. A QR link cannot bypass a hosting provider's private access gate. A public deployment is a separate choice from running the demo locally.

```sh
npm run demo:qr -- https://your-demo.example en
```

QR codes are generated locally with a four-module quiet zone and fixed dark-on-light contrast. Tests use an independent QR decoder to verify both local and HTTPS links in English and Vietnamese.

## Responsive behavior

- Phones: stacked landing page, full-width room, conversation in a keyboard-accessible bottom sheet.
- Tablets: two-column account layout, larger room and character. At 900px and above, an opened conversation panel sits beside Miu.
- Both orientations can scroll naturally on short viewports. Speech bubbles and Miu stay in document flow, including longer Vietnamese answers.
- Safe-area spacing, 16px form inputs to prevent iOS focus zoom, touch targets of at least 44px, system dark mode, and reduced-motion support.

The build targets Safari 16.4 and later. Actual iPhone/iPad Safari verification is still needed; native browser automation was stopped during this implementation.

## Demo and backend boundary

Voice is connected to the Express batch pipeline through `src/lib/usePipelineVoice.ts` and the shared `@miu/voice-client`. Hold the Talk button to record, then release to finalize and send exactly one conversation turn. Silence while holding never submits or cancels the question. The frontend selects `capture.endpointing: 'manual'`; automatic endpointing remains available to other clients. A 30-second recording limit cancels a held recording with an explicit retry message instead of uploading without release. Opening the room, restoring history, typing, petting, waking, and finishing playback never start listening. The button owns a frontend request ID before recording events are accepted. Microphone tracks close after capture is finalized and on rest, navigation, hidden tabs, settings, and configuration changes. No browser speech-recognition service is used by the room.

The hold button uses pointer capture for mouse, touch, and pen, so releasing outside the button still sends the same turn. Extra pointers, repeated keydown events, and synthesized clicks do not create extra turns. Holding Space or Enter and releasing has the same behavior; screen-reader activation provides an activate-to-start/activate-again-to-send equivalent. Pointer cancellation, lost capture before release, focus loss, and hidden tabs discard the recording. The button shows Wait while microphone startup is pending and Speak now only when the actual recorder is ready. Releasing before readiness cancels the attempt and shows a retry hint; a late-granted stream is immediately closed without starting a recorder. The microphone is disabled while Miu processes or speaks, so tapping it cannot cancel an answer in progress. The dedicated Stop control discards a recording or cancels processing/playback. The controller's current state also guards a new hold against stale render state. Physical iPhone/iPad verification remains outstanding.

The client uploads actual audio/MIME to the canonical multipart turn route, rejects stale responses, plays returned audio, and sends playback receipts from media events. Blocked autoplay exposes an explicit Play answer action. Reconnecting, starting fresh, switching language, changing profile or selecting a voice cancels pending requests and recreates/configures the voice session. Starting fresh or a server replay invalidation clears the active profile's saved history. Settings offer the five approved voices filtered by language, and fictional profiles An/Bình. Stop/cancellation failures remain visible without restarting the microphone.

The visible mode comes from the server. The integrated `character_memory` response supplies approved presentation, expression, and memory metadata. The kitten maps those expressions to its existing artwork. Its mouth opening comes from an analyser attached to approved reply playback, never from microphone levels. Browser autoplay rejection exposes a **Play answer** action; actual media events send started/completed/interrupted playback receipts.

Typed messages use the same session coordinator and server endpoint as microphone turns. By default, typed answers use approved server TTS. Turning off **Read answers aloud** requests `audio:null`: after reading the visible answer, explicitly select **Done reading** to finish the turn. This sends text-delivery receipts with `played_ms:0`, and never claims audible playback. Stop discards a pending text delivery. Saved memories and story progress commit only after the appropriate delivery completion. A deletion response, including deletion followed by a provider failure, clears old captions and cached reply metadata.

The standalone voice pipeline’s fake mode remains a frontend/pipeline development option. It is labeled reference audio and never counts as evidence of character, memory, or model quality. No local sample-reply or browser speech-synthesis path is used by the room. Registration at `/register` is a frontend-only preview with username and password validation. Valid submission clears the form and opens the guest demo in the selected language, without creating an account. Sign-in remains a visual demonstration. Username and password values are not persisted or sent.

Production can serve `frontend/dist` from the integrated Express app. Otherwise route `/api` to that backend, or build with `VITE_VOICE_API_URL` and configure the allowed HTTPS origin. Keep provider secrets server-side. The previous static Sites deployment cannot host the Node/Express service by itself; it needs a reachable API.

## Checks and production output

Open the browser developer console and filter for `[Miu voice]` to follow a voice turn. Logs include `hold.start`, capture states, a microphone-level summary at most once per second, `hold.release`, `capture.send`, HTTP status/duration, `turn.received` with transcript availability and STT/reply/TTS timings, playback states, and technical error codes. `capture.send` reports whether releasing finalized a recording; releasing before permission is ready reports `accepted: false`. `capture.complete` reports the finalized container, byte count, recorded duration, sample rate, channel count, and highest measured input level. A null input level means metering was unavailable; an energy level alone does not establish recognized speech. The diagnostic logger projects technical metadata only, excluding transcripts, reply words, memories, audio contents, device IDs, authorization headers, and session tokens. Logs remain in the browser console and are not sent to a logging service.

`unclear_audio` (422) means transcription produced no usable words and asks for a new held recording. Provider failures, including `provider_quota_exceeded`, show a service-unavailable message instead of implying that reconnecting or typing will fix the provider. Neither case automatically re-records or re-uploads a child's audio. An aborted fetch is logged as `canceled`, while an actual transport failure is logged as `network_error`.

A `401`, `session_closed`, or `session_not_found` invalidates the rejected client session. The frontend logs `session.expired` and reconnects once for a previously connected client, without retrying the audio or reopening the microphone. The child must hold Talk again after the connection is ready. An authentication failure during initial connection remains visible instead of causing a reconnect loop. Async errors from disposed clients cannot invalidate their replacements. Deployment restarts and opening the same shared fictional profile in another browser can invalidate an earlier session.

```sh
npm test
npm run build
npm run preview
```

`build` runs TypeScript checks and emits `dist/`. Production hosting must serve `index.html` for application paths such as `/app/talk` to support direct links and refreshes. Google Fonts provides Baloo 2 and Nunito; system font fallbacks apply when fonts cannot load.

Offline unit checks cover account validation, pause/wake, stale replies while paused, conversation resets, language selection, both sides of typed/voice conversations, persistence across reloads, profile isolation, storage failure, missing/uncertain transcripts, all fifteen expressions, the gentle pout's distinct pose and automatic recovery, the idle-to-sleep routine, delayed activity timers, comfort behavior, conversation/rest precedence, touch geometry at phone/tablet/desktop sizes, held versus moving gestures, snack drop regions, toy bounds, and valid reaction/gaze poses.

## Design source

The original design remains in `../design/design`. `src/components/MiuArtwork.tsx` is generated from its single Miu SVG. Expression data is in `src/lib/miu-pose.ts`; styling uses the supplied design tokens.

After changing the original Miu SVG or tokens, run:

```sh
npm run sync:artwork
```

This refreshes the generated artwork and copies the design tokens into the frontend. Preserve the approved-playback mouth overlay when regenerating `MiuArtwork.tsx`. Application components, page styles, and translated copy live under `src/`.

## Self-hosted deployment

The frontend and Express API are served together at **https://miu.curiopal.com**. The direct demo is https://miu.curiopal.com/demo/miu?lang=vi. Nginx serves the built `dist/` with SPA fallback and proxies `/api` to the isolated voice service. The build sets `VITE_DEMO_PUBLIC_URL=https://miu.curiopal.com`; `VITE_VOICE_API_URL` is empty for same-origin requests. The UI displays the mode returned by the server; check `provider_mode` at https://miu.curiopal.com/api/health for the current runtime setting.

Deployment is manual, with versioned releases, health checks and rollback. See [deploy/miu](../deploy/miu/README.md) for commands and server paths. No GitHub webhook is configured. The separate Sites deployment below is preserved.

## Separate Sites deployment

The frontend is deployed privately at https://little-buddy-curiopal.gauzymacaw.chatgpt.site. The requested custom hostname is `little-buddy.curiopal.com`; it is registered with the hosting service and awaiting Cloudflare DNS verification.

The Site identity is retained in `.openai/hosting.json`. Its static configuration enables single-page application fallback, so direct visits to `/register`, `/login`, and `/app/talk` load the app.

The local deployment checkout is `../.site-deploy/little-buddy`, ignored by the main repository. It contains the exact built assets under `dist/` and a separate Git history for the hosting service. Application source remains here in `frontend/`. For an update, rebuild this frontend, refresh the deployment checkout's `dist/`, then use the Sites source workflow to push, package, and deploy the matching version. Do not create a second Site or replace the stored project ID.

In Cloudflare's `curiopal.com` DNS zone, add:

| Type | Name | Content |
| --- | --- | --- |
| CNAME | `little-buddy` | `custom-domains.chatgpt.site` |
| TXT | `_openai-site-verification.little-buddy` | `openai-site-verification=zrAaASjcBWHuiLwir9h127ZTkti1PHCcb561LfbXHKA` |
| TXT | `_cf-custom-hostname.little-buddy` | `b917d6b1-1f4d-4515-a539-09f56564d1d8` |

Use DNS-only mode for the CNAME and automatic TTL. These public verification records belong to this specific custom hostname. Once the records resolve, refresh the custom-domain status through Sites to confirm hostname and HTTPS activation. Hosting access is currently private; configuring DNS does not change the audience.
