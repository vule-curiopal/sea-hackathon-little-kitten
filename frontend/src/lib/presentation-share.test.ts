import test from 'node:test';
import assert from 'node:assert/strict';
import jsQR from 'jsqr';
import { buildPresentationUrl } from './presentation-share.ts';
import { createQr } from './qr.ts';

test('presentation links preserve the reachable origin and open the full deck without presenter state', () => {
  for (const origin of ['http://192.168.225.72:5173', 'https://miu.curiopal.com']) {
    assert.equal(buildPresentationUrl(`${origin}/presentation?private=example#slide-4`), `${origin}/presentation`);
    assert.equal(buildPresentationUrl(`${origin}/demo/miu?lang=vi`), `${origin}/presentation`);
  }
});

test('presentation links reject laptop-only addresses, credentials and non-web URLs', () => {
  for (const origin of [
    'http://localhost:5173', 'http://miu.localhost:5173', 'http://127.0.0.1:5173',
    'http://[::1]:5173', 'http://0.0.0.0:5173', 'https://user:password@example.com',
    'file:///presentation', 'javascript:alert(1)', '/presentation', 'invalid',
  ]) {
    assert.throws(() => buildPresentationUrl(origin));
  }
});

test('an independent scanner reads presentation QR modules as the exact LAN or HTTPS link', () => {
  for (const origin of ['http://192.168.225.72:5173', 'https://miu.curiopal.com']) {
    const url = buildPresentationUrl(origin);
    const qr = createQr(url);
    const scale = 6;
    const width = qr.size * scale;
    const pixels = new Uint8ClampedArray(width * width * 4).fill(255);
    for (const match of qr.path.matchAll(/M(\d+),(\d+)h1v1h-1z/g)) {
      const x = Number(match[1]); const y = Number(match[2]);
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
        const offset = ((y * scale + dy) * width + x * scale + dx) * 4;
        pixels[offset] = 11; pixels[offset + 1] = 18; pixels[offset + 2] = 32;
      }
    }
    assert.equal(jsQR(pixels, width, width)?.data, url);
  }
});
