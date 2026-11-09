require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');
const scenario = require('./data/case');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const db = new Database(path.join(__dirname, 'data', 'sessions.sqlite'));
db.pragma('journal_mode = WAL');
db.exec(`CREATE TABLE IF NOT EXISTS sessions (
 id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 state TEXT NOT NULL
)`);
app.use(helmet({ contentSecurityPolicy: { directives: {
  defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"],
  imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"], objectSrc: ["'none'"],
  baseUri: ["'self'"], formAction: ["'self'"]
}}}));
app.use(express.json({limit:'30kb'}));
app.use('/api/', rateLimit({windowMs:60_000, limit:40, standardHeaders:true, legacyHeaders:false}));
app.use(express.static(path.join(__dirname, 'public')));

const now = () => new Date().toISOString();
function newState() { return { messages: [], askedTopics: [], exams: [], treatments: [], notes: [], startedAt: now(), finished: false }; }
function loadSession(id) {
  const row = db.prepare('SELECT state FROM sessions WHERE id=?').get(id);
  if (!row) return null;
  try { return JSON.parse(row.state); } catch { return null; }
}
function saveSession(id, state) {
  db.prepare(`INSERT INTO sessions(id,created_at,updated_at,state) VALUES(?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at,state=excluded.state`)
    .run(id, state.startedAt, now(), JSON.stringify(state));
}
function validId(id) { return typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id); }
function getState(req,res) {
  const id = req.params.id;
  if (!validId(id)) { res.status(400).json({error:'Некорректный идентификатор сессии'}); return null; }
  const state = loadSession(id);
  if (!state) { res.status(404).json({error:'Сессия не найдена'}); return null; }
  return state;
}

app.post('/api/sessions', (req,res) => {
  const id = crypto.randomUUID(); const state = newState(); saveSession(id,state);
  res.json({id, scenario:{title:scenario.title,specialty:scenario.specialty,patient:{age:scenario.patient.age,sex:scenario.patient.sex,opening:scenario.patient.opening}}});
});
app.get('/api/sessions/:id', (req,res) => {
  const state=getState(req,res); if(!state) return;
  res.json({state, scenario:{title:scenario.title,specialty:scenario.specialty,examinations:scenario.examinations.map(({id,name,category,minutes})=>({id,name,category,minutes})), treatments:scenario.treatments}});
});

async function askModel({state, question}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('На сервере не задан OPENAI_API_KEY. Добавьте ключ в переменные окружения сервера.');
  const history = state.messages.slice(-18).map(m => ({role:m.role, content:m.content}));
  const facts = scenario.patient.facts.map(f => `${f.topic}: ${f.answer}`).join('\n');
  const system = `Ты играешь роль стандартизированного виртуального пациента в учебном клиническом симуляторе для студентов-медиков. Говори естественно, коротко, от первого лица, без медицинской терминологии, если пациент её не знает. Не подсказывай диагноз, не обучай и не оценивай действия. Отвечай только на заданный вопрос. Не выдумывай новые факты. Если вопрос касается факта, которого нет в карте, скажи, что не помнишь или не знаешь. Если вопрос непонятен — попроси уточнить. Сохраняй характер 64-летнего встревоженного, но контактного пациента. Это симуляция, не реальная медицинская консультация.\nКАРТА ПАЦИЕНТА (скрытая от обучающегося):\n${facts}\nНачальная жалоба: ${scenario.patient.opening}`;
  const response = await fetch('https://api.openai.com/v1/responses', {
    method:'POST', headers:{'Authorization':`Bearer ${apiKey}`,'Content-Type':'application/json'},
    body:JSON.stringify({model:process.env.OPENAI_MODEL || 'gpt-4.1-mini',instructions:system,input:[...history,{role:'user',content:question}],max_output_tokens:220,store:false})
  });
  if(!response.ok) { const detail=await response.text(); console.error('OpenAI API error:',response.status,detail.slice(0,500)); throw new Error('Сервис виртуального пациента временно недоступен. Попробуйте ещё раз.'); }
  const data=await response.json();
  const answer=(data.output||[]).flatMap(x=>x.content||[]).filter(x=>x.type==='output_text').map(x=>x.text).join('\n').trim();
  if(!answer) throw new Error('Не удалось получить ответ пациента. Повторите вопрос.');
  return answer;
}
app.post('/api/sessions/:id/patient', async (req,res) => {
  const state=getState(req,res); if(!state) return;
  const question=String(req.body.question||'').trim();
  if(question.length<2 || question.length>1000) return res.status(400).json({error:'Введите вопрос длиной от 2 до 1000 символов.'});
  try {
    const answer=await askModel({state,question});
    state.messages.push({role:'user',content:question},{role:'assistant',content:answer});
    saveSession(req.params.id,state); res.json({answer,state});
  } catch(e) { res.status(503).json({error:e.message}); }
});
app.post('/api/sessions/:id/exams', (req,res) => {
  const state=getState(req,res); if(!state) return;
  const item=scenario.examinations.find(x=>x.id===req.body.examId);
  if(!item) return res.status(400).json({error:'Неизвестное исследование.'});
  if(!state.exams.includes(item.id)) state.exams.push(item.id);
  saveSession(req.params.id,state);
  res.json({result:item.result,state});
});
app.post('/api/sessions/:id/treatments', (req,res) => {
  const state=getState(req,res); if(!state) return;
  const item=scenario.treatments.find(x=>x.id===req.body.treatmentId);
  if(!item) return res.status(400).json({error:'Неизвестное лечебное мероприятие.'});
  if(!state.treatments.includes(item.id)) state.treatments.push(item.id);
  saveSession(req.params.id,state); res.json({state});
});
app.post('/api/sessions/:id/notes', (req,res) => {
  const state=getState(req,res); if(!state) return;
  const note=String(req.body.note||'').trim();
  if(!note || note.length>3000) return res.status(400).json({error:'Запись должна содержать от 1 до 3000 символов.'});
  state.notes.push({text:note,at:now()}); saveSession(req.params.id,state); res.json({state});
});
app.post('/api/sessions/:id/finish', (req,res) => {
  const state=getState(req,res); if(!state) return;
  const diagnosis=String(req.body.diagnosis||'').slice(0,500);
  const reasoning=String(req.body.reasoning||'').slice(0,3000);
  state.finished=true; state.final={diagnosis,reasoning,at:now()}; saveSession(req.params.id,state);
  res.json({state,review:{expectedProblem:scenario.teaching.expectedProblem,differential:scenario.teaching.differential,critical:scenario.teaching.critical,completedExams:state.exams.length,completedTreatments:state.treatments.length}});
});

app.use((err,req,res,next)=>{ console.error(err); res.status(500).json({error:'Внутренняя ошибка сервера.'}); });
app.listen(PORT,()=>console.log(`Clinical Simulator запущен на порту ${PORT}`));
