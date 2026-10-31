import test from 'node:test';
import assert from 'node:assert/strict';
import jsQR from 'jsqr';
import { buildDemoUrl, selectLanAddress } from './demo-share.ts';
import { createQr } from './qr.ts';
import { DEMO_BUDDY, DEMO_ROUTE, demoLanguage } from './demo-buddy.ts';
import { getDemoReply } from './demo.ts';

test('the phone link opens the preset room directly and carries only the language', () => {
  const url = new URL(buildDemoUrl('http://192.168.225.72:5173/app/talk?secret=example#old', 'vi'));
  assert.equal(url.pathname, DEMO_ROUTE);
  assert.equal(url.search, '?lang=vi');
  assert.equal(url.hash, '');
  assert.equal(url.origin, 'http://192.168.225.72:5173');
});

test('QR links reject laptop loopback, credentials, and non-web schemes', () => {
  for (const origin of ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://[::1]:5173', 'http://0.0.0.0:5173', 'https://user:password@example.com', 'javascript:alert(1)']) {
    assert.throws(() => buildDemoUrl(origin, 'en'));
  }
});

test('network discovery prefers physical Wi-Fi over virtual and loopback addresses', () => {
  assert.equal(selectLanAddress([
    { name: 'VirtualBox', address: '192.168.56.1', family: 'IPv4', internal: false },
    { name: 'Loopback', address: '127.0.0.1', family: 'IPv4', internal: true },
    { name: 'Ethernet', address: '10.0.0.2', family: 'IPv4', internal: false },
    { name: 'Wi-Fi', address: '192.168.225.72', family: 'IPv4', internal: false },
  ]), '192.168.225.72');
  assert.equal(selectLanAddress([]), null);
});

test('the prepared personality is consistent in English and Vietnamese without URL setup', () => {
  assert.equal(DEMO_BUDDY.personality, 'ENFP');
  assert.equal(DEMO_BUDDY.role, 'friend');
  assert.equal(DEMO_BUDDY.readAloudByDefault, true);
  assert.equal(getDemoReply('What is your personality?', 'en').text, DEMO_BUDDY.copy.en.personalityAnswer);
  assert.equal(getDemoReply('Tính cách của bạn là gì?', 'vi').text, DEMO_BUDDY.copy.vi.personalityAnswer);
  assert.equal(demoLanguage('?lang=vi&personality=other'), 'vi');
  assert.equal(demoLanguage('?lang=fr'), null);
});

test('an independent scanner decodes the exact SVG modules for local and HTTPS demo links', () => {
  for (const origin of ['http://192.168.225.72:5173', 'https://little-buddy-curiopal.gauzymacaw.chatgpt.site']) {
    for (const language of ['en', 'vi'] as const) {
      const url = buildDemoUrl(origin, language);
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
  }
});
