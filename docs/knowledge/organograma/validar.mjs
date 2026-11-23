import fs from 'node:fs';
import vm from 'node:vm';

const root = new URL('.', import.meta.url);
const code = fs.readFileSync(new URL('./data/dados.js', root), 'utf8');
const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'data/dados.js' });

const data = sandbox.window.GLIMPSE;
if (!data) {
  console.error('FALHA: window.GLIMPSE não foi definido.');
  process.exit(1);
}

const { meta, views, nodes, relations } = data;
const problems = [];
const warnings = [];

const ids = new Set();
const viewIds = new Set(views.map((v) => v.id));
const statuses = new Set(['base', 'fork', 'misto', 'morto', 'risco']);

for (const node of nodes) {
  if (!node.id) problems.push('Nó sem id.');
  if (ids.has(node.id)) problems.push(`ID duplicado: ${node.id}`);
  ids.add(node.id);
  if (!viewIds.has(node.view)) problems.push(`${node.id}: view inexistente (${node.view}).`);
  if (!node.name) problems.push(`${node.id}: sem nome.`);
  if (!node.summary) problems.push(`${node.id}: sem summary.`);
  if (!node.source) problems.push(`${node.id}: sem fonte.`);
  if (!node.decision) warnings.push(`${node.id}: sem decisão provisória.`);
  if (!statuses.has(node.status)) problems.push(`${node.id}: status inválido (${node.status}).`);
  if (!Number.isFinite(node.lines)) problems.push(`${node.id}: lines inválido.`);
  if (!Number.isFinite(node.files)) problems.push(`${node.id}: files inválido.`);
  if (!Number.isFinite(node.added)) problems.push(`${node.id}: added inválido.`);
  if (!Number.isFinite(node.removed)) problems.push(`${node.id}: removed inválido.`);
}

for (const view of views) {
  const count = nodes.filter((node) => node.view === view.id).length;
  if (count === 0) problems.push(`Visão vazia: ${view.id}`);
}

for (const rel of relations) {
  if (!ids.has(rel.from)) problems.push(`Relação com origem inexistente: ${rel.from}`);
  if (!ids.has(rel.to)) problems.push(`Relação com destino inexistente: ${rel.to}`);
  if (!rel.label) warnings.push(`Relação sem rótulo: ${rel.from} -> ${rel.to}`);
}

const allText = JSON.stringify(data);
if (allText.includes('\u2014')) problems.push('Texto contém em dash (U+2014).');
if (allText.includes('\u2013')) problems.push('Texto contém en dash (U+2013).');
if (/\bTODO\b|\bFIXME\b/.test(allText)) warnings.push('Texto contém TODO ou FIXME.');

const byStatus = {};
const byView = {};
for (const node of nodes) {
  byStatus[node.status] = (byStatus[node.status] || 0) + 1;
  byView[node.view] = (byView[node.view] || 0) + 1;
}

console.log(`Glimpse: ${meta.produto}, ${meta.base}, ${meta.sha}`);
console.log(`Nós: ${nodes.length}`);
console.log(`Visões: ${views.length}`);
console.log(`Relações: ${relations.length}`);
console.log('Por status:', byStatus);
console.log('Por visão:', byView);

if (warnings.length) {
  console.log('\nAvisos:');
  for (const warning of warnings) console.log(`- ${warning}`);
}

if (problems.length) {
  console.error('\nFalhas:');
  for (const problem of problems) console.error(`- ${problem}`);
  process.exit(1);
}

console.log('\nOK: dados íntegros.');
