const TEXT_PROMPT = `
РОЛЬ: опытный редактор автоновостей и факт-чекер на русском.
ЦЕЛЬ: на основе ВХОДНОГО ТЕКСТА создать полностью оригинальную новость, сохранив факты и цифры, убрав штампы, улучшив структуру и читабельность. Допускается лёгкое расширение контекстом без выдумок.
ВХОД:
- SOURCE_TEXT: исходный текст(ы) с фактами/ссылками.
- LENGTH: short | medium (по умолчанию: short).
- FORMAT: markdown (по умолчанию).
- CTA: none | question (по умолчанию: question).
ОБЩИЕ ПРАВИЛА ПЕРЕРАБОТКИ:
1) Не копируй фразы и порядок предложений из SOURCE_TEXT. Пересобери материал: измени синтаксис, порядок фактов, формулировки, ритм.
2) Факты и цифры сохраняй точными. Ничего не выдумывай. Если данных нет — пропусти блок.
3) Единицы: мм, км/ч, л.с., с, кг, л; неразрывный пробел; 17 000; десятичные — с запятой.
4) Тон: нейтрально-информативный, без маркетинга, эмодзи, КАПСА, кликбейта.
5) Ссылки из SOURCE_TEXT сохрани как Markdown [якорь](URL).
6) Дополняй только общеизвестным контекстом; избегай спекуляций.
7) Названия/индексы перепроверяй; не искажай.
8) НИКОГДА не используй исходный заголовок. Заголовок всегда новый.
СТРУКТУРА ВЫХОДА:
1) Ровно ОДИН заголовок (H2), начинай строкой: "## ". Хук, ≤ 60 знаков. Заголовок не повторяется в теле.
2) 3–6 коротких абзацев по 1–2 строки:
   • что нового/что произошло;
   • ключевые характеристики/изменения/комплектации (точно сохранённые цифры);
   • что это значит для читателя (практическая ценность).
3) ВОПРОСЫ-«БАЙТЫ» (2–3 шт., каждый на своей строке, разных типов):
   • Да/нет: «Взяли бы себе такое?», «Стоит своих денег?»
   • Выбор: «База или топ?», «Бензин или гибрид?»
   • Личный опыт: «Кто уже ездил — что удивило?», «Какие слабые места?»
   Допустимы живые формулировки вроде «Купили бы такую?», «Что думаете?», «Купили бы Aston Martin своей ляльке? 😉»
4) CTA (1–2 строки, без ссылок):
   • «Пишите в комментах — читаем всё 👇»
   • «Подпишитесь, чтобы не пропустить новое 🔔»
   • «Киньте другу, кто выбирает тачку ➡️»
ТРЕБОВАНИЯ:
- Средняя длина 9–15 слов; абзацы 1–3 предложения; связки «Кроме того», «При этом» и т.д.
- Единый стиль чисел/единиц.
- Без тавтологии и канцелярита.
ДЛИНА:
-  не больше 750 символов (включая пробелы и переносы строк). Не перебирать лимит.
ПРОВЕРКИ:
- Совпадение фактов/чисел.
- Антиплагиат: иной порядок/формулировки.
- Корректность ссылок.
- Ясность и читабельность.
`;

require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const fetch = require('node-fetch'); // v2 для Node 16
const sharp = require('sharp');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

// === GramJS (MTProto) ===
const { TelegramClient, Api } = require('telegram'); // 2.26.20
const { StringSession } = require('telegram/sessions');

// ----------------- Утилиты -----------------
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const LOG_PATH = path.join(DATA_DIR, 'bot.log');
const LOG_TO_FILE = !['0','false','off','no'].includes(String(process.env.LOG_TO_FILE).toLowerCase());

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const nowISO = () => new Date().toISOString();
const mask = (str, visible = 6) => {
  if (!str) return '';
  if (str.length <= visible) return '*'.repeat(str.length);
  return str.slice(0, visible) + '…' + '*'.repeat(Math.max(0, str.length - visible));
};
const trunc = (s, n = 200) => (!s ? '' : (s.length > n ? s.slice(0, n) + `…(+${s.length - n})` : s));
function log(step, meta = {}) {
  const line = `[${nowISO()}] ${step}${Object.keys(meta).length ? ' ' + JSON.stringify(meta) : ''}`;
  console.log(line);
  if (LOG_TO_FILE) {
    try { fs.appendFileSync(LOG_PATH, line + '\n'); } catch {}
  }
}

// ----------------- Конфиг -----------------
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || 'https://api.openai.com').replace(/\/+$/,'');

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_BASE_URL = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/,'');
const DEEPSEEK_MODEL = (process.env.DEEPSEEK_MODEL || 'deepseek-chat').trim();

// MTProto creds
const TG_API_ID = Number(process.env.TG_API_ID || 0);
const TG_API_HASH = process.env.TG_API_HASH || '';
const TG_SESSION = process.env.TG_SESSION || '';
const HAS_MTPROTO = Boolean(TG_API_ID && TG_API_HASH && TG_SESSION);

