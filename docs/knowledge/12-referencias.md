# Referências

## Documentos internos do repositório

| Documento | Por que ler |
|---|---|
| `docs/architecture/CURRENT_ARCHITECTURE.md` | Visão atual de runtime, control surface e persistência |
| `docs/architecture/CONTROL_SURFACE.md` | Contratos de command, query e event |
| `docs/architecture/PERSISTENCE.md` | SQLite, topologia e migrações |
| `docs/architecture/RECOVERY_MODEL.md` | Semântica de recuperação e donos de estado |
| `docs/terminal/MULTI_CLIENT_ARCHITECTURE.md` | Terminal multi-cliente e limites |
| `docs/terminal/TERMINAL_RUNTIME_STABILITY.md` | Geometria, attach authority e invariantes |
| `docs/cases/CASE_STUDY_CANVAS_JITTER_AND_TERMINAL_DURABILITY.md` | Causa arquitetural do jitter e da perda de scrollback |
| `docs/ui/README.md` | Normas globais de UI e tema |
| `docs/ui/SPATIAL_PIXEL_THEME.md` | Parede de pixels, efeitos e cores |
| `docs/ui/CANVAS_SIGNALS.md` | Sinais de canvas, luzes e partículas |
| `docs/ui/AGENT_ISLAND.md` | Estado de agente na interface |
| `docs/plugins/README.md` | Plataforma de plugins |
| `docs/plugins/RUNTIME.md` | Runtime de plugins, iframe e backend |
| `docs/plugins/THEMES.md` | Contrato de temas e motion |
| `docs/plugins/COMPATIBILITY.md` | Compatibilidade de host e plugins |
| `docs/canvas/WEBSITE_WINDOW_NODE.md` | Website nodes e WebContentsView |
| `docs/canvas/DOCUMENT_NODE.md` | Documento, Monaco e mídia |
| `docs/development/DEBUGGING.md` | Fluxo de depuração |
| `docs/development/REFERENCE_RESEARCH_METHOD.md` | Método de pesquisa externa |

## Referências externas

### Rune

- Repositório: `https://github.com/anomalyco/rune`
- Plano e milestones: `PLAN.md` na raiz do repositório
- README técnico: `crates/rune/README.md`
- Componentes: `crates/rune-kit/README.md`
- Alvo web: `WEB.md`
- Issue do grid de terminal: `#813`
- Issue de webview nativa: `#412`
- Issue de plataforma de plugins em Luau: `#274`

### Tecnologias do Glimpse

- Electron: `https://www.electronjs.org`
- React 19: `https://react.dev`
- React Flow: `https://reactflow.dev`
- xterm.js: `https://xtermjs.org`
- Monaco: `https://microsoft.github.io/monaco-editor`
- node-pty: `https://github.com/microsoft/node-pty`
- Zustand: `https://zustand.docs.pmnd.rs`

### Conceitos de motion

- Web Animations API: `https://developer.mozilla.org/docs/Web/API/Web_Animations_API`
- FLIP: `https://aerotwist.com/blog/flip-your-animations`
- Reduced motion: `https://developer.mozilla.org/docs/Web/CSS/@media/prefers-reduced-motion`
- Motion: `https://motion.dev`

### Performance no Chromium

- Chrome tracing: `https://developer.chrome.com/docs/devtools/performance`
- Long tasks: `https://developer.mozilla.org/docs/Web/API/PerformanceLongTaskTiming`
- Rendering performance: `https://web.dev/rendering-performance`

## Comandos úteis

```sh
# desenvolvimento
pnpm dev
pnpm build
pnpm check

# verificação
pnpm verify:quick
pnpm verify:full

# testes
pnpm test
pnpm test:e2e

# análise de tamanho
find src -type f \( -name '*.ts' -o -name '*.tsx' \) -print0 | xargs -0 cat | wc -l
du -sh out/renderer out/main

# animações e efeitos
grep -rn "animation:" src --include=*.css | wc -l
grep -rn "transition:" src --include=*.css | wc -l
grep -rn "backdrop-filter" src --include=*.css | wc -l

# acoplamento
grep -rEn "window\.(opencove|api|electron|desktop)" src/app/renderer src/contexts --include=*.ts --include=*.tsx | wc -l
```

## Glossário

| Termo | Significado |
|---|---|
| Canvas | Superfície infinita onde os nós vivem |
| Nó | Terminal, agente, tarefa, nota, documento, imagem, pasta, site, papel ou plugin |
| Space | Região do canvas que agrupa trabalho e pode ter worktree própria |
| Mount | Raiz de filesystem aprovada para um projeto |
| Control Surface | Camada de comandos, queries e eventos do Worker |
| Worker | Backend que hospeda PTY, banco, arquivos e providers |
| PTY | Pseudo-terminal que executa shell ou agente |
| Provider | Integração com uma CLI de agente, como Claude Code ou Codex |
| Plugin | Pacote instalável com view, comandos, skills, tema ou backend |
| Reduced motion | Preferência do sistema por menos movimento |
| Frame p95 | 95% dos frames ficam abaixo desse tempo |
| Long task | Tarefa de main thread acima de 50 ms |
| FLIP | Técnica de animar layout com transform, medindo antes e depois |
| Compositor | Camada do browser que anima transform e opacity na GPU |
| Jank | Engasgo perceptível na animação ou na interação |

## Onde registrar achados novos

- Caso reproduzível: `docs/cases`.
- Decisão de produto ou arquitetura: `docs/knowledge/11-decisoes-e-criticas.md`.
- Risco novo: `docs/knowledge/08-riscos.md`.
- Número novo de baseline: `docs/knowledge/05-performance.md`.
- Divergência em relação ao upstream: `FORK.md` na raiz do fork.
