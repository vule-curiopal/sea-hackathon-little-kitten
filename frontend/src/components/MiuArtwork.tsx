// Generated from the original design by tools/sync-artwork.mjs.
import { useId } from 'react';
import { getMiuPose, type Emotion } from '../lib/miu-pose';
import type { CatActivity } from '../lib/miu-behavior';
import type { Point } from '../lib/miu-touch';

export default function MiuArtwork({ emotion, activity, gaze, label }: { emotion: Emotion; activity?: CatActivity; gaze?: Point; label: string }) {
  const id = useId().replaceAll(':', '');
  const pose = getMiuPose(emotion, activity, gaze);
  return (<svg viewBox="0 0 400 440" width="100%" height="100%" role="img" aria-label={label}>
<defs>
<radialGradient id={id + '-miuFur'} cx="38%" cy="28%" r="80%">
<stop offset="0" stopColor="#C9DAFF"></stop>
<stop offset="0.55" stopColor="#8FB2FF"></stop>
<stop offset="1" stopColor="#6A90EE"></stop>
</radialGradient>
<radialGradient id={id + '-miuCream'} cx="40%" cy="30%" r="80%">
<stop offset="0" stopColor="#FFFFFF"></stop>
<stop offset="1" stopColor="#E1E9F7"></stop>
</radialGradient>
<radialGradient id={id + '-miuIris'} cx="40%" cy="35%" r="70%">
<stop offset="0" stopColor="#9DBBFF"></stop>
<stop offset="0.6" stopColor="#2F6BFF"></stop>
<stop offset="1" stopColor="#1A56C4"></stop>
</radialGradient>
<radialGradient id={id + '-miuBtn'} cx="40%" cy="35%" r="70%">
<stop offset="0" stopColor="#9DBBFF"></stop>
<stop offset="1" stopColor="#2F6BFF"></stop>
</radialGradient>
</defs>

<ellipse cx="200" cy="420" rx="124" ry="14" fill="#0B1220" opacity="0.12"></ellipse>

<g className="miu-body">
<g className="miu-tail">

<path d="M262 382 C 340 394 382 332 352 272" fill="none" stroke="#7FA4F5" strokeWidth="28" strokeLinecap="round"></path>
<circle cx="352" cy="272" r="15" fill={'url(#' + id + '-miuCream)'}></circle>
</g>

<path d="M200 245 C 270 245 300 300 300 350 C 300 395 262 412 200 412 C 138 412 100 395 100 350 C 100 300 130 245 200 245 Z" fill={'url(#' + id + '-miuFur)'}></path>
<ellipse cx="200" cy="356" rx="64" ry="50" fill={'url(#' + id + '-miuCream)'}></ellipse>
<circle cx="200" cy="354" className="miu-glow" r="28" fill="#9DBBFF" opacity={pose.btnGlow}></circle>
<circle cx="200" cy="354" r="19" fill={'url(#' + id + '-miuBtn)'}></circle>
<ellipse cx="194" cy="346" rx="7" ry="4" fill="#FFFFFF" opacity="0.8"></ellipse>

<ellipse cx="160" cy="404" rx="36" ry="19" fill={'url(#' + id + '-miuFur)'}></ellipse>
<ellipse cx="240" cy="404" rx="36" ry="19" fill={'url(#' + id + '-miuFur)'}></ellipse>
<ellipse cx="160" cy="408" rx="13" ry="7" fill="#F8E1DE"></ellipse>
<ellipse cx="240" cy="408" rx="13" ry="7" fill="#F8E1DE"></ellipse>

<g className="miu-head">
<g className="miu-ear-left" transform={pose.earL}>
<path d="M92 142 C 80 96 82 56 96 30 C 126 44 152 70 166 92 Z" fill={'url(#' + id + '-miuFur)'}></path>
<path d="M106 124 C 100 94 102 68 110 52 C 128 64 142 78 150 96 Z" fill="#F8E1DE"></path>
</g>
<g className="miu-ear-right" transform={pose.earR}>
<path d="M308 142 C 320 96 318 56 304 30 C 274 44 248 70 234 92 Z" fill={'url(#' + id + '-miuFur)'}></path>
<path d="M294 124 C 300 94 298 68 290 52 C 272 64 258 78 250 96 Z" fill="#F8E1DE"></path>
</g>

<path d="M200 78 C 285 78 335 125 335 180 C 335 205 325 222 312 232 L 322 244 L 300 242 C 275 258 240 266 200 266 C 160 266 125 258 100 242 L 78 244 L 88 232 C 75 222 65 205 65 180 C 65 125 115 78 200 78 Z" fill={'url(#' + id + '-miuFur)'}></path>
<path d="M192 80 C 193 94 196 100 200 104 C 204 100 207 94 208 80 Z" fill="#5B8CFF" opacity="0.75"></path>
<path d="M168 84 C 170 96 174 101 180 103 C 180 94 178 88 176 83 Z" fill="#5B8CFF" opacity="0.75"></path>
<path d="M232 84 C 230 96 226 101 220 103 C 220 94 222 88 224 83 Z" fill="#5B8CFF" opacity="0.75"></path>

<path d="M200 205 C 225 196 256 205 258 228 C 260 248 236 258 200 252 C 164 258 140 248 142 228 C 144 205 175 196 200 205 Z" fill={'url(#' + id + '-miuCream)'}></path>
<g className="miu-puffed-cheeks" opacity={pose.puff}><ellipse cx="91" cy="219" rx="28" ry="20" fill={'url(#' + id + '-miuFur)'}></ellipse><ellipse cx="309" cy="219" rx="28" ry="20" fill={'url(#' + id + '-miuFur)'}></ellipse></g>
<ellipse cx="112" cy="214" rx={pose.cheekRx} ry={pose.cheekRy} fill="#F7A8B4" opacity={pose.blush}></ellipse>
<ellipse cx="288" cy="214" rx={pose.cheekRx} ry={pose.cheekRy} fill="#F7A8B4" opacity={pose.blush}></ellipse>

<g className="miu-eye" opacity={pose.openL}>
<ellipse cx="152" cy="168" rx={pose.rx} ry={pose.ry} fill="#FFFFFF"></ellipse>
<circle cx={pose.irisLx} cy={pose.irisY} r="24" fill={'url(#' + id + '-miuIris)'}></circle>
<circle cx={pose.irisLx} cy={pose.irisY} r={pose.pupil} fill="#0B1220"></circle>
<circle cx={pose.hiLx} cy={pose.hiY} r="7" fill="#FFFFFF"></circle>
<circle cx={pose.hi2Lx} cy={pose.hi2Y} r="3.5" fill="#FFFFFF"></circle>
</g>
<g className="miu-eye" opacity={pose.openR}>
<ellipse cx="248" cy="168" rx={pose.rx} ry={pose.ry} fill="#FFFFFF"></ellipse>
<circle cx={pose.irisRx} cy={pose.irisY} r="24" fill={'url(#' + id + '-miuIris)'}></circle>
<circle cx={pose.irisRx} cy={pose.irisY} r={pose.pupil} fill="#0B1220"></circle>
<circle cx={pose.hiRx} cy={pose.hiY} r="7" fill="#FFFFFF"></circle>
<circle cx={pose.hi2Rx} cy={pose.hi2Y} r="3.5" fill="#FFFFFF"></circle>
</g>
<path d="M124 176 Q 152 140 180 176" fill="none" stroke="#0B1220" strokeWidth="8" strokeLinecap="round" opacity={pose.happyL}></path>
<path d="M220 176 Q 248 140 276 176" fill="none" stroke="#0B1220" strokeWidth="8" strokeLinecap="round" opacity={pose.happyR}></path>
<path d="M124 166 Q 152 190 180 166" fill="none" stroke="#0B1220" strokeWidth="8" strokeLinecap="round" opacity={pose.closed}></path>
<path d="M220 166 Q 248 190 276 166" fill="none" stroke="#0B1220" strokeWidth="8" strokeLinecap="round" opacity={pose.closed}></path>
<path d="M152 196 C 112 170 118 136 139 138 C 146 139 150 144 152 150 C 154 144 158 139 165 138 C 186 136 192 170 152 196 Z" fill="#EF5B6E" opacity={pose.heart}></path>
<path d="M248 196 C 208 170 214 136 235 138 C 242 139 246 144 248 150 C 250 144 254 139 261 138 C 282 136 288 170 248 196 Z" fill="#EF5B6E" opacity={pose.heart}></path>
<path d="M126 206 C 118 220 120 230 127 230 C 134 230 136 220 126 206 Z" fill="#E3ECFF" stroke="#2F6BFF" strokeWidth="2" opacity={pose.tear}></path>

<path d={pose.browL} fill="none" stroke="#1A56C4" strokeWidth="7" strokeLinecap="round" opacity="0.85"></path>
<path d={pose.browR} fill="none" stroke="#1A56C4" strokeWidth="7" strokeLinecap="round" opacity="0.85"></path>

<path d="M146 226 L 104 220 M146 236 L 102 241 M254 226 L 296 220 M254 236 L 298 241" fill="none" stroke="#FFFFFF" strokeWidth="3" strokeLinecap="round" opacity="0.9"></path>
<path d="M200 219 L 200 226" fill="none" stroke="#0B1220" strokeWidth="4.5" strokeLinecap="round"></path>
<path d={pose.mouthLine} fill="none" stroke="#0B1220" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round" opacity={pose.lineOp}></path>
<path className="miu-mouth" d={pose.mouthFill} fill="#0B1220" opacity={pose.fillOp}></path>
<ellipse cx="200" cy={pose.tongueY} rx="12" ry="6" fill="#F7A8B4" opacity={pose.tongue}></ellipse>
<path d="M188 207 C 188 201 212 201 212 207 C 212 213 205 219 200 219 C 195 219 188 213 188 207 Z" fill="#0B1220"></path>
<ellipse cx="195" cy="206" rx="4" ry="2" fill="#FFFFFF" opacity="0.7"></ellipse>

</g>
<path d="M140 266 Q 200 290 260 266 L 258 279 Q 200 303 142 279 Z" fill="#2F6BFF"></path>
<circle cx="200" cy="296" r="11" fill="#E3A548" stroke="#8F5A0F" strokeWidth="2"></circle>

<g className="miu-paw-left" transform={pose.armL}>
<ellipse cx="132" cy="318" rx="21" ry="34" fill={'url(#' + id + '-miuFur)'} stroke="#6A90EE" strokeWidth="2"></ellipse>
<circle cx="132" cy="347" r="15" fill={'url(#' + id + '-miuCream)'}></circle>
</g>
<g className="miu-paw-right" transform={pose.armR}>
<ellipse cx="268" cy="318" rx="21" ry="34" fill={'url(#' + id + '-miuFur)'} stroke="#6A90EE" strokeWidth="2"></ellipse>
<circle cx="268" cy="347" r="15" fill={'url(#' + id + '-miuCream)'}></circle>
</g>
</g>

<g fill="#E3A548" opacity={pose.sparkle}>
<path d="M58 70 Q 58 88 76 88 Q 58 88 58 106 Q 58 88 40 88 Q 58 88 58 70 Z"></path>
<path d="M346 48 Q 346 62 360 62 Q 346 62 346 76 Q 346 62 332 62 Q 346 62 346 48 Z"></path>
<path d="M362 170 Q 362 180 372 180 Q 362 180 362 190 Q 362 180 352 180 Q 362 180 362 170 Z"></path>
</g>
<path d="M336 96 C 316 82 318 64 330 65 C 334 65 336 68 336 71 C 337 68 339 65 343 65 C 355 64 357 82 336 96 Z" fill="#EF5B6E" opacity={pose.love}></path>
<text x="316" y="100" fontSize="58" fontWeight="800" fill="#2F6BFF" opacity={pose.question}>?</text>
<g className="miu-sleep-marks" fill="#1A56C4" fontWeight="800" opacity={pose.zzz}>
<text x="300" y="98" fontSize="30">z</text>
<text x="322" y="72" fontSize="40">z</text>
<text x="348" y="40" fontSize="50">Z</text>
</g>
<g fill="#FFFFFF" stroke="#C9D6EA" strokeWidth="3" opacity={pose.dots}>
<circle cx="304" cy="96" r="7"></circle>
<circle cx="324" cy="76" r="10"></circle>
<circle cx="350" cy="52" r="14"></circle>
</g>
<path d="M54 104 Q 40 124 54 144 M36 94 Q 16 124 36 154" fill="none" stroke="#2F6BFF" strokeWidth="6" strokeLinecap="round" opacity={pose.waves}></path>
</svg>);
}
