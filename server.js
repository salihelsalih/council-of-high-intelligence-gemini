const http = require('http');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

// ─── Load .env file (simple parser, no dotenv dependency) ─────────────────────
function loadEnvFile() {
  try {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return;
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx < 1) continue;
      const key   = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
      if (!process.env[key]) process.env[key] = value;
    }
  } catch (_) {}
}
loadEnvFile();

// ─── Gemini SDK (lazy-loaded after key check) ─────────────────────────────────
function getApiKey() {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (key) return key;
  console.error('\n❌  No Gemini API key found.');
  console.error('    → Create a .env file in this folder with: GEMINI_API_KEY=your_key_here');
  console.error('    → Or set the environment variable: GEMINI_API_KEY=your_key_here\n');
  process.exit(1);
}

const { GoogleGenerativeAI } = require('@google/generative-ai');
const genAI = new GoogleGenerativeAI(getApiKey());

// ─── Model list (priority order, fallback down the list on quota/error) ─────────
// Only models confirmed via ListModels API as supporting generateContent
const MODEL_LIST = [
  'gemini-2.5-flash',           // Primary — best quality
  'gemini-3-flash-preview',     // Gemini 3 Flash
  'gemini-flash-latest',        // Alias for latest flash
  'gemini-flash-lite-latest',   // Lite alias
  'gemini-2.5-flash-lite',      // 2.5 Lite
  'gemini-2.0-flash',           // Stable 2.0 Flash
  'gemini-2.0-flash-lite',      // 2.0 Lite
  'gemma-4-31b-it',             // Gemma 4 31B (open model)
  'gemma-4-26b-a4b-it',         // Gemma 4 26B MoE
  'gemini-3.1-flash-lite',      // 3.1 Flash Lite
  'gemini-3.1-flash-lite-preview', // 3.1 Flash Lite Preview
  'gemini-3-pro-preview',       // Last resort — Pro (slower)
];

// Track model state:
//   { quotaExceeded: bool, exceededAt: timestamp }  → temporary (cooldown)
//   { permanent: true }                               → 404 / unsupported (skip all session)
const modelState = {};

// Cooldown before retrying a quota-exceeded model (30 min)
const QUOTA_COOLDOWN_MS = 30 * 60 * 1000;

function getAvailableModel() {
  const now = Date.now();
  for (const name of MODEL_LIST) {
    const s = modelState[name];
    if (!s) return name;                         // Never tried → available
    if (s.permanent) continue;                  // 404/unsupported → skip forever
    if (!s.quotaExceeded) return name;           // Not in quota → available
    // Cooldown expired → reset quota
    if (now - s.exceededAt >= QUOTA_COOLDOWN_MS) {
      modelState[name].quotaExceeded = false;
      console.log(`♻️  Cooldown elapsed — retrying model: ${name}`);
      return name;
    }
  }
  // All non-permanent models quota-exceeded — pick the one exceeded longest ago
  let oldest = null, oldestAt = Infinity;
  for (const name of MODEL_LIST) {
    const s = modelState[name];
    if (s?.permanent) continue;
    if (s && s.exceededAt < oldestAt) { oldestAt = s.exceededAt; oldest = name; }
  }
  if (oldest) {
    modelState[oldest].quotaExceeded = false;
    console.log(`⚠️  All models exhausted. Forcing retry with: ${oldest}`);
    return oldest;
  }
  return MODEL_LIST[0];
}

function markPermanentlyUnavailable(name) {
  modelState[name] = { permanent: true };
  console.log(`🚫 Model [${name}] is permanently unavailable (404/unsupported) — skipping.`);
}

function markQuotaExceeded(name) {
  modelState[name] = { quotaExceeded: true, exceededAt: Date.now() };
  const remaining = MODEL_LIST.filter(m => !modelState[m]?.quotaExceeded && !modelState[m]?.permanent);
  console.log(`🔴 Quota exceeded on [${name}]. Available: [${remaining.join(', ') || 'none'}]`);
}

