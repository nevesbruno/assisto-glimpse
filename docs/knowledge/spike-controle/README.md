# Spike da interface de controle

> **Status: estudo de uma ideia futura, parkeada em 2026-11-20. Não é um gate do plano ativo.**

Prova técnica, sem UI e sem mudança de código, de que a Mesa de coordenação consegue viver fora do núcleo consumindo a interface pública do Glimpse.

## Pré-requisitos

- Node 22.
- Build presente em `out/cli/opencove.mjs` e `out/main/worker.js`.
- Perfil de teste `~/.config/opencove-dev`. Nunca use o perfil principal.

## Subir o worker

```bash
cd /home/bruno/lab/assisto-network/glimpse
setsid nohup node out/cli/opencove.mjs \
  --user-data ~/.config/opencove-dev \
  worker start \
  > /tmp/opencove-glimpse-worker.log 2>&1 < /dev/null &
```

Espere o arquivo de conexão, sem imprimir o token:

```bash
for i in $(seq 1 30); do
  [ -f ~/.config/opencove-dev/worker-control-surface.json ] && break
  sleep 1
done
```

Confira só os campos seguros:

```bash
node -e 'const c=require(process.env.HOME+"/.config/opencove-dev/worker-control-surface.json");console.log({pid:c.pid,port:c.port,appVersion:c.appVersion,protocol:c.version})'
```

Se o arquivo não aparecer em 30 s, leia o log e pare. Não tente consertar o app.

## Rodar o probe

```bash
cd /home/bruno/lab/assisto-network/glimpse
node docs/knowledge/spike-controle/probe.mjs
```

Argumento opcional: um diretório de perfil diferente.

```bash
node docs/knowledge/spike-controle/probe.mjs /caminho/do/perfil
```

O probe:

- lê `worker-control-surface.json` do perfil;
- chama `/invoke` com `{kind, id, payload}` e os headers `authorization` e `x-opencove-protocol`;
- executa as leituras de projeto, space, node, agent, link, status e catálogo;
- mede latência de cada chamada e captura o erro;
- assina `/events` por 5 s e conta tipos;
- redige o token, a home e o caminho do arquivo de conexão;
- grava `docs/knowledge/spike-controle/saida.json` e imprime um resumo.

Saída esperada com o banco de teste vazio: 23 chamadas, 17 ok, 6 falhas esperadas de `node.get`, latência média de poucos milissegundos, 0 frames de evento.

## Parar o worker

```bash
cd /home/bruno/lab/assisto-network/glimpse
node out/cli/opencove.mjs --user-data ~/.config/opencove-dev worker stop
```

Confirme que não sobrou processo nem porta:

```bash
ps -eo pid=,comm=,args= | awk '$2=="electron" && /worker\.js/ {print}'
```

O comando não deve retornar linha alguma. A porta some junto com o processo; o arquivo `worker-control-surface.json` é removido pelo `worker stop`.

## Limites deste spike

- Só o perfil `~/.config/opencove-dev`; nenhum dado do perfil principal.
- Nenhuma alteração em `src/`, `package.json`, `pnpm-lock.yaml` ou código.
- Nenhuma UI.
- Nenhum agente real criado e nenhum prompt disparado.
- Aprovação e hook só foram testados com id falso, que devolve `orch.not_linked`; não havia pedido pendente.
- O banco de teste tem 6 links fechados, 0 agentes e 0 nodes. Formas de status ativo, fila e custo são análise de contrato, não prova ao vivo.
- O token do worker é bearer admin; o probe nunca o imprime nem o grava.
- Tempo total do spike: 1 hora.
