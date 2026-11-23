import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const raiz = path.dirname(fileURLToPath(import.meta.url));
const problemas = [];

function lerDados() {
  const caminho = path.join(raiz, "data", "dados.js");
  const codigo = fs.readFileSync(caminho, "utf8");
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(codigo, sandbox, { filename: "data/dados.js" });
  return sandbox.window.MESA;
}

const MESA = lerDados();

if (!MESA || typeof MESA !== "object") {
  console.error("FALHA: window.MESA não foi definido em data/dados.js.");
  process.exit(1);
}

const {
  meta,
  projetos = [],
  execucoes = [],
  fila = [],
  atencao = [],
  upstream = {}
} = MESA;

const ESTADOS = [
  "executando",
  "aguardando",
  "bloqueado",
  "revisao",
  "concluido",
  "fila",
  "falhou"
];
const ESTADOS_PRINCIPAIS = [
  "executando",
  "aguardando",
  "bloqueado",
  "revisao",
  "concluido",
  "fila"
];
const PRIORIDADES = ["alta", "media", "baixa"];
const TIPOS_ATENCAO = ["Aprovação", "Autorização", "Revisão", "Decisão"];
const SAUDES = ["ok", "atencao"];
const VISOES = ["agora", "projetos", "fila", "upstream"];

function exigir(condicao, mensagem) {
  if (!condicao) problemas.push(mensagem);
}

function textoValido(valor) {
  return typeof valor === "string" && valor.trim().length > 0;
}

if (!meta || !Array.isArray(meta.views)) {
  problemas.push("meta.views ausente ou inválido.");
} else {
  const ids = meta.views.map((v) => v.id);
  VISOES.forEach((id) => exigir(ids.includes(id), `Visão obrigatória ausente em meta.views: ${id}`));
}

const idsProjetos = new Set();
projetos.forEach((projeto) => {
  exigir(textoValido(projeto.id), "Projeto sem id.");
  exigir(!idsProjetos.has(projeto.id), `ID de projeto duplicado: ${projeto.id}`);
  idsProjetos.add(projeto.id);
  ["nome", "descricao", "branch", "wip", "merge", "saudeTexto", "saudeMotivo", "ultimoMovimento"].forEach(
    (campo) => exigir(textoValido(projeto[campo]), `${projeto.id}: campo ${campo} ausente.`)
  );
  exigir(
    SAUDES.includes(projeto.saude),
    `${projeto.id}: saúde inválida (${projeto.saude}).`
  );
  exigir(Number.isInteger(projeto.fila), `${projeto.id}: fila deve ser um número inteiro.`);
});

const idsGlobais = new Set();
const idsExecucoes = new Set();

execucoes.forEach((exec) => {
  exigir(textoValido(exec.id), "Execução sem id.");
  exigir(!idsGlobais.has(exec.id), `ID duplicado entre execuções, fila e atenção: ${exec.id}`);
  idsGlobais.add(exec.id);
  idsExecucoes.add(exec.id);
  exigir(idsProjetos.has(exec.projeto), `${exec.id}: projeto inexistente (${exec.projeto}).`);
  exigir(ESTADOS.includes(exec.estado), `${exec.id}: estado inválido (${exec.estado}).`);
  ["titulo", "agente", "provedor", "tempo", "evento", "tokens", "inicio", "custo", "fazendo"].forEach(
    (campo) => exigir(textoValido(exec[campo]), `${exec.id}: campo ${campo} ausente.`)
  );
  exigir(
    Array.isArray(exec.timeline) && exec.timeline.length >= 3 && exec.timeline.length <= 4,
    `${exec.id}: linha do tempo deve ter 3 ou 4 eventos.`
  );
  if (Array.isArray(exec.timeline)) {
    exec.timeline.forEach((evento, indice) => {
      exigir(textoValido(evento.hora), `${exec.id}: evento ${indice + 1} sem hora.`);
      exigir(textoValido(evento.texto), `${exec.id}: evento ${indice + 1} sem texto.`);
    });
  }
});

const contagemEstados = {};
ESTADOS.forEach((estado) => {
  contagemEstados[estado] = execucoes.filter((exec) => exec.estado === estado).length;
});
ESTADOS_PRINCIPAIS.forEach((estado) => {
  exigir(
    contagemEstados[estado] > 0,
    `Nenhuma execução no estado principal: ${estado}`
  );
});

const idsFila = new Set();
fila.forEach((item) => {
  exigir(textoValido(item.id), "Item de fila sem id.");
  exigir(!idsGlobais.has(item.id), `ID duplicado entre execuções, fila e atenção: ${item.id}`);
  idsGlobais.add(item.id);
  idsFila.add(item.id);
  exigir(idsProjetos.has(item.projeto), `${item.id}: projeto inexistente (${item.projeto}).`);
  exigir(PRIORIDADES.includes(item.prioridade), `${item.id}: prioridade inválida (${item.prioridade}).`);
  ["titulo", "agente", "estado", "detalhe"].forEach((campo) =>
    exigir(textoValido(item[campo]), `${item.id}: campo ${campo} ausente.`)
  );
  if (item.dependencia) {
    exigir(
      idsExecucoes.has(item.dependencia),
      `${item.id}: dependência inexistente (${item.dependencia}).`
    );
    exigir(
      item.estado === "esperando",
      `${item.id}: tem dependência mas o estado é ${item.estado}.`
    );
  } else {
    exigir(
      item.estado === "pronta",
      `${item.id}: sem dependência mas o estado é ${item.estado}.`
    );
  }
});