// Список каналов
const CHANNELS = (process.env.CHANNELS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

const DEFAULT_CHANNELS = (process.env.DEFAULT_CHANNELS || [
  't.me/avtonovosti_rus',
  't.me/AutoDrajv',
  't.me/drom',
  't.me/anrbc',
  't.me/nexpertGM',
].join(','))
  .split(',').map(s => s.trim()).filter(Boolean);

const PARSE_CHANNELS = (CHANNELS.length ? CHANNELS : DEFAULT_CHANNELS)
  .map(s => s.replace(/^https?:\/\/t\.me\/(s\/)?/i, ''))
  .map(s => s.replace(/^t\.me\//i, ''))
  .map(s => s.replace(/^@/, ''))
  .filter(Boolean);

const MAX_PHOTOS = Math.min(Number(process.env.MAX_PHOTOS || 10), 10);
const FEED_DELAY_MS = Number(process.env.FEED_DELAY_MS || 3000);

// === Обработка изображений (по умолчанию НИЧЕГО не трогаем) ===
const IMG_STYLE = (process.env.IMG_STYLE || 'none').toLowerCase(); // none|cinematic|vivid|matte|noir|bw
const IMG_FILTER_STRENGTH = (process.env.IMG_FILTER_STRENGTH || 'medium').toLowerCase(); // low|medium|high
const IMG_REQUIRE_ORIGINALITY = process.env.IMG_REQUIRE_ORIGINALITY === '1'; // по умолчанию ВЫКЛ (беречь качество)
const PUBLISH_AS_DOCUMENT = process.env.PUBLISH_AS_DOCUMENT === '1'; // отправлять как документ, чтобы TG не пережимал

const IMG_FLIP_PROB = Number(process.env.IMG_FLIP_PROB || 0.35);
const IMG_CROP_MIN = Number(process.env.IMG_CROP_MIN || 0.92);
const IMG_CROP_MAX = Number(process.env.IMG_CROP_MAX || 0.98);
const IMG_ROTATE_MAX_DEG = Number(process.env.IMG_ROTATE_MAX_DEG || 3.0);
const IMG_STRUCT_TRIES = Number(process.env.IMG_STRUCT_TRIES || 4);

const IMG_AHASH_MIN_DIST = Number(process.env.IMG_AHASH_MIN_DIST || 10);
const IMG_DHASH_MIN_DIST = Number(process.env.IMG_DHASH_MIN_DIST || 12);
const IMG_PHASH_DCT_MIN_DIST = Number(process.env.IMG_PHASH_DCT_MIN_DIST || 10);

const MIN_IMAGE_DIM = Number(process.env.MIN_IMAGE_DIM || 300);

const TG_CAPTION_MAX = 1024;
const CAPTION_SAFE = Math.min(Number(process.env.CAPTION_MAX || (TG_CAPTION_MAX - 8)), TG_CAPTION_MAX);

log('config.load.begin');
log('config.values', {
  node: process.version,
  channels_count: PARSE_CHANNELS.length,
  channels: PARSE_CHANNELS,
  channel_id: CHANNEL_ID,
  bot_token: mask(BOT_TOKEN),
  openai_base_url: OPENAI_BASE_URL,
  deepseek_key: mask(DEEPSEEK_API_KEY),
  deepseek_base_url: DEEPSEEK_BASE_URL,
  deepseek_model: DEEPSEEK_MODEL,
  log_to_file: LOG_TO_FILE,
  max_photos: MAX_PHOTOS,
  feed_delay_ms: FEED_DELAY_MS,
  img_style: IMG_STYLE,
  img_strength: IMG_FILTER_STRENGTH,
  img_require_originality: IMG_REQUIRE_ORIGINALITY,
  publish_as_document: PUBLISH_AS_DOCUMENT,
  min_image_dim: MIN_IMAGE_DIM,
  caption_safe: CAPTION_SAFE,
  mtproto_enabled: HAS_MTPROTO,
  tg_api_id: TG_API_ID ? 'ok' : 'missing',
});

if (!BOT_TOKEN || !CHANNEL_ID || !DEEPSEEK_API_KEY || PARSE_CHANNELS.length === 0) {
  log('config.error.missing_env');
  console.error('Нужны BOT_TOKEN, CHANNEL_ID, DEEPSEEK_API_KEY и CHANNELS (или дефолтный список).');
  process.exit(1);
}

const STORE_PATH = path.join(DATA_DIR, 'posted.json');

// ----------------- JSON store -----------------
function loadStore() {
  try {
    if (!fs.existsSync(STORE_PATH)) return { items: {} };
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw || '{"items":{}}');
    log('store.load.ok', { keys: Object.keys(parsed.items || {}).length });
    return parsed;
  } catch (e) {
    log('store.load.error', { error: e.message });
    return { items: {} };
  }
}
function saveStore(store) {
  try {
    fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), 'utf8');
    log('store.save.ok', { keys: Object.keys(store.items || {}).length });
  } catch (e) {
    log('store.save.error', { error: e.message });
  }
}
function setStoreItem(key, value) {
  const store = loadStore();
  store.items[key] = value;
  saveStore(store);
}
function getStoreItem(key) {
  const store = loadStore();
  return store.items[key];
}
function hasStoreKey(key) {
  const present = Boolean(getStoreItem(key));
  log('store.has', { key, present });
  return present;
}