function isPermanentError(err) {
  if (!err) return false;
  const status  = err.status || err.code || 0;
  const fullStr = (JSON.stringify(err) + ' ' + String(err)).toLowerCase();
  return (
    status === 404 ||
    fullStr.includes('404') ||
    fullStr.includes('not found') ||
    fullStr.includes('not supported for generatecontent') ||
    fullStr.includes('does not exist')
  );
}

function isQuotaError(err) {
  if (!err) return false;
  const status  = err.status || err.code || 0;
  // Serialize the full error for string-based checks (Gemini SDK wraps errors)
  const fullStr = (JSON.stringify(err) + ' ' + String(err)).toLowerCase();
  return (
    status === 429 ||
    status === 500 ||  // Internal server error — treat as transient, skip to next model
    status === 503 ||
    status === 502 ||
    fullStr.includes('resource_exhausted') ||
    fullStr.includes('quota') ||
    fullStr.includes('rate limit') ||
    fullStr.includes('overloaded') ||
    fullStr.includes('service unavailable') ||
    fullStr.includes('internal error') ||
    fullStr.includes('high demand') ||
    fullStr.includes('429') ||
    fullStr.includes('500') ||
    fullStr.includes('503')
  );
}

// ─── Core LLM call with automatic model fallback ──────────────────────────────

// Only Gemini 2.5+ supports thinkingConfig — Gemma and older Gemini models return 400
function supportsThinking(modelName) {
  return /gemini-2\.5|gemini-3/.test(modelName);
}

