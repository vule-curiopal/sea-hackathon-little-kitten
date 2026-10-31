#!/usr/bin/env node
// Renders the design artboards (design/artboards/*.dc.html) to plain HTML in
// design/preview/, plus an index.html gallery, so the design can be opened in
// any browser without the Claude Design runtime.
//
// The .dc.html format (see ../reference/dc-format.md) is HTML with a few
// extras: {{dotted.holes}} filled from the component's renderVals(),
// <sc-for list as> repeats, <sc-if value> branches and <dc-import name>
// mounts of a sibling artboard. This script evaluates renderVals() once with
// the declared default props and no interaction state, then expands those
// constructs. Event handlers are dropped (the previews are static) and links
// between artboards become links between previews.
//
// Usage: node tools/render.mjs                   (from the design folder)
//        node render.mjs [artboardsDir] [outDir]
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(process.argv[2] ?? path.join(here, '..', 'artboards'));
const OUT = path.resolve(process.argv[3] ?? path.join(here, '..', 'preview'));

const canvas = JSON.parse(fs.readFileSync(path.join(SRC, 'canvas.json'), 'utf8'));

// The artboard's logic class runs against this stand-in: props as given,
// no state, setState ignored.
class DCLogic {
  constructor(props) {
    this.props = props;
    this.state = undefined;
  }
  setState() {}
  forceUpdate() {}
}

const decodeEntities = (s) => s
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const escapeAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

const fileCache = new Map();
function loadArtboard(file) {
  if (fileCache.has(file)) return fileCache.get(file);
  const text = fs.readFileSync(path.join(SRC, file), 'utf8');
  const lang = /<html[^>]*\blang="([^"]*)"/.exec(text)?.[1] ?? 'en';
  const title = /<title>([^<]*)<\/title>/.exec(text)?.[1] ?? file;
  const body = /<x-dc>([\s\S]*?)<\/x-dc>/.exec(text)?.[1] ?? '';
  const helmet = /<helmet>([\s\S]*?)<\/helmet>/.exec(body)?.[1] ?? '';
  const markup = body.replace(/<helmet>[\s\S]*?<\/helmet>/, '').trim();
  const headItems = [...helmet.matchAll(/<link[^>]*>|<style>[\s\S]*?<\/style>/g)].map((m) => m[0]);
  const script = /<script type="text\/x-dc" data-dc-script data-props='([^']*)'>([\s\S]*?)<\/script>/.exec(text);
  const propDefs = script ? JSON.parse(decodeEntities(script[1])) : {};
  const code = script ? script[2] : 'class Component extends DCLogic { renderVals() { return {}; } }';
  const Component = vm.runInNewContext(`${code}\n; Component`, { DCLogic, console, Math, Number, String, Array, Object });
  const board = { file, lang, title, markup, headItems, propDefs, Component };
  fileCache.set(file, board);
  return board;
}

function renderVals(board, props) {
  const full = { ...props };
  for (const [k, def] of Object.entries(board.propDefs)) {
    if (k.startsWith('$') || full[k] !== undefined) continue;
    if (def && def.default !== undefined) full[k] = def.default;
  }
  return new board.Component(full).renderVals() ?? {};
}

// {{ path }} is a dotted lookup into the scope (renderVals output plus loop
// variables), or a literal.
function lookup(scope, expr) {
  const p = expr.trim();
  if (p === 'true') return true;
  if (p === 'false') return false;
  if (p === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(p)) return Number(p);
  let cur = scope;
  for (const key of p.split('.')) {
    if (cur == null) return undefined;
    cur = cur[key];
  }
  return cur;
}

const HOLE = /\{\{\s*([^}]+?)\s*\}\}/g;

function fillText(text, scope) {
  // Whole-value attributes first: raw values, booleans and handlers.
  let out = text.replace(/\s([\w-]+)="\{\{\s*([^}]+?)\s*\}\}"/g, (m, name, expr) => {
    if (/^on[A-Z]/.test(name)) return '';
    const v = lookup(scope, expr);
    if (typeof v === 'function') return '';
    if (v === false || v === null || v === undefined) return '';
    if (v === true) return ` ${name}`;
    return ` ${name}="${escapeAttr(v)}"`;
  });
  out = out.replace(HOLE, (m, expr) => {
    const v = lookup(scope, expr);
    if (v === undefined || v === null || typeof v === 'function') return '';
    return String(v);
  });
  return out;
}

function parseAttrs(tag) {
  const attrs = {};
  for (const m of tag.matchAll(/([\w:-]+)="([^"]*)"/g)) attrs[m[1]] = m[2];
  return attrs;
}

// Index just past the matching close tag of the element opening at `open`,
// counting nested elements of the same name.
function findClose(html, open, name) {
  const re = new RegExp(`<${name}\\b|</${name}>`, 'g');
  re.lastIndex = html.indexOf('>', open) + 1;
  let depth = 1;
  let m;
  while ((m = re.exec(html))) {
    depth += m[0].startsWith('</') ? -1 : 1;
    if (depth === 0) return { innerEnd: m.index, end: m.index + m[0].length };
  }
  throw new Error(`unclosed <${name}> in artboard`);
}

const CONTROL = /<(sc-for|sc-if|dc-import)\b[^>]*>/g;