// ----------------- Контент утилиты -----------------
function sha256(s) { return crypto.createHash('sha256').update(s, 'utf8').digest('hex'); }
function canonicalizeUrl(u = '') {
  try {
    const url = new URL(u);
    url.hash = '';
    const junk = ['utm_source','utm_medium','utm_campaign','utm_term','utm_content','fbclid','gclid'];
    junk.forEach(k => url.searchParams.delete(k));
    const params = [...url.searchParams.entries()].sort(([a],[b]) => a.localeCompare(b));
    url.search = new URLSearchParams(params).toString();
    url.hostname = url.hostname.toLowerCase();
    const out = url.toString();
    log('url.canonicalize', { input: trunc(u, 120), output: trunc(out, 120) });
    return out;
  } catch (e) { log('url.canonicalize.error', { u, error: e.message }); return u; }
}
function stripHtml(html = '') {
  try {
    const $ = cheerio.load(html);
    const text = $.text().replace(/\s+/g, ' ').trim();
    log('html.strip', { in_len: html.length, out_len: text.length });
    return text;
  } catch { const text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(); return text; }
}
function escapeHtml(s = '') {
  const r = s.replace(/[<&>]/g, c => ({ '<':'&lt;', '>':'&gt;', '&':'&amp;' }[c]));
  if (r !== s) log('html.escape', { before: trunc(s, 120), after: trunc(r, 120) });
  return r;
}
function toTs(s) { const t = Date.parse(s || ''); const out = Number.isFinite(t) ? t : 0; log('time.parse', { s, ts: out }); return out; }
function normalizeForCompare(s = '') {
  return (s || '').toLowerCase().replace(/[#*_`~>|]/g, ' ').replace(/[^\p{L}\p{N}\s.-]/gu, '').replace(/\s+/g, ' ').trim();
}
function stripLeadingTitle(body = '', title = '') {
  if (!body) return '';
  const lines = body.split(/\r?\n/);
  while (lines.length && /^#{1,6}\s+/.test(lines[0])) lines.shift();
  if (!title) return lines.join('\n').trim();
  const normTitle = normalizeForCompare(title);
  while (lines.length) {
    const normLine = normalizeForCompare(lines[0]);
    if (normLine && (normLine === normTitle || normLine.startsWith(normTitle.slice(0, Math.max(10, Math.floor(normTitle.length * 0.8)))))) { lines.shift(); continue; }
    break;
  }
  return lines.join('\n').trim();
}
function makeTitleFromPlain(plain = '') {
  const txt = (plain || '').replace(/\s+/g, ' ').trim();
  if (!txt) return 'Коротко об авто-новости';
  const m = txt.match(/^(.{20,80}?)([.!?–—]|$)/);
  let t = (m ? m[1] : txt.slice(0, 80)).trim();
  t = t.replace(/[,:;–—-]\s*$/, '').replace(/\s{2,}/g, ' ');
  if (t.length > 60) t = t.slice(0, 57).trim() + '…';
  return t;
}
function smartTruncate(s = '', limit = CAPTION_SAFE) {
  if (!s || s.length <= limit) return s;
  const slice = s.slice(0, Math.max(0, limit - 1));
  const idx = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('! '), slice.lastIndexOf('? '), slice.lastIndexOf('\n'), slice.lastIndexOf(' — '), slice.lastIndexOf(' – '), slice.lastIndexOf(' - '), slice.lastIndexOf(' '));
  let cut = idx > 0 ? slice.slice(0, idx) : slice;
  cut = cut.replace(/[ \t\r\n.!,;:—–-]+$/g, '');
  return cut + '…';
}

// ----------------- Парсинг Telegram (для текста/ссылки) -----------------
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) MiniTGFeedBot/1.0';
function extractPostIdFromLink(link = '') { try { const m = String(link).match(/\/(\d+)(?:\?.*)?$/); return m ? Number(m[1]) : 0; } catch { return 0; } }

async function fetchChannelPageHTML(username) {
  const url = `https://t.me/s/${encodeURIComponent(username)}`;
  log('tme.fetch.begin', { url });
  const maxTries = 3;
  for (let attempt = 1; attempt <= maxTries; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }, timeout: 20000 });
      log('tme.fetch.status', { status: res.status, attempt });
      if (res.status === 429 || res.status === 503) { const wait = 800 * attempt + Math.floor(Math.random() * 500); await sleep(wait); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      log('tme.fetch.done', { len: html.length });
      return html;
    } catch (e) { log('tme.fetch.error', { attempt, error: e.message }); const wait = 600 * attempt + Math.floor(Math.random() * 400); await sleep(wait); }
  }
  return '';
}

function parseTMeMessages(username, html) {
  const $ = cheerio.load(html);
  const items = [];
  $('.tgme_widget_message').each((_, el) => {
    const $el = $(el);
    const link = $el.find('a.tgme_widget_message_date').attr('href') || '';
    let isoDate = $el.find('.tgme_widget_message_date time').attr('datetime') || null;
    if (isoDate) { try { isoDate = new Date(isoDate).toISOString(); } catch { isoDate = null; } }
    const textHtml = $el.find('.tgme_widget_message_text').html() || '';
    const textPlain = $el.find('.tgme_widget_message_text').text().replace(/\s+/g, ' ').trim();

    // ВНИМАНИЕ: мы больше не используем изображения из t.me/s — только текст/ссылка!
    const id = link || ($el.attr('data-post') ? `https://t.me/${$el.attr('data-post')}` : '');
    const title = (textPlain || 'Публикация').slice(0, 140);

    items.push({
      source: username,
      id,
      link: link || id,
      title,
      isoDate,
      content: textHtml || '',
      contentSnippet: textPlain
    });
  });

  items.sort((a, b) => {
    const ta = a.isoDate ? Date.parse(a.isoDate) : 0;
    const tb = b.isoDate ? Date.parse(b.isoDate) : 0;
    if (tb !== ta) return tb - ta;
    return extractPostIdFromLink(b.link) - extractPostIdFromLink(a.link);
  });

  log('tme.parse.done', { user: username, total: items.length });
  return items;
}

