import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

const INTERVALO_MS = 100;
const PADRAO_QUADROS = 80;

const saida = process.argv[2];
if (!saida) {
  console.error('Uso: node gravar-frames.mjs <pasta-de-quadros> [quantidade]');
  process.exit(1);
}

const quantidade = Number(process.env.QUADROS ?? process.argv[3] ?? PADRAO_QUADROS);
if (!Number.isInteger(quantidade) || quantidade < 1) {
  console.error('A quantidade de quadros precisa ser um inteiro positivo.');
  process.exit(1);
}

const pasta = path.resolve(saida);
const pagina = pathToFileURL(fileURLToPath(new URL('./index.html', import.meta.url))).href;
const larguraDigitos = Math.max(3, String(quantidade - 1).length);

fs.mkdirSync(pasta, { recursive: true });
for (const arquivo of fs.readdirSync(pasta)) {
  if (/^frame-\d+\.png$/.test(arquivo)) fs.rmSync(path.join(pasta, arquivo));
}

const navegador = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const contexto = await navegador.newContext({ viewport: { width: 1600, height: 1200 } });
  const aba = await contexto.newPage();
  await aba.goto(pagina);
  await aba.waitForTimeout(300);

  for (let i = 0; i < quantidade; i++) {
    const nome = `frame-${String(i).padStart(larguraDigitos, '0')}.png`;
    await aba.screenshot({ path: path.join(pasta, nome) });
    await aba.waitForTimeout(INTERVALO_MS);
  }
} finally {
  await navegador.close();
}

console.log(`Quadros gravados em ${pasta} (${quantidade} arquivos).`);
console.log('Monte o vídeo com:');
console.log(
  `ffmpeg -y -framerate 10 -i '${path.join(pasta, 'frame-%03d.png')}' ` +
    '-c:v libx264 -preset slow -crf 20 -pix_fmt yuv420p -movflags +faststart panorama.mp4',
);
