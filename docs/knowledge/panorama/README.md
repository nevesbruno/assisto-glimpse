# Panorama visual

Resumo de uma página do estado do Glimpse, em linguagem de produto. Existe em três formatos:

| Arquivo | Uso |
|---|---|
| `index.html` | Versão interativa, com animação de entrada. Abre direto no navegador |
| `panorama.png` | Imagem estática, 1600x1200 |
| `panorama.mp4` | Vídeo de 8 segundos, 1600x1200 |

## O que a página diz

1. O produto é seu, a base é emprestada.
2. O que é nosso: orquestração, correções de agente, mesa de coordenação multi-projeto em validação.
3. O que é base: canvas, terminal, plugins, shell.
4. O fork está 99 commits atrás e o trabalho vive numa branch com 47 commits. O Bruno não gasta horas em merge: o custo é medido em conflitos, portões e tempo de agente.
5. O portão: o banco dos dois lados usa a versão 14 para coisas diferentes. Os dados locais podem ser recriados, então o risco não é perder histórico, é a migração rodar errada. O merge semanal por agente resolve isso num portão automático.
6. O plano: separar o banco, montar a mesa, animar, podar, construir.
7. O que precisa do Bruno: validar a mesa de coordenação como a próxima peça do produto.

## Como regravar

A imagem:

```sh
npx playwright screenshot --viewport-size=1600,1200 --wait-for-timeout=2500 \
  "file:///caminho/para/docs/knowledge/panorama/index.html" panorama.png
```

O vídeo é montado a partir de capturas de tela em sequência, porque o Playwright não instala o ffmpeg próprio no Ubuntu 26.04. Rode os comandos nesta pasta:

```sh
# 80 capturas a 10 fps, gravadas em /tmp/opencode/panorama-frames
node gravar-frames.mjs /tmp/opencode/panorama-frames
ffmpeg -y -framerate 10 -i /tmp/opencode/panorama-frames/frame-%03d.png \
  -c:v libx264 -preset slow -crf 20 -pix_fmt yuv420p \
  -movflags +faststart panorama.mp4
```

## Limites

- Os números são de 2026-11-20: 324 mil linhas, 47 commits na branch, 99 commits atrás, 0 horas do Bruno em merge.
- Os dados locais do OpenCove eram de teste e podem ser recriados. O portão de migração existe porque o fork e o upstream usam a mesma versão 14 para coisas diferentes.
- O panorama é uma fotografia. Se o merge por agente acontecer, os números mudam.
- A página não lê o repositório em tempo real.