async function fetchLatestFromChannel(username, take = 3) {
  const html = await fetchChannelPageHTML(username);
  if (!html) return [];
  const all = parseTMeMessages(username, html);
  const top = all.slice(0, Math.max(1, Math.min(50, take)));
  log('tme.latest', { user: username, take, returned: top.length });
  return top;
}
async function fetchAllFeeds() {
  log('fetchAllFeeds.begin', { channels: PARSE_CHANNELS.length });
  const merged = [];
  for (let i = 0; i < PARSE_CHANNELS.length; i++) {
    const user = PARSE_CHANNELS[i];
    const arr = await fetchLatestFromChannel(user, 3);
    for (const it of arr) merged.push(it);
    log('fetchAllFeeds.channel_done', { user, added: arr.length, total: merged.length });
    if (i < PARSE_CHANNELS.length - 1) { await sleep(FEED_DELAY_MS); }
  }
  merged.sort((a, b) => {
    const ta = a.isoDate ? Date.parse(a.isoDate) : 0;
    const tb = b.isoDate ? Date.parse(b.isoDate) : 0;
    if (tb !== ta) return tb - ta;
    return extractPostIdFromLink(b.link) - extractPostIdFromLink(a.link);
  });
  log('fetchAllFeeds.done', { total: merged.length });
  return merged;
}

