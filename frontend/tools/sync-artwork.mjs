// Preserve the design's single SVG drawing. Pose data is maintained in miu-pose.ts.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, '../design/design/artboards/Miu.dc.html'), 'utf8');
let svg = source.match(/<svg[\s\S]*?<\/svg>/)[0];
svg = svg.replace(/<animateTransform[\s\S]*?<\/animateTransform>/g, '');
svg = svg.replace('aria-label="Miu the kitten, feeling {{emotion}}"', 'aria-label={label}');
svg = svg.replace(/="\{\{(\w+)\}\}"/g, '={pose.$1}');
for (const name of ['stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stop-color', 'font-size', 'font-weight']) {
  svg = svg.replaceAll(name, name.replace(/-([a-z])/g, (_, c) => c.toUpperCase()));
}
for (const name of ['miuFur', 'miuCream', 'miuIris', 'miuBtn']) {
  svg = svg.replaceAll(`id="${name}"`, `id={id + '-${name}'}`);
  svg = svg.replaceAll(`="url(#${name})"`, `={'url(#' + id + '-${name})'}`);
}
svg = svg.replace(/<g>\s*<g>/, '<g className="miu-body">\n<g className="miu-tail">');
svg = svg.replaceAll('<g opacity={pose.openL}>', '<g className="miu-eye" opacity={pose.openL}>').replaceAll('<g opacity={pose.openR}>', '<g className="miu-eye" opacity={pose.openR}>');
svg = svg.replace('<path d={pose.mouthFill}', '<path className="miu-mouth" d={pose.mouthFill}');
svg = svg.replace('r="28" fill="#9DBBFF"', 'className="miu-glow" r="28" fill="#9DBBFF"');
svg = svg.replace('<g transform={pose.earL}>', '<g className="miu-head">\n<g className="miu-ear-left" transform={pose.earL}>');
svg = svg.replace('<g transform={pose.earR}>', '<g className="miu-ear-right" transform={pose.earR}>');
svg = svg.replace('<ellipse cx="112" cy="214"', '<g className="miu-puffed-cheeks" opacity={pose.puff}><ellipse cx="91" cy="219" rx="28" ry="20" fill={\'url(#\' + id + \'-miuFur)\'}></ellipse><ellipse cx="309" cy="219" rx="28" ry="20" fill={\'url(#\' + id + \'-miuFur)\'}></ellipse></g>\n<ellipse cx="112" cy="214"');
svg = svg.replaceAll('rx="18" ry="10" fill="#F7A8B4"', 'rx={pose.cheekRx} ry={pose.cheekRy} fill="#F7A8B4"');
svg = svg.replace('<path d="M140 266', '</g>\n<path d="M140 266');
svg = svg.replace('<g transform={pose.armL}>', '<g className="miu-paw-left" transform={pose.armL}>');
svg = svg.replace('<g transform={pose.armR}>', '<g className="miu-paw-right" transform={pose.armR}>');
svg = svg.replace('<g fill="#1A56C4" fontWeight="800" opacity={pose.zzz}>', '<g className="miu-sleep-marks" fill="#1A56C4" fontWeight="800" opacity={pose.zzz}>');
fs.mkdirSync(path.join(root, 'src/components'), { recursive: true });
fs.mkdirSync(path.join(root, 'src/styles'), { recursive: true });
fs.copyFileSync(path.join(root, '../design/design/reference/tokens.css'), path.join(root, 'src/styles/tokens.css'));
fs.writeFileSync(path.join(root, 'src/components/MiuArtwork.tsx'), `// Generated from the original design by tools/sync-artwork.mjs.\nimport { useId } from 'react';\nimport { getMiuPose, type Emotion } from '../lib/miu-pose';\nimport type { CatActivity } from '../lib/miu-behavior';\nimport type { Point } from '../lib/miu-touch';\n\nexport default function MiuArtwork({ emotion, activity, gaze, label }: { emotion: Emotion; activity?: CatActivity; gaze?: Point; label: string }) {\n  const id = useId().replaceAll(':', '');\n  const pose = getMiuPose(emotion, activity, gaze);\n  return (${svg});\n}\n`);
console.log('Synced the original Miu SVG artwork.');