async function generate(systemInstruction, userMessage, maxTokens = 700) {
  const tried = new Set();

  while (tried.size < MODEL_LIST.length) {
    const modelName = getAvailableModel();
    if (tried.has(modelName)) break;  // full loop, give up
    tried.add(modelName);

    try {
      console.log(`   🤖 [${modelName}] generating...`);
      const model = genAI.getGenerativeModel({
        model: modelName,
        systemInstruction,
        generationConfig: {
          maxOutputTokens: maxTokens,
          temperature: 0.85,
          // Disable thinking output — only for models that support thinkingConfig
          // (Gemini 2.5+ / Gemini 3+). Gemma and older Gemini return 400 if set.
          ...(supportsThinking(modelName) ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
        },
      });

      const result   = await model.generateContent(userMessage);
      const response = result.response;

      // Filter out "thought" parts — thinking models include internal reasoning
      // as parts with thought:true. response.text() includes them; we exclude them.
      let text;
      try {
        const parts = response.candidates?.[0]?.content?.parts ?? [];
        const nonThought = parts.filter(p => !p.thought).map(p => p.text ?? '').join('');
        text = nonThought.trim() || response.text(); // fallback to .text() if empty
      } catch (_) {
        text = response.text();
      }

      return { text, model: modelName };


    } catch (err) {
      if (isPermanentError(err)) {
        markPermanentlyUnavailable(modelName);
        continue;
      }
      if (isQuotaError(err)) {
        markQuotaExceeded(modelName);
        continue;
      }
      // Hard error — re-throw
      throw err;
    }
  }
  throw new Error('All Gemini models exhausted. Please check your quotas or try again later.');
}

// ─── Agent / persona system ───────────────────────────────────────────────────
const PORT       = 3131;
const AGENTS_DIR = path.join(__dirname, 'agents');

function loadAgents() {
  const agents = {};
  if (!fs.existsSync(AGENTS_DIR)) return agents;
  for (const file of fs.readdirSync(AGENTS_DIR).filter(f => f.endsWith('.md'))) {
    const name    = file.replace('.md', '');
    const content = fs.readFileSync(path.join(AGENTS_DIR, file), 'utf8');
    agents[name]  = content.replace(/^---[\s\S]*?---\n/, '').trim();
  }
  return agents;
}
const AGENTS = loadAgents();

const MEMBERS = {
  aristotle:  { name: 'Aristotle',        domain: 'Categorization & structure',   style: 'You classify and categorize everything. You seek to understand essence, genus, and differentia. You build taxonomies and find first causes.' },
  socrates:   { name: 'Socrates',          domain: 'Assumption destruction',        style: 'You question every assumption. You use the Socratic method — asking probing questions that expose contradictions. You never claim to know the answer.' },
  'sun-tzu':  { name: 'Sun Tzu',           domain: 'Adversarial strategy',          style: 'You analyze terrain, competition, and power dynamics. You think in terms of strategic position, timing, and winning without fighting.' },
  ada:        { name: 'Ada Lovelace',      domain: 'Formal systems',                style: 'You think in formal systems, abstractions, and what can or cannot be mechanized. You distinguish between what is computable and what is not.' },
  aurelius:   { name: 'Marcus Aurelius',   domain: 'Resilience & moral clarity',    style: 'You focus on what is within your control. You value duty, virtue, and equanimity. You ask what the Stoic path demands.' },
  machiavelli:{ name: 'Machiavelli',       domain: 'Power dynamics',                style: 'You analyze how power actually works, not how it should work. You think about incentives, appearances, and ruthless pragmatism.' },
  'lao-tzu':  { name: 'Lao Tzu',           domain: 'Non-action & emergence',        style: 'You believe in wu wei — non-action and allowing things to emerge naturally. You question whether intervention makes things worse. Less is more.' },
  feynman:    { name: 'Feynman',           domain: 'First principles',               style: 'You build from the bottom up. You refuse to proceed past anything you cannot explain simply. If you cannot explain it to a 12-year-old, you do not understand it.' },
  torvalds:   { name: 'Linus Torvalds',    domain: 'Pragmatic engineering',          style: 'You are blunt and pragmatic. Working software ships. Talk is cheap. You have no patience for over-engineering or theoretical purity that does not produce results.' },
  musashi:    { name: 'Miyamoto Musashi',  domain: 'Strategic timing',               style: 'You believe in reading the moment. The decisive strike comes only when conditions are perfect. Premature action wastes advantage. Patience is a weapon.' },
  watts:      { name: 'Alan Watts',        domain: 'Perspective & reframing',        style: 'You dissolve false problems. You reframe the question itself. You ask whether the anxiety around the question is itself the real problem.' },
  karpathy:   { name: 'Andrej Karpathy',  domain: 'Empirical ML',                   style: 'You build, measure, and iterate. You trust empirical results over theory. You know how models actually learn and fail, not how papers claim they do.' },
  sutskever:  { name: 'Ilya Sutskever',   domain: 'AI safety & scaling',             style: 'You think about capability frontiers and existential risks. You believe scaling reveals emergent properties. Safety must come before capability.' },
  kahneman:   { name: 'Daniel Kahneman',  domain: 'Cognitive bias',                  style: 'You identify the cognitive bias in the question and in every answer. System 1 thinking is the enemy. Your own reasoning process is the first thing to audit.' },
  meadows:    { name: 'Donella Meadows',  domain: 'Systems thinking',                style: 'You see feedback loops, leverage points, and systemic structures. You ask: what is the system producing this behavior? Fix the system, not the symptom.' },
  munger:     { name: 'Charlie Munger',   domain: 'Multi-model reasoning',           style: 'You invert everything. What would guarantee failure? You use a lattice of mental models and avoid over-reliance on any single framework.' },
  taleb:      { name: 'Nassim Taleb',     domain: 'Antifragility & tail risk',       style: 'You think about hidden risks, black swans, and tail events. The average case is irrelevant — design for the tail. Fragility is hidden until it is not.' },
  rams:       { name: 'Dieter Rams',      domain: 'User-centered design',            style: 'Less, but better. Good design is honest and unobtrusive. You always ask: what does the user actually need, not what is technically impressive.' },
};

const TRIADS = {
  career:           ['kahneman', 'munger',    'watts'],
  learning:         ['kahneman', 'munger',    'watts'],
  ai:               ['karpathy', 'sutskever', 'ada'],
  'machine learning':['karpathy','sutskever', 'ada'],
  security:         ['taleb',    'sun-tzu',   'aurelius'],
  cyber:            ['taleb',    'sun-tzu',   'aurelius'],
  strategy:         ['sun-tzu',  'machiavelli','aurelius'],
  architecture:     ['aristotle','ada',        'feynman'],
  shipping:         ['torvalds', 'musashi',    'feynman'],
  product:          ['torvalds', 'machiavelli','watts'],
  decision:         ['kahneman', 'munger',     'aurelius'],
  systems:          ['meadows',  'lao-tzu',    'aristotle'],
  design:           ['rams',     'torvalds',   'watts'],
  risk:             ['taleb',    'sun-tzu',    'aurelius'],
  economics:        ['munger',   'machiavelli','sun-tzu'],
};

const DUO_PAIRS = {
  ai:           ['karpathy',  'sutskever'],
  security:     ['taleb',     'sun-tzu'],
  cyber:        ['taleb',     'sun-tzu'],
  ship:         ['torvalds',  'musashi'],
  architecture: ['aristotle', 'lao-tzu'],
  decision:     ['kahneman',  'feynman'],
  systems:      ['meadows',   'torvalds'],
};

function selectTriad(question) {
  const q = question.toLowerCase();
  for (const [kw, members] of Object.entries(TRIADS)) {
    if (q.includes(kw)) return { domain: kw, members };
  }
  return { domain: 'decision', members: ['kahneman', 'munger', 'aurelius'] };
}

function selectDuo(question) {
  const q = question.toLowerCase();
  for (const [kw, pair] of Object.entries(DUO_PAIRS)) {
    if (q.includes(kw)) return pair;
  }
  return ['socrates', 'feynman'];
}

// ─── Persona calls ─────────────────────────────────────────────────────────────
async function runMemberAnalysis(memberId, question, otherOutputs = null) {
  const m            = MEMBERS[memberId];
  const agentContent = AGENTS[`council-${memberId}`] || '';

  const langRule = 'ZORUNLU DİL KURALI: Soru hangi dildeyse yanıt da o dilde olacak. Soru Türkçeyse yanıt tamamen Türkçe olacak — tek bir İngilizce kelime bile kullanma. Yalnızca özel isimler (kişi adı, kavram adı) orijinal haliyle kalabilir.';

  const system = agentContent
    ? agentContent + `\n\n${langRule}`
    : `You are ${m.name}, the ${m.domain} expert. ${m.style}\n\n${langRule}`;

  const userMsg = otherOutputs
    ? `Diğer üyelerin analizleri:\n\n${otherOutputs}\n\n"Output Format (Council Round 2)" yapını kullanarak final pozisyonunu ver. Maksimum 50 kelime. Kısa ve keskin ol.\n\n${langRule}\n\nYALNIZCA final yanıtı yaz. Taslak, kelime sayımı, düşünce adımı YASAK.`
    : `Ele alınan soru:\n\n${question}\n\n"Output Format (Standalone)" yapını kullanarak analiz yap. Maksimum 120 kelime. Gereksiz tekrar yok, kısa tut.\n\n${langRule}\n\nYALNIZCA final yanıtı yaz. Taslak, düşünce adımı YASAK.`;

  const maxTok = otherOutputs ? 400 : 900;
  const { text, model } = await generate(system, userMsg, maxTok);
  console.log(`   ✅ ${m.name} → ${model}`);
  return text;
}

async function synthesizeVerdict(question, members, analyses, mode, triadDomain) {
  const memberList  = members.map(id => `${MEMBERS[id].name} (${MEMBERS[id].domain})`).join(', ');
  const allAnalyses = members.map((id, i) => `### ${MEMBERS[id].name}\n${analyses[i]}`).join('\n\n');
  const langRule = 'ZORUNLU DİL KURALI: Soru Türkçeyse tüm yanıt tamamen Türkçe olacak. Başlıklar dahil hiçbir yerde İngilizce kullanma. Yalnızca kişi adları orijinal haliyle kalabilir.';

  const system  = `You are the Council Coordinator synthesizing a deliberation verdict. Be direct and structured. ${langRule}`;
  const userMsg = `Soru: "${question}"

Konsey üyeleri (${mode} mod, ${triadDomain}): ${memberList}

Analizler:
${allAnalyses}

${langRule}

Yapılandırılmış Konsey Kararı üret (soruyla aynı dilde):
## ⚖️ Konsey Kararı

### 🎯 Önerilen Eylem
[Tek somut öneri]

### 🧠 Üyelerin Katkıları
[Üye başına 1-2 cümle]

### 🤝 Uzlaştıkları Nokta
[Ortak zemin]

### ⚡ Ayrıştıkları Nokta
[Gerçek gerilim noktaları]

### ❓ Cevapsız Sorular
[Konseyin cevaplayamadığı şeyler]

### 📊 Güven Düzeyi
[Yüksek/Orta/Düşük + kısa gerekçe]`;

  const { text, model } = await generate(system, userMsg, 2000);
  console.log(`   ✅ Verdict → ${model}`);
  return text;
}

// ─── Full Mode — 7-step protocol functions ────────────────────────────────────

// Step 2: Problem Restate Gate — member restates + alternative framing
async function fullRestate(memberId, question) {
  const m = MEMBERS[memberId];
  const agentContent = AGENTS[`council-${memberId}`] || '';
  const langRule = 'ZORUNLU DİL KURALI: Soru Türkçeyse tamamen Türkçe yaz. Tek İngilizce kelime kullanma (özel isimler hariç).';
  const system = agentContent
    ? agentContent + `\n\n${langRule}`
    : `You are ${m.name}, the ${m.domain} expert. ${m.style}\n\n${langRule}`;
  const userMsg = `Soru: ${question}\n\nProblem Restate Gate: 2 cümlede soruyu kendi çerçevenden yeniden tanımla + başkalarının kaçırdığı 1 alternatif çerçeve sun. Kısa ve keskin.\n\n${langRule}\n\nSADECE final yanıtı yaz.`;
  const { text, model } = await generate(system, userMsg, 300);
  console.log(`   ✅ [Restate] ${m.name} → ${model}`);
  return text;
}

// Step 3: Round 1 — Independent analysis (200 words max)
async function fullRound1(memberId, question) {
  const m = MEMBERS[memberId];
  const agentContent = AGENTS[`council-${memberId}`] || '';
  const langRule = 'ZORUNLU DİL KURALI: Soru Türkçeyse tamamen Türkçe yaz. Tek İngilizce kelime kullanma (özel isimler hariç).';
  const system = agentContent
    ? agentContent + `\n\n${langRule}`
    : `You are ${m.name}, the ${m.domain} expert. ${m.style}\n\n${langRule}`;
  const userMsg = `Soru: ${question}\n\nRound 1 — Bağımsız Analiz: "Output Format (Standalone)" yapını kullan. Maksimum 200 kelime. Kısa ve öz ol.\n\n${langRule}\n\nSADECE final yanıtı yaz. Taslak yasak.`;
  const { text, model } = await generate(system, userMsg, 1200);
  console.log(`   ✅ [R1] ${m.name} → ${model}`);
  return text;
}

// Step 4: Round 2 — Cross-examination (150 words, engage 2+ others)
async function fullRound2(memberId, question, allR1) {
  const m = MEMBERS[memberId];
  const agentContent = AGENTS[`council-${memberId}`] || '';
  const langRule = 'ZORUNLU DİL KURALI: Soru Türkçeyse tamamen Türkçe yaz. Tek İngilizce kelime kullanma (özel isimler hariç).';
  const system = agentContent
    ? agentContent + `\n\n${langRule}`
    : `You are ${m.name}, the ${m.domain} expert. ${m.style}\n\n${langRule}`;
  const userMsg = `Diğer üyelerin Round 1 analizleri:\n\n${allR1}\n\nRound 2 — Çapraz Sorgu: En az 2 üyenin kör noktasını eleştir. "Output Format (Council Round 2)" yapını kullan. Maksimum 150 kelime. Kısa ve keskin ol.\n\n${langRule}\n\nSADECE final yanıtı yaz. Taslak yasak.`;
  const { text, model } = await generate(system, userMsg, 900);
  console.log(`   ✅ [R2] ${m.name} → ${model}`);
  return text;
}

// Step 5: Enforcement scan — check dissent, novelty, anti-groupthink
async function fullEnforcementScan(question, members, r2analyses) {
  const memberList  = members.map(id => MEMBERS[id].name).join(', ');
  const allR2 = members.map((id, i) => `### ${MEMBERS[id].name}\n${r2analyses[i]}`).join('\n\n');
  const system = `You are the Council Enforcement Officer. Your job is to detect premature convergence and groupthink. Be blunt. Respond in the same language as the question.`;
  const userMsg = `Question: "${question}"\nMembers: ${memberList}\n\nRound 2 positions:\n${allR2}\n\nEnforcement Scan — check all three:\n1. DISSENT QUOTA: Is any member agreeing too easily without real challenge? Name them.\n2. NOVELTY GATE: Has any genuinely new perspective been introduced in R2? Or is it just restating R1?\n3. AGREEMENT CHECK: If >70% converge on the same answer, force the strongest dissenter to steelman the opposing view in 2 sentences.\n\nReport findings concisely. If a steelman is needed, write it. Respond in the same language as the question.\n\nCRITICAL: Output ONLY the enforcement report. No drafts, no thinking steps.`;
  const { text, model } = await generate(system, userMsg, 800);
  console.log(`   ✅ [Enforcement] → ${model}`);
  return text;
}

// Step 6: Round 3 — Final crystallization (60 words max)
async function fullRound3(memberId, question, r1, r2, enforcementNote) {
  const m = MEMBERS[memberId];
  const agentContent = AGENTS[`council-${memberId}`] || '';
  const langRule = 'ZORUNLU DİL KURALI: Soru Türkçeyse tamamen Türkçe yaz. Tek İngilizce kelime kullanma (özel isimler hariç).';
  const system = agentContent
    ? agentContent + `\n\n${langRule}`
    : `You are ${m.name}, the ${m.domain} expert. ${m.style}\n\n${langRule}`;
  const userMsg = `Round 1 analizin:\n${r1}\n\nRound 2 çapraz sorgun:\n${r2}\n\nEnforcement notu:\n${enforcementNote}\n\nRound 3 — Final Kristalizasyon: Kesin pozisyonunu maksimum 60 kelimede yaz. Net ve kararlı ol, belirsizlik yok.\n\n${langRule}\n\nSADECE final pozisyonu yaz.`;
  const { text, model } = await generate(system, userMsg, 400);
  console.log(`   ✅ [R3] ${m.name} → ${model}`);
  return text;
}

// Step 7: Full mode verdict synthesis
async function synthesizeFullVerdict(question, members, restates, r3positions, triadDomain) {
  const memberList  = members.map(id => `${MEMBERS[id].name} (${MEMBERS[id].domain})`).join(', ');
  const allRestate  = members.map((id, i) => `**${MEMBERS[id].name}:** ${restates[i]}`).join('\n');
  const allR3       = members.map((id, i) => `### ${MEMBERS[id].name}\n${r3positions[i]}`).join('\n\n');
  const langRule = 'ZORUNLU DİL KURALI: Soru Türkçeyse tüm yanıt tamamen Türkçe olacak. Başlıklar dahil hiçbir yerde İngilizce kullanma. Yalnızca kişi adları orijinal haliyle kalabilir.';

  const system = `You are the Council Coordinator synthesizing a 3-round full deliberation verdict. Lead with what the council does NOT know. Be direct and structured. ${langRule}`;
  const userMsg = `Soru: "${question}"\nKonsey (full mod, ${triadDomain}): ${memberList}\n\nSorunun yeniden çerçevelenmeleri:\n${allRestate}\n\nFinal pozisyonları (Round 3):\n${allR3}\n\n${langRule}\n\nYapılandırılmış Konsey Kararı üret:
## ⚖️ Konsey Kararı (Full Mod)

### ❓ Cevapsız Sorular
[Bununla başla — konseyin cevaplayamadığı şeyler ve nedeni. Bu uzlaşmadan daha önemli.]

### 🎯 Önerilen Eylem
[Tek somut öneri — anlaşmazlığa rağmen en savunulabilir adım]

### 🧠 Üyelerin Katkıları
[Üye başına 1-2 cümle — en önemli katkıları]

### 🤝 Uzlaştıkları Nokta
[Yalnızca gerçek ortak zemin]

### ⚡ Ayrıştıkları Nokta
[Çözülemez gerilim noktaları — örtbas etme]

### 🔭 Sonraki Adımlar
[Harekete geçmeden önce araştırılması gerekenler]

### 📊 Güven Düzeyi
[Yüksek/Orta/Düşük + gerekçe]`;

  const { text, model } = await generate(system, userMsg, 2500);
  console.log(`   ✅ [Full Verdict] → ${model}`);
  return text;
}

// ─── HTTP Server ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // ── Serve index.html ──
  if (req.method === 'GET' && req.url === '/') {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  // ── Model status endpoint ──
  if (req.method === 'GET' && req.url === '/status') {
    const now    = Date.now();
    const status = MODEL_LIST.map(name => {
      const s          = modelState[name];
      if (s?.permanent) return { name, available: false, reason: 'unsupported', cooldownSec: 0 };
      const exceeded   = s?.quotaExceeded ?? false;
      const cooldownMs = exceeded ? Math.max(0, QUOTA_COOLDOWN_MS - (now - s.exceededAt)) : 0;
      return { name, available: !exceeded, reason: exceeded ? 'quota' : 'ok', cooldownSec: Math.round(cooldownMs / 1000) };
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ models: status, activeModel: getAvailableModel() }));
    return;
  }

  // ── Council deliberation endpoint ──
  if (req.method === 'POST' && req.url === '/council') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { question, mode } = JSON.parse(body);

        res.writeHead(200, {
          'Content-Type':  'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection':    'keep-alive',
        });

        const send = (event, data) =>
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

        // Determine members
        let selectedMembers, triadDomain;
        const actualMode = mode || 'quick';

        if (actualMode === 'duo') {
          selectedMembers = selectDuo(question);
          triadDomain     = 'duo';
        } else {
          const triad     = selectTriad(question);
          selectedMembers = triad.members;
          triadDomain     = triad.domain;
        }

        const activeModel = getAvailableModel();
        send('status', {
          message:     `🏛️ Council convened: ${selectedMembers.map(id => MEMBERS[id].name).join(', ')}`,
          triad:       triadDomain,
          activeModel,
        });

        // ── Round 1: Independent analysis ──
        const analyses = [];
        for (const memberId of selectedMembers) {
          send('status', { message: `📜 ${MEMBERS[memberId].name} analyzing...` });
          const analysis = await runMemberAnalysis(memberId, question);
          analyses.push(analysis);
          send('member', {
            id:       memberId,
            name:     MEMBERS[memberId].name,
            domain:   MEMBERS[memberId].domain,
            analysis,
            model:    getAvailableModel(),
          });
        }

        // ── Quick / Duo: Round 2 cross-examination & verdict (UNCHANGED) ──
        if (actualMode === 'quick' || actualMode === 'duo') {
          send('status', { message: '⚔️ Cross-examining positions...' });

          const finalPositions = [];
          for (let i = 0; i < selectedMembers.length; i++) {
            const memberId     = selectedMembers[i];
            const otherAnalyses = selectedMembers
              .filter((_, j) => j !== i)
              .map(id => `${MEMBERS[id].name}: ${analyses[selectedMembers.indexOf(id)]}`)
              .join('\n\n');
            const final = await runMemberAnalysis(memberId, question, otherAnalyses);
            finalPositions.push(final);
            send('final', { id: memberId, name: MEMBERS[memberId].name, position: final });
          }

          send('status', { message: '⚖️ Synthesizing verdict...' });
          const verdict = await synthesizeVerdict(question, selectedMembers, finalPositions, actualMode, triadDomain);
          send('verdict', { text: verdict });
        }

        // ── Full Mode: 7-step protocol (Steps 2-7, Step 1 = provider routing above) ──
        if (actualMode === 'full') {
          // Step 2: Problem Restate Gate
          send('status', { message: '🔄 Problem Restate Gate — members reframing the question...' });
          const restates = [];
          for (const memberId of selectedMembers) {
            send('status', { message: `🔄 ${MEMBERS[memberId].name} reframing...` });
            const restate = await fullRestate(memberId, question);
            restates.push(restate);
            send('restate', { id: memberId, name: MEMBERS[memberId].name, domain: MEMBERS[memberId].domain, text: restate });
          }

          // Step 3: Round 1 — Independent Analysis (already done above, but fullRound1 gives 400-word version)
          // We already ran runMemberAnalysis for Round 1 display — now run the deeper 400-word version
          send('status', { message: '📜 Round 1 — Deep independent analysis (400 words)...' });
          const r1analyses = [];
          for (const memberId of selectedMembers) {
            send('status', { message: `📜 ${MEMBERS[memberId].name} deep analysis...` });
            const r1 = await fullRound1(memberId, question);
            r1analyses.push(r1);
            send('r1', { id: memberId, name: MEMBERS[memberId].name, domain: MEMBERS[memberId].domain, analysis: r1 });
          }

          // Step 4: Round 2 — Cross-Examination
          send('status', { message: '⚔️ Round 2 — Cross-Examination (members challenge each other)...' });
          const r2analyses = [];
          for (let i = 0; i < selectedMembers.length; i++) {
            const memberId = selectedMembers[i];
            const othersR1 = selectedMembers
              .filter((_, j) => j !== i)
              .map(id => `${MEMBERS[id].name}: ${r1analyses[selectedMembers.indexOf(id)]}`)
              .join('\n\n');
            send('status', { message: `⚔️ ${MEMBERS[memberId].name} cross-examining...` });
            const r2 = await fullRound2(memberId, question, othersR1);
            r2analyses.push(r2);
            send('crossexam', { id: memberId, name: MEMBERS[memberId].name, domain: MEMBERS[memberId].domain, text: r2 });
          }

          // Step 5: Post-Round Enforcement Scan
          send('status', { message: '🔍 Enforcement Scan — checking for groupthink & dissent...' });
          const enforcement = await fullEnforcementScan(question, selectedMembers, r2analyses);
          send('enforcement', { text: enforcement });

          // Step 6: Round 3 — Final Crystallization
          send('status', { message: '💎 Round 3 — Final Crystallization (100 words)...' });
          const r3positions = [];
          for (let i = 0; i < selectedMembers.length; i++) {
            const memberId = selectedMembers[i];
            send('status', { message: `💎 ${MEMBERS[memberId].name} crystallizing final position...` });
            const r3 = await fullRound3(memberId, question, r1analyses[i], r2analyses[i], enforcement);
            r3positions.push(r3);
            send('crystallize', { id: memberId, name: MEMBERS[memberId].name, domain: MEMBERS[memberId].domain, position: r3 });
          }

          // Step 7: Full Verdict Synthesis
          send('status', { message: '⚖️ Synthesizing full verdict...' });
          const fullVerdict = await synthesizeFullVerdict(question, selectedMembers, restates, r3positions, triadDomain);
          send('verdict', { text: fullVerdict });
        }

        send('done', {});
        res.end();

      } catch (err) {
        console.error('❌ Council error:', err.message);
        res.write(`event: error\ndata: ${JSON.stringify({ message: err.message })}\n\n`);
        res.end();
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log('\n🏛️  Council of High Intelligence  —  Gemini Edition');
  console.log(`   Running at:  http://localhost:${PORT}`);
  console.log(`   Models (${MODEL_LIST.length}): ${MODEL_LIST.slice(0, 3).join(', ')} ...`);
  console.log('\n   Press Ctrl+C to stop\n');
  const { exec } = require('child_process');
  exec(`start http://localhost:${PORT}`);
});