// ----------------- OpenAI/DeepSeek (текст) -----------------
async function openaiChatRewrite({ title, plain, link }) {
  const body = {
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: TEXT_PROMPT },
      { role: 'user', content: `ЗАГОЛОВОК: ${title}\nТЕКСТ: ${plain}\nССЫЛКА: ${link}` }
    ],
    temperature: 0.7
  };
  log('openai.chat.req', { title: trunc(title, 120), plain_len: plain.length, link });
  try {
    const res = await fetch(`${OPENAI_BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      timeout: 30000
    });
    const txt = await res.text();
    log('openai.chat.status', { status: res.status, len: txt.length });
    const json = JSON.parse(txt);
    if (!res.ok) throw new Error(txt);
    const text = json.choices?.[0]?.message?.content?.trim() || '';
    log('openai.chat.ok', { out_len: text.length, sample: trunc(text, 200) });
    return text;
  } catch (e) {
    log('openai.chat.error', { error: e.message });
    const safePlain = (plain || '').replace(/\s+/g, ' ').trim();
    const h2 = makeTitleFromPlain(safePlain);
    const md = `## ${h2}\n\n${safePlain}`;
    return md;
  }
}
async function deepseekChatRewrite({ title, plain, link }) {
  const body = {
    model: DEEPSEEK_MODEL,
    messages: [
      { role: 'system', content: TEXT_PROMPT },
      { role: 'user', content: `ЗАГОЛОВОК: ${title}\nТЕКСТ: ${plain}\nССЫЛКА: ${link}` }
    ],
    temperature: 0.7
  };
  log('deepseek.chat.req', { title: trunc(title, 120), plain_len: plain.length, link, model: DEEPSEEK_MODEL });
  try {
    const res = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      timeout: 30000
    });
    const txt = await res.text();
    log('deepseek.chat.status', { status: res.status, len: txt.length });
    const json = JSON.parse(txt);
    if (!res.ok) throw new Error(txt);
    const text = json.choices?.[0]?.message?.content?.trim() || '';
    log('deepseek.chat.ok', { out_len: text.length, sample: trunc(text, 200) });
    return text;
  } catch (e) {
    log('deepseek.chat.error', { error: e.message });
    const safePlain = (plain || '').replace(/\s+/g, ' ').trim();
    const h2 = makeTitleFromPlain(safePlain);
    const md = `## ${h2}\n\n${safePlain}`;
    return md;
  }
}
function splitTitleFromBody(markdown = '') {
  const lines = (markdown || '').split(/\r?\n/);
  let title = '', idx = -1;
  for (let i = 0; i < Math.min(lines.length, 10); i++) {
    const m = lines[i].match(/^##\s*(.+?)\s*$/);
    if (m) { title = m[1].trim(); idx = i; break; }
  }
  if (idx >= 0) lines.splice(idx, 1);
  while (lines.length && /^#{1,6}\s+/.test(lines[0])) lines.shift();
  const body = lines.join('\n').trim();
  log('rewrite.parse', { has_h2: Boolean(title), title_sample: trunc(title, 80) });
  return { title, body };
}

// ----------------- Хэши / фильтры (опционально, по флагам) -----------------
function hamming(a, b) { let d=0; const n=Math.min(a.length,b.length); for(let i=0;i<n;i++) if(a[i]!==b[i]) d++; return d; }
async function getGrayRaw(buf,w,h){ const {data,info}=await sharp(buf).rotate().toColourspace('b-w').resize(w,h,{fit:'fill',kernel:sharp.kernel.lanczos3}).raw().toBuffer({resolveWithObject:true}); if(info.channels!==1){const g=[];for(let i=0;i<data.length;i+=info.channels)g.push(data[i]);return Uint8Array.from(g);} return data; }
async function aHash64(buf){ const W=8,H=8; const g=await getGrayRaw(buf,W,H); let sum=0; for(let i=0;i<g.length;i++) sum+=g[i]; const avg=sum/g.length; let bits=''; for(let i=0;i<g.length;i++) bits+=(g[i]>=avg?'1':'0'); return bits; }
async function dHash64(buf){ const W=9,H=8; const g=await getGrayRaw(buf,W,H); let bits=''; for(let y=0;y<H;y++){ const row=y*W; for(let x=0;x<W-1;x++) bits+=(g[row+x]>g[row+x+1])?'1':'0'; } return bits; }
async function pHash64(buf){ const N=32; const g=await getGrayRaw(buf,N,N); const f=new Array(N*N); for(let i=0;i<N*N;i++) f[i]=g[i]/255; const C=(k)=>k===0?Math.SQRT1_2:1; const F=new Array(N*N).fill(0); for(let u=0;u<8;u++){ for(let v=0;v<8;v++){ let sum=0; for(let y=0;y<N;y++) for(let x=0;x<N;x++) sum+=f[y*N+x]*Math.cos(((2*x+1)*u*Math.PI)/(2*N))*Math.cos(((2*y+1)*v*Math.PI)/(2*N)); F[u*N+v]=(C(u)*C(v)/4)*sum; } } const coeffs=[]; for(let u=0;u<8;u++) for(let v=0;v<8;v++){ if(u===0&&v===0) continue; coeffs.push(F[u*N+v]); } const sorted=coeffs.slice().sort((a,b)=>a-b); const median=sorted[Math.floor(sorted.length/2)]; let bits=''; for(const c of coeffs) bits+=(c>median?'1':'0'); return bits; }
async function hashDistances(a,b){ const [aA,dA,pA]=await Promise.all([aHash64(a),dHash64(a),pHash64(a)]); const [aB,dB,pB]=await Promise.all([aHash64(b),dHash64(b),pHash64(b)]); return {a:hamming(aA,aB),d:hamming(dA,dB),p:hamming(pA,pB)}; }

async function applyLocalFilterSharp(buf,{style=IMG_STYLE,strength=IMG_FILTER_STRENGTH}={}) {
  if (style==='none') return buf;
  const s = strength==='high' ? { sat:1.18, bright:1.03, gamma:0.95 } : strength==='low' ? { sat:1.06, bright:1.01, gamma:1.00 } : { sat:1.10, bright:1.02, gamma:0.98 };
  let img = sharp(buf);
  if (style==='bw' || style==='noir') img = img.greyscale();
  img = img.modulate({ brightness:s.bright, saturation: style==='noir'?1.00:s.sat, hue: style==='vivid'?8:0 }).gamma(s.gamma);
  const out = await img.toBuffer();
  return out;
}
async function ensureDistinctEnoughSharp(origBuf,W,H){
  if(!IMG_REQUIRE_ORIGINALITY) return origBuf;
  // Простейшая «структурная» вариация без даунскейла
  let candidate = await applyLocalFilterSharp(origBuf);
  const dist = await hashDistances(origBuf, candidate);
  log('img.struct.check', dist);
  return candidate;
}

// ----------------- MTProto (GramJS) -----------------
let _mtClient = null;
let _mtReady = null;

function buildProxy() {
  const t = (process.env.PROXY_TYPE || '').toLowerCase();
  if (!t) return undefined;
  if (t === 'socks' || t === 'socks5' || t === 'socks4') {
    return {
      ip: process.env.PROXY_HOST,
      port: Number(process.env.PROXY_PORT || 1080),
      username: process.env.PROXY_USER || undefined,
      password: process.env.PROXY_PASS || undefined,
      socksType: 5
    };
  }
  if (t === 'mtproxy') {
    return {
      ip: process.env.PROXY_HOST,
      port: Number(process.env.PROXY_PORT || 443),
      MTProxy: true,
      secret: process.env.PROXY_SECRET
    };
  }
  return undefined;
}

function parseTmeLink(u) {
  const m = String(u || '').trim().match(/t\.me\/(?:c\/\d+\/)?([A-Za-z0-9_]+)/i);
  const idm = String(u || '').trim().match(/\/(\d+)(?:\?.*)?$/);
  if (!m || !idm) return null;
  return { username: m[1], msgId: Number(idm[1]) };
}

function extFromMime(mime = '') {
  if (mime.includes('jpeg')) return 'jpg';
  if (mime.includes('png'))  return 'png';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('gif'))  return 'gif';
  if (mime.includes('mp4'))  return 'mp4';
  return 'bin';
}

async function initMTProto() {
  if (!HAS_MTPROTO) throw new Error('MTProto disabled: no TG_API_ID/HASH/SESSION');
  if (_mtReady) return _mtReady;
  _mtReady = (async () => {
    const session = new StringSession(TG_SESSION);
    _mtClient = new TelegramClient(session, TG_API_ID, TG_API_HASH, {
      connectionRetries: 5,
      useWSS: false,
      proxy: buildProxy(),
      deviceModel: 'Node16.20',
      appVersion: '1.0.0',
      systemVersion: 'Linux/Windows/macOS'
    });
    await _mtClient.connect();
    return _mtClient;
  })();
  return _mtReady;
}

/**
 * Возвращает массив оригинальных медиа по ссылке t.me/<channel>/<id>
 * [{ buffer, filename, mime, type: 'photo'|'document'|'video', width?, height? }]
 */
async function fetchMediaByLink(tmeLink, { includeVideo = false } = {}) {
  if (!HAS_MTPROTO) return [];
  const client = await initMTProto();
  const parsed = parseTmeLink(tmeLink);
  if (!parsed) return [];

  const entity = await client.getEntity(parsed.username).catch(() => null);
  if (!entity) return [];

  // Попытка тихо вступить в публичный канал — иногда влияет на доступ к медиа
  try { await client.invoke(new Api.channels.JoinChannel({ channel: entity })); } catch (_) {}

  let [msg] = await client.getMessages(entity, { ids: [parsed.msgId] });
  if (!msg) return [];

  // Альбом
  let msgs = [msg];
  if (msg.groupedId) {
    const ids = [];
    for (let i = parsed.msgId - 25; i <= parsed.msgId + 25; i++) if (i > 0) ids.push(i);
    const around = await client.getMessages(entity, { ids });
    msgs = around.filter(m => String(m.groupedId) === String(msg.groupedId));
    if (!msgs.length) msgs = [msg];
  }

  const out = [];
  for (const m of msgs) {
    if (m.photo) {
      const buf = await client.downloadMedia(m, { workers: 2 });
      // размеры фото Telegram напрямую получить сложно; проверим sharp
      let width, height;
      try { const meta = await sharp(buf).metadata(); width = meta.width; height = meta.height; } catch {}
      out.push({ buffer: buf, filename: `photo_${parsed.username}_${m.id}.jpg`, mime: 'image/jpeg', type: 'photo', width, height });
    }
    if (m.document && (m.document.mimeType || '').startsWith('image/')) {
      const mime = m.document.mimeType;
      const ext = extFromMime(mime);
      const buf = await client.downloadMedia(m, { workers: 2 });
      let width, height;
      try { const meta = await sharp(buf).metadata(); width = meta.width; height = meta.height; } catch {}
      out.push({ buffer: buf, filename: `image_${parsed.username}_${m.id}.${ext}`, mime, type: 'document', width, height });
    }
    if (includeVideo && m.video) {
      const buf = await client.downloadMedia(m, { workers: 2 });
      out.push({ buffer: buf, filename: `video_${parsed.username}_${m.id}.mp4`, mime: 'video/mp4', type: 'video' });
    }
  }

  // Отсечь мелочь (аватарки и т.п.)
  return out.filter(m => !m.width || !m.height || (m.width >= MIN_IMAGE_DIM || m.height >= MIN_IMAGE_DIM));
}

// ----------------- Дедуп -----------------
function makeKeys(item) {
  const baseId = item.id || item.link || '';
  const fallbackId = sha256((item.title || '') + '|' + (item.isoDate || '') + '|' + (item.link || ''));
  const id = baseId || fallbackId;
  const canonical = canonicalizeUrl(item.link || '');
  const plain = (item.contentSnippet || stripHtml(item.content || '')).toLowerCase();
  const urlHash = sha256(canonical);
  const contentHash = sha256((item.title || '') + '|' + plain);
  const keys = { id, urlHash, contentHash, canonical, plain };
  log('dedupe.keys', { id, urlHash, contentHash, canonical: trunc(canonical, 160), plain_len: plain.length });
  return keys;
}
function seenAny({ id, urlHash, contentHash }) {
  const any = hasStoreKey(`id:${id}`) || hasStoreKey(`uh:${urlHash}`) || hasStoreKey(`ch:${contentHash}`);
  log('dedupe.seenAny', { id, any });
  return any;
}
function markOffered(item, keys) {
  const value = { id: keys.id, link: item.link, source: item.source, isoDate: item.isoDate, status: 'offered', offeredAt: nowISO() };
  setStoreItem(`id:${keys.id}`, value); setStoreItem(`uh:${keys.urlHash}`, value); setStoreItem(`ch:${keys.contentHash}`, value);
}
function markPosted(item, keys) {
  const value = { id: keys.id, link: item.link, source: item.source, isoDate: item.isoDate, status: 'posted', postedAt: nowISO() };
  setStoreItem(`id:${keys.id}`, value); setStoreItem(`uh:${keys.urlHash}`, value); setStoreItem(`ch:${keys.contentHash}`, value);
}

// ----------------- Telegraf -----------------
const bot = new Telegraf(BOT_TOKEN, { handlerTimeout: 0 });
bot.catch((err, ctx) => { log('bot.error', { error: err?.message || String(err), update_type: ctx?.updateType, stack: trunc(err?.stack || '', 1000) }); });

bot.use(async (ctx, next) => {
  log('update.received', { from: ctx.from ? { id: ctx.from.id, username: ctx.from.username } : null, chat: ctx.chat ? { id: ctx.chat.id, type: ctx.chat.type } : null, type: ctx.updateType });
  await next();
});

const BUSY = new Set();
function setBusy(chatId, v) { if (v) BUSY.add(chatId); else BUSY.delete(chatId); }
function isBusy(chatId) { return BUSY.has(chatId); }
async function freezeButtons(ctx, toast = 'Обрабатываю…') { await ctx.answerCbQuery(toast).catch(()=>{}); try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch (e) { log('ui.freezeButtons.error', { error: e.message }); } }

const OFFERS = new Map();

bot.start(async (ctx) => {
  await ctx.reply('Предложение: вы можете опубликовать самый свежий пост.', Markup.inlineKeyboard([[Markup.button.callback('🚀 Начать', 'start_offer')]]));
});
bot.on('text', async (ctx) => {
  await ctx.reply('Предложение: вы можете опубликовать самый свежий пост.', Markup.inlineKeyboard([[Markup.button.callback('🚀 Начать', 'start_offer')]]));
});
bot.action('start_offer', async (ctx) => { await ctx.answerCbQuery().catch(()=>{}); await offerNext(ctx); });

bot.action(/publish:(.+)/, async (ctx) => {
  const chatId = ctx.chat.id;
  const hashId = ctx.match[1];
  if (isBusy(chatId)) { await ctx.answerCbQuery('⏳ Уже выполняю предыдущее действие…').catch(()=>{}); return; }
  setBusy(chatId, true);
  await freezeButtons(ctx, '⏳ Публикую…');
  const offer = OFFERS.get(chatId);
  if (!offer || offer.hashId !== hashId) {
    await ctx.reply('Эта карточка устарела. Нажмите «Начать» ещё раз.', Markup.inlineKeyboard([[Markup.button.callback('🚀 Начать', 'start_offer')]]));
    setBusy(chatId, false);
    return;
  }
  try {
    await ctx.reply('⏳ Публикуем запись…');
    await publishToChannel(ctx, offer.item, offer.keys);
    await ctx.reply('✅ Опубликовано в канале.');
  } catch (e) {
    log('ui.publish.catch', { error: e.message });
  } finally {
    await offerNext(ctx);
    setBusy(chatId, false);
  }
});

bot.action('cancel', async (ctx) => {
  const chatId = ctx.chat.id;
  if (isBusy(chatId)) { await ctx.answerCbQuery('⏳ Уже выполняю предыдущее действие…').catch(()=>{}); return; }
  setBusy(chatId, true);
  await freezeButtons(ctx, '⏭ Отменяю…');
  try {
    await ctx.reply('⏭ Отменено. Ищу следующую запись…');
    await offerNext(ctx);
  } catch (e) {
    log('ui.cancel.catch', { error: e.message });
  } finally { setBusy(chatId, false); }
});

async function offerNext(ctx) {
  try {
    await ctx.reply('Ищу самую свежую запись…');
    const items = await fetchAllFeeds();
    const normalized = items.map(it => ({ ...it, ts: toTs(it.isoDate) }));
    normalized.sort((a,b)=>b.ts - a.ts);

    let candidate = null, keys = null;
    for (const it of normalized) {
      const k = makeKeys(it);
      if (!k.id) continue;
      if (!seenAny(k)) { candidate = it; keys = k; break; }
    }
    if (!candidate) { await ctx.reply('Свежих непредложенных записей не нашлось. Попробуйте позже.'); return; }

    markOffered(candidate, keys);
    const hashId = sha256(keys.id).slice(0, 16);
    OFFERS.set(ctx.chat.id, { item: candidate, keys, hashId });

    const title = candidate.title || '(без заголовка)';
    const url = candidate.link || '';
    const text = `<b>${escapeHtml(title)}</b>\n\n${escapeHtml(url)}`;

    await ctx.replyWithHTML(text, Markup.inlineKeyboard([[Markup.button.callback('✅ Опубликовать', `publish:${hashId}`), Markup.button.callback('⏭ Отменить (следующая)', 'cancel')]]));
  } catch (e) {
    log('offer.error', { error: e.message });
    await ctx.reply('Ошибка при получении записи. Попробуйте снова.');
  }
}

// ----------------- Публикация (Только оригиналы MTProto, БЕЗ миниатюр t.me) -----------------
async function publishToChannel(ctx, item, keys) {
  log('publish.begin', { id: keys.id, source: item.source, link: item.link });
  try {
    // 1) Переписать текст
    const plain = (item.contentSnippet || stripHtml(item.content || '')).trim();
    const rewrittenRaw = await deepseekChatRewrite({ title: item.title || '', plain, link: item.link || '' });
    const { title: newTitle, body: rewrittenBody } = splitTitleFromBody(rewrittenRaw);
    const finalTitle = newTitle || makeTitleFromPlain(plain);

    // 2) Только оригиналы через MTProto
    let originals = [];
    if (HAS_MTPROTO && item.link) {
      try { originals = await fetchMediaByLink(item.link, { includeVideo: false }); }
      catch (e) { log('mtproto.fetch.error', { error: e.message }); }
    } else {
      log('mtproto.disabled_or_no_link', { has_mtproto: HAS_MTPROTO, link: !!item.link });
    }

    // Фильтр изображений (видео отключили)
    originals = originals.filter(m => (m.mime || '').startsWith('image/'));
    if (!originals.length) {
      log('publish.no_media', { reason: 'no_originals' });
    } else {
      log('publish.media.originals', { count: originals.length, samples: originals.slice(0,2).map(x=>({fn:x.filename,w:x.width,h:x.height})) });
    }

    // 3) Формируем отправку (без перекодирования; опционально фильтр)
    let mediaGroup = [];
    if (originals.length) {
      const take = Math.min(originals.length, MAX_PHOTOS);
      for (let i = 0; i < take; i++) {
        const m = originals[i];
        let buf = m.buffer;

        // По желанию — лёгкий фильтр/уникализация без даунскейла
        if (IMG_REQUIRE_ORIGINALITY || IMG_STYLE !== 'none') {
          try { buf = await ensureDistinctEnoughSharp(buf, m.width || 0, m.height || 0); }
          catch (e) { log('img.ensureDistinct.error', { error: e.message }); }
        }

        if (PUBLISH_AS_DOCUMENT) {
          // ВНИМАНИЕ: document нельзя отправить в mediaGroup; отправим по одному ниже
          mediaGroup.push({ kind: 'document', file: { source: buf, filename: m.filename }, mime: m.mime });
        } else {
          // Photo-вариант (альбом)
          mediaGroup.push({ kind: 'photo', file: { source: buf, filename: m.filename } });
        }
      }
    }

    // 4) Подпись
    const caption = buildCaption(finalTitle, rewrittenBody || rewrittenRaw);

    // 5) Отправка
    if (mediaGroup.length) {
      if (PUBLISH_AS_DOCUMENT) {
        // Отправляем по одному документу (чтобы TG не пережимал). Подпись — на первом.
        for (let i = 0; i < mediaGroup.length; i++) {
          const doc = mediaGroup[i];
          const opts = (i === 0) ? { caption, parse_mode: 'HTML' } : {};
          await ctx.telegram.sendDocument(CHANNEL_ID, doc.file, opts);
        }
      } else {
        // Альбом фото (TG может немного пережимать, но исходник мы взяли оригинальный).
        const album = mediaGroup.slice(0, MAX_PHOTOS).map((p, idx) => {
          const base = { type: 'photo', media: p.file };
          if (idx === 0) { base.caption = caption; base.parse_mode = 'HTML'; }
          return base;
        });
        await ctx.telegram.sendMediaGroup(CHANNEL_ID, album);
      }
    } else {
      // Текст без медиа
      await ctx.telegram.sendMessage(CHANNEL_ID, caption, { parse_mode: 'HTML', disable_web_page_preview: true });
    }

    markPosted(item, keys);
    log('publish.ok', { id: keys.id });
  } catch (e) {
    log('publish.error', { error: e.message });
    if (String(e.message).includes('chat not found')) {
      await ctx.reply(
        '❗️Телеграм отвечает: «chat not found».\n' +
        'Проверьте, что:\n' +
        '— CHANNEL_ID = @username вашего канала (или -100... числовой id);\n' +
        '— бот добавлен в канал и повышен до администратора.'
      );
    } else {
      await ctx.reply('Ошибка при публикации. Попробуйте другую запись.');
    }
    await offerNext(ctx);
  }
}

function buildCaption(title, body) {
  let cleanBody = stripLeadingTitle(body || '', title || '');
  const head = `<b>${escapeHtml(title)}</b>\n\n`;
  let tail = escapeHtml(cleanBody);
  let cap = head + tail;
  if (cap.length > CAPTION_SAFE) {
    const need = CAPTION_SAFE - head.length;
    if (need > 0) { tail = smartTruncate(tail, need); cap = head + tail; }
    else { cap = smartTruncate(head, CAPTION_SAFE); }
    log('caption.truncate', { to: cap.length });
  }
  return cap;
}

// ----------------- Проверка доступа к каналу -----------------
async function verifyChannelAccess(bot) {
  try {
    const chat = await bot.telegram.getChat(CHANNEL_ID);
    const me = await bot.telegram.getMe();
    const admins = await bot.telegram.getChatAdministrators(CHANNEL_ID);
    const isAdmin = admins.some(a => a.user.id === me.id);
    log('channel.verify', { id: chat.id, type: chat.type, title: chat.title || chat.username || null, me: me.username, isAdmin });
    if (!isAdmin) console.warn('ВНИМАНИЕ: бот не администратор канала — публикация может не работать.');
  } catch (e) {
    log('channel.verify.error', { error: e.message });
    console.warn('Проверьте CHANNEL_ID и права бота в канале.');
  }
}

// ----------------- Запуск -----------------
(async () => {
  try {
    log('bot.launch.begin');
    await bot.launch();
    log('bot.launch.ok', { channels: PARSE_CHANNELS.length, store: STORE_PATH, log: LOG_PATH });

    if (HAS_MTPROTO) {
      try { await initMTProto(); log('mtproto.ready', {}); }
      catch (e) { log('mtproto.init.error', { error: e.message }); }
    } else {
      log('mtproto.disabled', { reason: 'no TG_API_ID/HASH/SESSION' });
    }

    await verifyChannelAccess(bot);
    console.log('Бот запущен. Напишите ему /start');
  } catch (e) {
    log('bot.launch.error', { error: e.message });
    process.exit(1);
  }
})();

process.on('unhandledRejection', (r) => log('process.unhandledRejection', { reason: String(r) }));
process.on('uncaughtException', (e) => { log('process.uncaughtException', { error: e.message, stack: trunc(e.stack || '', 1000) }); process.exit(1); });
process.once('SIGINT', () => { log('process.signal', { sig: 'SIGINT' }); bot.stop('SIGINT'); process.exit(0); });
process.once('SIGTERM', () => { log('process.signal', { sig: 'SIGTERM' }); bot.stop('SIGTERM'); process.exit(0); });
