import QRCode from 'qrcode';

export function createQr(value: string) {
  const code = QRCode.create(value, { errorCorrectionLevel: 'M' });
  const quietZone = 4;
  const size = code.modules.size + quietZone * 2;
  const commands: string[] = [];
  for (let y = 0; y < code.modules.size; y++) {
    for (let x = 0; x < code.modules.size; x++) {
      if (code.modules.get(y, x)) commands.push(`M${x + quietZone},${y + quietZone}h1v1h-1z`);
    }
  }
  return { size, path: commands.join('') };
}