projetos.forEach((projeto) => {
  const naFila = fila.filter((item) => item.projeto === projeto.id).length;
  exigir(
    naFila === projeto.fila,
    `${projeto.id}: campo fila diz ${projeto.fila}, mas há ${naFila} itens na fila.`
  );
});

const idsAtencao = new Set();
atencao.forEach((item) => {
  exigir(textoValido(item.id), "Item de atenção sem id.");
  exigir(!idsGlobais.has(item.id), `ID duplicado entre execuções, fila e atenção: ${item.id}`);
  idsGlobais.add(item.id);
  idsAtencao.add(item.id);
  exigir(TIPOS_ATENCAO.includes(item.tipo), `${item.id}: tipo inválido (${item.tipo}).`);
  ["pergunta", "idade"].forEach((campo) =>
    exigir(textoValido(item[campo]), `${item.id}: campo ${campo} ausente.`)
  );
  exigir(idsProjetos.has(item.projeto), `${item.id}: projeto inexistente (${item.projeto}).`);

  if (!item.alvo || typeof item.alvo !== "object") {
    problemas.push(`${item.id}: alvo ausente.`);
    return;
  }

  if (item.alvo.tipo === "execucao") {
    exigir(
      idsExecucoes.has(item.alvo.id),
      `${item.id}: aponta para execução inexistente (${item.alvo.id}).`
    );
  } else if (item.alvo.tipo === "projeto") {
    exigir(
      idsProjetos.has(item.alvo.id),
      `${item.id}: aponta para projeto inexistente (${item.alvo.id}).`
    );
  } else {
    problemas.push(`${item.id}: tipo de alvo inválido (${item.alvo.tipo}).`);
  }
});

exigir(Number.isInteger(upstream.atras), "upstream.atras deve ser um número inteiro.");
["ultimoMerge", "proximo", "agente", "resultado", "resumo", "nota"].forEach((campo) =>
  exigir(textoValido(upstream[campo]), `upstream.${campo} ausente.`)
);

const portoes = Array.isArray(upstream.portoes) ? upstream.portoes : [];
exigir(portoes.length === 3, `Upstream deve ter exatamente três portões, encontrou ${portoes.length}.`);
["schema", "contratos", "e2e"].forEach((id) => {
  exigir(
    portoes.some((portao) => portao.id === id),
    `Portão obrigatório ausente: ${id}`
  );
});
portoes.forEach((portao) => {
  exigir(textoValido(portao.nome), `Portão ${portao.id}: nome ausente.`);
  exigir(textoValido(portao.detalhe), `Portão ${portao.id}: detalhe ausente.`);
  exigir(textoValido(portao.estado), `Portão ${portao.id}: estado ausente.`);
});

const classes = Array.isArray(upstream.classes) ? upstream.classes : [];
exigir(classes.length === 3, `Upstream deve ter três classes de risco, encontrou ${classes.length}.`);
["A", "B", "C"].forEach((classe) => {
  exigir(
    classes.some((item) => item.classe === classe),
    `Classe de risco ausente: ${classe}`
  );
});

// Higiene de texto em todos os artefatos textuais do diretório.
const EXTENSOES = new Set([".html", ".css", ".js", ".mjs", ".md"]);
const arquivosTexto = [];

function varrer(diretorio) {
  for (const entrada of fs.readdirSync(diretorio, { withFileTypes: true })) {
    if (entrada.name === "node_modules" || entrada.name === ".git") continue;
    const completo = path.join(diretorio, entrada.name);
    if (entrada.isDirectory()) {
      varrer(completo);
    } else if (EXTENSOES.has(path.extname(entrada.name))) {
      arquivosTexto.push(completo);
    }
  }
}

varrer(raiz);
arquivosTexto.sort();

let textosLidos = 0;
arquivosTexto.forEach((arquivo) => {
  const conteudo = fs.readFileSync(arquivo, "utf8");
  textosLidos += 1;
  const linhas = conteudo.split(/\r?\n/);
  linhas.forEach((linha, indice) => {
    if (linha.includes("\u2014") || linha.includes("\u2013")) {
      problemas.push(
        `${path.relative(raiz, arquivo)}:${indice + 1}: contém travessão longo ou médio.`
      );
    }
  });
});

const estadoResumo = ESTADOS.map(
  (estado) => `${estado} ${contagemEstados[estado]}`
).join(", ");
const prioridadeResumo = PRIORIDADES.map(
  (prioridade) => `${prioridade} ${fila.filter((item) => item.prioridade === prioridade).length}`
).join(", ");

console.log("Mesa de coordenação, validação de dados");
console.log(`Projetos: ${projetos.length}`);
console.log(`Execuções: ${execucoes.length} (${estadoResumo})`);
console.log(`Fila: ${fila.length} (${prioridadeResumo})`);
console.log(`Atenção: ${atencao.length}`);
console.log(
  `Portões: ${portoes.length} (${portoes.map((portao) => portao.id).join(", ")})`
);
console.log(`Classes de risco: ${classes.map((classe) => classe.classe).join(", ")}`);
console.log(`Arquivos de texto sem travessão: ${textosLidos}`);

if (problemas.length > 0) {
  console.error(`FALHA: ${problemas.length} problema(s).`);
  problemas.forEach((problema) => console.error(`- ${problema}`));
  process.exit(1);
}

console.log("OK");