function expand(html, scope, ctx) {
  let out = '';
  let pos = 0;
  CONTROL.lastIndex = 0;
  let m;
  while ((m = CONTROL.exec(html))) {
    if (m.index < pos) continue;
    out += fillText(html.slice(pos, m.index), scope);
    const tag = m[0];
    const name = m[1];
    const attrs = parseAttrs(tag);
    const innerStart = m.index + tag.length;
    const { innerEnd, end } = findClose(html, m.index, name);
    const inner = html.slice(innerStart, innerEnd);
    if (name === 'sc-for') {
      const list = lookup(scope, attrs.list.replace(/^\{\{|\}\}$/g, '')) ?? [];
      list.forEach((item, i) => {
        out += expand(inner, { ...scope, [attrs.as]: item, $index: i }, ctx);
      });
    } else if (name === 'sc-if') {
      if (lookup(scope, attrs.value.replace(/^\{\{|\}\}$/g, ''))) out += expand(inner, scope, ctx);
    } else {
      const props = {};
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'name' || k.startsWith('hint-')) continue;
        const whole = /^\{\{\s*([^}]+?)\s*\}\}$/.exec(v);
        props[camel(k)] = whole ? lookup(scope, whole[1]) : fillText(v, scope);
      }
      out += renderBoard(`${attrs.name}.dc.html`, props, ctx);
    }
    pos = end;
    CONTROL.lastIndex = end;
  }
  out += fillText(html.slice(pos), scope);
  return out;
}

function renderBoard(file, props, ctx) {
  const board = loadArtboard(file);
  for (const item of board.headItems) ctx.head.add(item);
  const vals = renderVals(board, props);
  return expand(board.markup, vals, ctx);
}

const stem = (file) => file.replace(/\.dc\.html$/, '');

function renderPage(file) {
  const ctx = { head: new Set() };
  const board = loadArtboard(file);
  const entry = canvas.boards[file] ?? {};
  let body = renderBoard(file, {}, ctx);
  // Links between artboards become links between previews; # anchors stay.
  body = body.replace(/href="\/?([A-Za-z0-9_][\w.-]*)\.dc\.html"/g, (m, name) => `href="${name}.html"`);
  const fill = entry.expand === 'fill';
  const title = entry.title ?? board.title;
  return `<!doctype html>
<html lang="${board.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
${[...ctx.head].join('\n')}
<style>
html{background:#E9EEF6}
body{margin:0;${fill ? '' : 'display:flex;justify-content:center;padding:24px 0;'}}
</style>
</head>
<body>
${body}
</body>
</html>
`;
}

function renderIndex() {
  const rows = Object.values(canvas.notes ?? {})
    .filter((n) => n.kind === 'title1')
    .sort((a, b) => a.y - b.y);
  const rowOf = (entry) => {
    let best = null;
    for (const r of rows) if (r.y <= entry.y && (!best || r.y > best.y)) best = r;
    return best?.text ?? '';
  };
  const groups = new Map(rows.map((r) => [r.text, []]));
  for (const file of canvas.order) {
    const entry = canvas.boards[file];
    const key = rowOf(entry);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ file, ...entry });
  }
  const card = (b) => {
    const scale = Math.min(1, 300 / b.w);
    const h = Math.min(Math.round(b.h * scale), 460);
    return `<a class="card" href="${stem(b.file)}.html">
<div class="shot" style="height:${h}px"><iframe loading="lazy" tabindex="-1" title="${escapeAttr(b.title ?? b.file)}" src="${stem(b.file)}.html" style="width:${b.w}px;height:${Math.round(h / scale)}px;transform:scale(${scale})"></iframe></div>
<div class="meta"><b>${b.title ?? stem(b.file)}</b><span>${stem(b.file)} · ${b.w}×${b.h}${b.is_interactive ? ' · interactive in the canvas' : ''}</span></div>
</a>`;
  };
  const sections = [...groups.entries()].map(([title, boards]) => `<section>
<h2>${title}</h2>
<div class="grid">
${boards.map(card).join('\n')}
</div>
</section>`).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${canvas.title}: previews</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Baloo+2:wght@700;800&family=Nunito:wght@600;700&display=swap">
<style>
:root{color-scheme:light}
body{margin:0;padding:32px 24px 64px;background:#F7F9FC;color:#0B1220;font:600 15px/1.45 Nunito,system-ui,sans-serif}
h1{margin:0 0 6px;font:800 40px/1.05 'Baloo 2',sans-serif}
p.lead{margin:0 0 28px;color:#5B6B82;max-width:720px}
h2{margin:32px 0 14px;font:800 26px/1.1 'Baloo 2',sans-serif}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:20px}
.card{display:block;background:#FFFFFF;border-radius:24px;box-shadow:0 5px 0 #DDE4EE;overflow:hidden;color:inherit;text-decoration:none;transition:transform .12s ease,box-shadow .12s ease}
.card:hover{transform:translateY(-2px);box-shadow:0 7px 0 #C9D6EA}
.shot{position:relative;overflow:hidden;background:#E9EEF6}
.shot iframe{position:absolute;left:50%;top:0;border:0;transform-origin:top center;margin-left:-150px;pointer-events:none}
.meta{display:grid;gap:2px;padding:12px 16px 14px}
.meta b{font:800 17px 'Baloo 2',sans-serif}
.meta span{color:#5B6B82;font-size:13px}
</style>
</head>
<body>
<h1>${canvas.title}</h1>
<p class="lead">Static previews of every artboard, rendered from <code>design/artboards/</code> by <code>design/tools/render.mjs</code> with each artboard's default state. Click a card to open the screen at full size; links inside the screens follow the prototype flow.</p>
${sections}
</body>
</html>
`;
}

fs.mkdirSync(OUT, { recursive: true });
for (const file of canvas.order) {
  fs.writeFileSync(path.join(OUT, `${stem(file)}.html`), renderPage(file));
}
fs.writeFileSync(path.join(OUT, 'index.html'), renderIndex());
console.log(`rendered ${canvas.order.length} artboards to ${OUT}`);
