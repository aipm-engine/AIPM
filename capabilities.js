'use strict';
const CONTRACT_VERSION = 'aipm.easy.v1';
const CAPABILITIES = [
  { id: 'observe', tool: 'aipm_observe', aliases: ['observe','observar','inspect','inspecionar','find','encontrar','read ui','ler interface'], summary: 'Observe processes, windows, or controls and return fresh target references.' },
  { id: 'key', tool: 'ui_send_keys', profile: 'legacy', aliases: ['key','press key','pressionar tecla','press enter','pressionar enter','send keys','enviar teclas'], summary: 'Press a key using ui_send_keys in the legacy profile; the compact action schema does not support keypresses.' },
  { id: 'act', tool: 'aipm_act', aliases: ['act','agir','click','clicar','fill','preencher','write','escrever','select','selecionar','escolher'], summary: 'Perform one click, fill, or select against a fresh target reference.' },
  { id: 'wait', tool: 'aipm_wait', aliases: ['wait','esperar','aguardar','poll','operation status','estado da operacao'], summary: 'Read one operation receipt, or poll it for a declared timeout.' },
  { id: 'explain', tool: 'aipm_explain', aliases: ['explain','explicar','help','ajuda','capability','capacidade','what can you do','o que voce faz'], summary: 'Explain a capability or failure and the permitted next step.' }
];
function normalize(value) { return String(value || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' '); }
function findCapability(query) { const q=normalize(query); if(!q)return null; return CAPABILITIES.find(function(c){return normalize(c.id)===q||normalize(c.tool)===q||c.aliases.some(function(a){const t=normalize(a);return q===t||q.indexOf(t)>=0;});})||null; }
module.exports={CONTRACT_VERSION,CAPABILITIES,normalize,findCapability};
