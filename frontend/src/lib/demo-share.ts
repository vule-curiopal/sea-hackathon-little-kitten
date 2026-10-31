export function isLoopbackHost(host: string) {
  return host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || host === '::1' || /^127\./.test(host) || host === '0.0.0.0';
}

export function buildDemoUrl(origin: string, language: 'en' | 'vi') {
  const base = new URL(origin);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || isLoopbackHost(base.hostname)) {
    throw new Error('Use an HTTP or HTTPS address that attendees can open on their phones.');
  }
  const url = new URL('/app/talk', base.origin);
  url.searchParams.set('lang', language);
  return url.href;
}

type NetworkAddress = { name: string; address: string; family: string; internal: boolean };
export function selectLanAddress(addresses: NetworkAddress[]) {
  const privateAddress = (value: string) => /^10\./.test(value) || /^192\.168\./.test(value) || /^172\.(1[6-9]|2\d|3[01])\./.test(value);
  const score = (name: string) => /virtual|vmware|vbox|vethernet|docker|wsl|loopback/i.test(name) ? -100 : /wi-?fi|wireless|wlan/i.test(name) ? 100 : /ethernet|^en\d|^eth/i.test(name) ? 50 : 0;
  return addresses.filter(item => item.family === 'IPv4' && !item.internal && privateAddress(item.address))
    .sort((a, b) => score(b.name) - score(a.name))[0]?.address ?? null;
}
