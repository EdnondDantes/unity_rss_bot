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
СТРУКТУРА ВЫХОДА:
1) Заголовок (H2) С ярким хуком. ≤ 60 знаков.
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
-  не больше 800 символов.(включая пробелы и переносы строк)
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
const CHANNEL_ID = process.env.CHANNEL_ID; // @username или -100...
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || 'https://api.openai.com').replace(/\/+$/,'');

// Новое: список каналов (юзернеймы или ссылки t.me/...); если нет — подставим твои 5 каналов
const CHANNELS = (process.env.CHANNELS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// >>> единственное изменение: DEFAULT_CHANNELS берётся из .env <<<
const DEFAULT_CHANNELS = (process.env.DEFAULT_CHANNELS || [
  't.me/avtonovosti_rus',
  't.me/AutoDrajv',
  't.me/drom',
  't.me/anrbc',
  't.me/nexpertGM',
].join(','))
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const PARSE_CHANNELS = (CHANNELS.length ? CHANNELS : DEFAULT_CHANNELS)
  .map(s => s.replace(/^https?:\/\/t\.me\/(s\/)?/i, ''))
  .map(s => s.replace(/^t\.me\//i, ''))
  .map(s => s.replace(/^@/, ''))
  .filter(Boolean);

const MAX_PHOTOS = Math.min(Number(process.env.MAX_PHOTOS || 10), 10);
const FEED_DELAY_MS = Number(process.env.FEED_DELAY_MS || 3000); // пауза между каналами (вежливость)

// === Параметры обработки изображений (SHARP, без OpenAI) ===
const IMG_STYLE = (process.env.IMG_STYLE || 'none').toLowerCase(); // none|cinematic|vivid|matte|noir|bw
const IMG_FILTER_STRENGTH = (process.env.IMG_FILTER_STRENGTH || 'medium').toLowerCase(); // low|medium|high
const IMG_REQUIRE_ORIGINALITY = process.env.IMG_REQUIRE_ORIGINALITY === '0' ? false : true;

// «Структура»: кроп/смещение/горизонтальное зеркало (без переворота вверх-вниз)
const IMG_FLIP_PROB = Number(process.env.IMG_FLIP_PROB || 0.35); // вероятность горизонтального зеркала (flop)
const IMG_CROP_MIN = Number(process.env.IMG_CROP_MIN || 0.92);  // доля стороны при кропе
const IMG_CROP_MAX = Number(process.env.IMG_CROP_MAX || 0.98);
const IMG_ROTATE_MAX_DEG = Number(process.env.IMG_ROTATE_MAX_DEG || 3.0); // случайный наклон ±N°
const IMG_STRUCT_TRIES = Number(process.env.IMG_STRUCT_TRIES || 4); // попыток добиться дистанции

// Пороги непохожести по хэшам (0..64)
const IMG_AHASH_MIN_DIST = Number(process.env.IMG_AHASH_MIN_DIST || 10);
const IMG_DHASH_MIN_DIST = Number(process.env.IMG_DHASH_MIN_DIST || 12);
const IMG_PHASH_DCT_MIN_DIST = Number(process.env.IMG_PHASH_DCT_MIN_DIST || 10);

log('config.load.begin');
log('config.values', {
  node: process.version,
  channels_count: PARSE_CHANNELS.length,
  channels: PARSE_CHANNELS,
  channel_id: CHANNEL_ID,
  bot_token: mask(BOT_TOKEN),
  openai_key: mask(OPENAI_API_KEY),
  openai_base_url: OPENAI_BASE_URL,
  log_to_file: LOG_TO_FILE,
  max_photos: MAX_PHOTOS,
  feed_delay_ms: FEED_DELAY_MS,
  // image cfg
  img_style: IMG_STYLE,
  img_strength: IMG_FILTER_STRENGTH,
  img_require_originality: IMG_REQUIRE_ORIGINALITY,
  img_flip_prob: IMG_FLIP_PROB,
  img_crop_min: IMG_CROP_MIN,
  img_crop_max: IMG_CROP_MAX,
  img_rotate_max_deg: IMG_ROTATE_MAX_DEG,
  img_struct_tries: IMG_STRUCT_TRIES,
  ahash_min: IMG_AHASH_MIN_DIST,
  dhash_min: IMG_DHASH_MIN_DIST,
  phash_min: IMG_PHASH_DCT_MIN_DIST
});

if (!BOT_TOKEN || !CHANNEL_ID || !OPENAI_API_KEY || PARSE_CHANNELS.length === 0) {
  log('config.error.missing_env');
  console.error('Нужны BOT_TOKEN, CHANNEL_ID, OPENAI_API_KEY и CHANNELS (или используйте дефолтный список).');
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

// ----------------- Утилиты контента -----------------
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
  } catch (e) {
    log('url.canonicalize.error', { u, error: e.message });
    return u;
  }
}

function stripHtml(html = '') {
  try {
    const $ = cheerio.load(html);
    const text = $.text().replace(/\s+/g, ' ').trim();
    log('html.strip', { in_len: html.length, out_len: text.length });
    return text;
  } catch {
    const text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    log('html.strip.fallback', { in_len: html.length, out_len: text.length });
    return text;
  }
}

function escapeHtml(s = '') {
  const r = s.replace(/[<&>]/g, c => ({ '<':'&lt;', '>':'&gt;', '&':'&amp;' }[c]));
  if (r !== s) log('html.escape', { before: trunc(s, 120), after: trunc(r, 120) });
  return r;
}

function extractImagesFromContent(html = '') {
  const $ = cheerio.load(html);
  const urls = [];
  $('img').each((_, el) => {
    const src = $(el).attr('src');
    if (src && /^https?:\/\//i.test(src)) urls.push(src);
  });
  log('images.extract', { count: urls.length, samples: urls.slice(0, 3) });
  return urls;
}

function toTs(s) {
  const t = Date.parse(s || '');
  const out = Number.isFinite(t) ? t : 0;
  log('time.parse', { s, ts: out });
  return out;
}

// ----------------- Парсинг Telegram (без RSSHub) -----------------
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) MiniTGFeedBot/1.0';

function extractPostIdFromLink(link = '') {
  try {
    const m = String(link).match(/\/(\d+)(?:\?.*)?$/);
    return m ? Number(m[1]) : 0;
  } catch { return 0; }
}

// Скачиваем HTML https://t.me/s/<username>
async function fetchChannelPageHTML(username) {
  const url = `https://t.me/s/${encodeURIComponent(username)}`;
  log('tme.fetch.begin', { url });
  const maxTries = 3;
  for (let attempt = 1; attempt <= maxTries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        },
        timeout: 20000
      });
      log('tme.fetch.status', { status: res.status, attempt });
      if (res.status === 429 || res.status === 503) {
        const wait = 800 * attempt + Math.floor(Math.random() * 500);
        log('tme.fetch.backoff', { wait });
        await sleep(wait);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      log('tme.fetch.done', { len: html.length });
      return html;
    } catch (e) {
      log('tme.fetch.error', { attempt, error: e.message });
      const wait = 600 * attempt + Math.floor(Math.random() * 400);
      await sleep(wait);
    }
  }
  return '';
}

// Разбор HTML → массив сообщений {id, link, title, isoDate, content, contentSnippet}
function parseTMeMessages(username, html) {
  const $ = cheerio.load(html);
  const items = [];

  $('.tgme_widget_message').each((_, el) => {
    const $el = $(el);

    const link = $el.find('a.tgme_widget_message_date').attr('href') || '';
    let isoDate = $el.find('.tgme_widget_message_date time').attr('datetime') || null;
    if (isoDate) {
      try { isoDate = new Date(isoDate).toISOString(); } catch { isoDate = null; }
    }

    const textHtml = $el.find('.tgme_widget_message_text').html() || '';
    const textPlain = $el.find('.tgme_widget_message_text').text().replace(/\s+/g, ' ').trim();

    // Изображения: из background-image и <img>
    const imgs = new Set();
    $el.find('a.tgme_widget_message_photo_wrap').each((__, a) => {
      const style = $(a).attr('style') || '';
      const m = style.match(/url\(['"]?(.*?)['"]?\)/i);
      if (m && m[1]) imgs.add(m[1]);
    });
    $el.find('img').each((__, img) => {
      const src = $(img).attr('src');
      if (src && /^https?:\/\//.test(src)) imgs.add(src);
    });
    const imgHtml = Array.from(imgs).map(u => `<p><img src="${u}" alt="photo"/></p>`).join('');

    const id = link || ($el.attr('data-post') ? `https://t.me/${$el.attr('data-post')}` : '');
    const title = (textPlain || 'Публикация').slice(0, 140);

    items.push({
      source: username,
      id,
      link: link || id,
      title,
      isoDate,
      content: (textHtml || '') + imgHtml,
      contentSnippet: textPlain
    });
  });

  // Сортируем
  items.sort((a, b) => {
    const ta = a.isoDate ? Date.parse(a.isoDate) : 0;
    const tb = b.isoDate ? Date.parse(b.isoDate) : 0;
    if (tb !== ta) return tb - ta;
    return extractPostIdFromLink(b.link) - extractPostIdFromLink(a.link);
  });

  log('tme.parse.done', { user: username, total: items.length });
  return items;
}

// Возвращаем 3 крайние поста канала
async function fetchLatestFromChannel(username, take = 3) {
  const html = await fetchChannelPageHTML(username);
  if (!html) return [];
  const all = parseTMeMessages(username, html);
  const top = all.slice(0, Math.max(1, Math.min(50, take)));
  log('tme.latest', { user: username, take, returned: top.length });
  return top;
}

// Сбор по всем каналам
async function fetchAllFeeds() {
  log('fetchAllFeeds.begin', { channels: PARSE_CHANNELS.length });
  const merged = [];
  for (let i = 0; i < PARSE_CHANNELS.length; i++) {
    const user = PARSE_CHANNELS[i];
    const arr = await fetchLatestFromChannel(user, 3);
    for (const it of arr) merged.push(it);
    log('fetchAllFeeds.channel_done', { user, added: arr.length, total: merged.length });
    if (i < PARSE_CHANNELS.length - 1) {
      log('fetchAllFeeds.sleep', { ms: FEED_DELAY_MS });
      await sleep(FEED_DELAY_MS);
    }
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

// ----------------- OpenAI (текст) -----------------
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
    const fallback = `${title}\n\n${plain}\n\nИсточник: ${link}`;
    log('openai.chat.fallback', { out_len: fallback.length });
    return fallback.slice(0, 980);
  }
}

// --- Парсер: вытащить заголовок H2 из markdown и отделить тело ---
function splitTitleFromBody(markdown = '') {
  const lines = (markdown || '').split(/\r?\n/);
  let title = '';
  let idx = -1;
  for (let i = 0; i < Math.min(lines.length, 10); i++) {
    const m = lines[i].match(/^##\s*(.+?)\s*$/);
    if (m) { title = m[1].trim(); idx = i; break; }
  }
  if (idx >= 0) lines.splice(idx, 1);
  const body = lines.join('\n').trim();
  log('rewrite.parse', { has_h2: Boolean(title), title_sample: trunc(title, 80) });
  return { title, body };
}

// ----------------- Хэши (aHash, dHash, pHash) на sharp -----------------
function hamming(a, b) {
  let d = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) d++;
  return d;
}

async function getGrayRaw(buf, w, h) {
  const { data, info } = await sharp(buf)
    .rotate() // применяем EXIF-ориентацию
    .toColourspace('b-w')
    .resize(w, h, { fit: 'fill', kernel: sharp.kernel.lanczos3 })
    .raw()
    .toBuffer({ resolveWithObject: true });
  // data — Uint8Array длиной w*h (1 канал)
  if (info.channels !== 1) {
    // на всякий случай приведём к 1 каналу
    const g = [];
    for (let i = 0; i < data.length; i += info.channels) g.push(data[i]);
    return Uint8Array.from(g);
  }
  return data;
}

// aHash: 8x8, порог по среднему
async function aHash64(buf) {
  const W = 8, H = 8;
  const g = await getGrayRaw(buf, W, H);
  let sum = 0;
  for (let i = 0; i < g.length; i++) sum += g[i];
  const avg = sum / g.length;
  let bits = '';
  for (let i = 0; i < g.length; i++) bits += (g[i] >= avg ? '1' : '0');
  return bits; // 64 бита
}

// dHash: 9x8, сравнение по горизонтали
async function dHash64(buf) {
  const W = 9, H = 8;
  const g = await getGrayRaw(buf, W, H);
  let bits = '';
  for (let y = 0; y < H; y++) {
    const rowOff = y * W;
    for (let x = 0; x < W - 1; x++) {
      bits += (g[rowOff + x] > g[rowOff + x + 1]) ? '1' : '0';
    }
  }
  return bits; // 64 бита
}

// pHash: 32x32 -> DCT -> верхний 8x8 (кроме DC), порог по медиане
async function pHash64(buf) {
  const N = 32;
  const g = await getGrayRaw(buf, N, N);
  // нормируем 0..1
  const f = new Array(N * N);
  for (let i = 0; i < N * N; i++) f[i] = g[i] / 255;

  const C = (k) => (k === 0 ? Math.SQRT1_2 : 1);
  const F = new Array(N * N).fill(0);
  for (let u = 0; u < 8; u++) {
    for (let v = 0; v < 8; v++) {
      let sum = 0;
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          sum += f[y * N + x] *
            Math.cos(((2 * x + 1) * u * Math.PI) / (2 * N)) *
            Math.cos(((2 * y + 1) * v * Math.PI) / (2 * N));
        }
      }
      F[u * N + v] = (C(u) * C(v) / 4) * sum;
    }
  }
  const coeffs = [];
  for (let u = 0; u < 8; u++) for (let v = 0; v < 8; v++) {
    if (u === 0 && v === 0) continue;
    coeffs.push(F[u * N + v]);
  }
  const sorted = coeffs.slice().sort((a,b)=>a-b);
  const median = sorted[Math.floor(sorted.length/2)];
  let bits = '';
  for (const c of coeffs) bits += (c > median ? '1' : '0');
  return bits; // 63 бита
}

async function hashDistances(origBuf, candBuf) {
  const [aA, dA, pA] = await Promise.all([aHash64(origBuf), dHash64(origBuf), pHash64(origBuf)]);
  const [aB, dB, pB] = await Promise.all([aHash64(candBuf), dHash64(candBuf), pHash64(candBuf)]);
  return {
    a: hamming(aA, aB),
    d: hamming(dA, dB),
    p: hamming(pA, pB)
  };
}

// ----------------- Изображения на sharp -----------------
async function toPngKeepSize(buffer) {
  try {
    const meta = await sharp(buffer).rotate().metadata(); // rotate() применяет EXIF
    const out = await sharp(buffer).rotate().png({ compressionLevel: 9, quality: 100 }).toBuffer();
    log('img.toPngKeepSize.done', { w: meta.width, h: meta.height, out_size: out.length });
    return { png: out, w: meta.width, h: meta.height };
  } catch (e) {
    log('img.toPngKeepSize.error', { error: e.message });
    throw e;
  }
}

// Лёгкая цветокоррекция без деградации
async function applyLocalFilterSharp(buf, { style = IMG_STYLE, strength = IMG_FILTER_STRENGTH } = {}) {
  if (style === 'none') return buf;

  const s = (strength === 'high')
    ? { sat: 1.18, bright: 1.03, gamma: 0.95 }
    : (strength === 'low')
      ? { sat: 1.06, bright: 1.01, gamma: 1.00 }
      : { sat: 1.10, bright: 1.02, gamma: 0.98 };

  let img = sharp(buf);

  if (style === 'bw' || style === 'noir') {
    img = img.greyscale();
  }

  img = img.modulate({
    brightness: s.bright,
    saturation: style === 'noir' ? 1.00 : s.sat,
    hue: style === 'vivid' ? 8 : 0
  }).gamma(s.gamma);

  if (style === 'cinematic' || style === 'matte' || style === 'vivid' || style === 'noir') {
    const meta = await sharp(buf).metadata();
    const { width: W, height: H } = meta;
    const teal = { r: 14, g: 58, b: 89, alpha: style === 'cinematic' ? 0.18 : 0.08 };
    const orange = { r: 255, g: 138, b: 0, alpha: style === 'cinematic' ? 0.14 : 0.06 };

    const overlayTeal = await sharp({
      create: { width: W, height: H, channels: 4, background: teal }
    }).png().toBuffer();

    const overlayOrange = await sharp({
      create: { width: W, height: H, channels: 4, background: orange }
    }).png().toBuffer();

    img = img
      .composite([{ input: overlayTeal, blend: 'overlay' }])
      .composite([{ input: overlayOrange, blend: 'soft-light' }]);

    if (style === 'matte') {
      img = img.linear(1, -5).sharpen(0.2);
    }
  }

  const out = await img.png({ compressionLevel: 9, quality: 100 }).toBuffer();
  log('img.localFilter.out', { size: out.length, style, strength });
  return out;
}

async function makeRadialVignette(W, H, alpha = 0.18) {
  const buf = Buffer.alloc(W * H * 4);
  const cx = W / 2, cy = H / 2;
  const maxR = Math.sqrt(cx * cx + cy * cy);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x - cx, dy = y - cy;
      const r = Math.sqrt(dx * dx + dy * dy) / maxR; // 0..1
      const v = Math.max(0, Math.min(1, (r - 0.6) / 0.4)); // 0..1 к краям
      const k = Math.floor(255 * v * alpha);
      const idx = (y * W + x) * 4;
      buf[idx + 0] = 0;
      buf[idx + 1] = 0;
      buf[idx + 2] = 0;
      buf[idx + 3] = k;
    }
  }
  return await sharp(buf, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
}

// Структурная модификация без деградации: кроп (0.92–0.98), LANCZOS3, смещение на блюр-фон, опциональный горизонтальный flop
async function structuralAugmentSharp(origBuf, W, H) {
  const base = sharp(origBuf).rotate(); // учитываем EXIF
  const meta = await base.metadata();
  const srcW = meta.width, srcH = meta.height;

  const mirror = Math.random() < IMG_FLIP_PROB; // только горизонтально (не flip)
  const basePrepared = mirror ? base.clone().flop() : base.clone();

  // Фон: блюр в целевом размере
  const bg = await base.clone()
    .resize(W, H, { fit: 'cover', kernel: sharp.kernel.lanczos3 })
    .blur(8)
    .png()
    .toBuffer();

  // Случайный кроп без изменения пропорций
  const cropK = IMG_CROP_MIN + Math.random() * (IMG_CROP_MAX - IMG_CROP_MIN);
  const cw = Math.max(8, Math.floor(srcW * cropK));
  const ch = Math.max(8, Math.floor(srcH * cropK));
  const maxX = Math.max(0, srcW - cw);
  const maxY = Math.max(0, srcH - ch);
  const left = Math.floor(Math.random() * (maxX + 1));
  const top = Math.floor(Math.random() * (maxY + 1));

  // Маленький наклон, но не «вверх ногами»
  const angle = IMG_ROTATE_MAX_DEG > 0 ? (Math.random() * 2 - 1) * IMG_ROTATE_MAX_DEG : 0;

  const cropBuf = await basePrepared
    .clone()
    .extract({ left, top, width: cw, height: ch })
    .rotate(angle, { background: { r: 0, g: 0, b: 0, alpha: 0 }})
    .resize(W, H, { fit: 'inside', kernel: sharp.kernel.lanczos3 })
    .png()
    .toBuffer();

  const cropMeta = await sharp(cropBuf).metadata();
  const newW = cropMeta.width;
  const newH = cropMeta.height;

  // Случайный оффсет на канвасе
  const ox = Math.floor((W - newW) * Math.random());
  const oy = Math.floor((H - newH) * Math.random());

  // Сборка
  const composed = await sharp(bg)
    .composite([{ input: cropBuf, left: ox, top: oy }])
    .png({ compressionLevel: 9, quality: 100 })
    .toBuffer();

  // Лёгкая виньетка
  const vignetteAlpha = 0.18;
  const vignette = await makeRadialVignette(W, H, vignetteAlpha);
  const withVignette = await sharp(composed)
    .composite([{ input: vignette, blend: 'multiply' }])
    .png({ compressionLevel: 9, quality: 100 })
    .toBuffer();

  return withVignette;
}

// Обеспечить «непохожесть» по всем 3 хэшам, сохраняя W×H и высокое качество
async function ensureDistinctEnoughSharp(origPng, W, H) {
  if (!IMG_REQUIRE_ORIGINALITY) return origPng;

  let candidate = origPng;
  for (let i = 0; i < IMG_STRUCT_TRIES; i++) {
    candidate = await structuralAugmentSharp(origPng, W, H);
    candidate = await applyLocalFilterSharp(candidate, { style: IMG_STYLE, strength: IMG_FILTER_STRENGTH });

    const dist = await hashDistances(origPng, candidate);
    log('img.struct.check', { try: i + 1, aHash: dist.a, dHash: dist.d, pHash: dist.p });

    if (dist.a >= IMG_AHASH_MIN_DIST && dist.d >= IMG_DHASH_MIN_DIST && dist.p >= IMG_PHASH_DCT_MIN_DIST) {
      return candidate;
    }
  }
  return candidate;
}

async function downloadBuffer(url) {
  log('download.begin', { url: trunc(url, 200) });
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'rss-poster-bot/1.0 (Node16)' }, timeout: 20000 });
    log('download.status', { url: trunc(url, 200), status: res.status });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.buffer();
    log('download.done', { url: trunc(url, 200), size: buf.length });
    return buf;
  } catch (e) {
    log('download.error', { url: trunc(url, 200), error: e.message });
    return null;
  }
}

// ----------------- Дедуп -----------------
function makeKeys(item) {
  const baseId = item.id || item.link || '';
  const fallbackId = sha256(
    (item.title || '') + '|' + (item.isoDate || '') + '|' + (item.link || '')
  );
  const id = baseId || fallbackId;

  const canonical = canonicalizeUrl(item.link || '');
  const plain = (item.contentSnippet || stripHtml(item.content || '')).toLowerCase();
  const urlHash = sha256(canonical);
  const contentHash = sha256((item.title || '') + '|' + plain);

  const keys = { id, urlHash, contentHash, canonical, plain };
  log('dedupe.keys', {
    id,
    urlHash,
    contentHash,
    canonical: trunc(canonical, 160),
    plain_len: plain.length
  });
  return keys;
}

function seenAny({ id, urlHash, contentHash }) {
  const any = hasStoreKey(`id:${id}`) || hasStoreKey(`uh:${urlHash}`) || hasStoreKey(`ch:${contentHash}`);
  log('dedupe.seenAny', { id, any });
  return any;
}

function markOffered(item, keys) {
  const value = {
    id: keys.id,
    link: item.link,
    source: item.source,
    isoDate: item.isoDate,
    status: 'offered',
    offeredAt: nowISO()
  };
  log('dedupe.markOffered', value);
  setStoreItem(`id:${keys.id}`, value);
  setStoreItem(`uh:${keys.urlHash}`, value);
  setStoreItem(`ch:${keys.contentHash}`, value);
}

function markPosted(item, keys) {
  const value = {
    id: keys.id,
    link: item.link,
    source: item.source,
    isoDate: item.isoDate,
    status: 'posted',
    postedAt: nowISO()
  };
  log('dedupe.markPosted', value);
  setStoreItem(`id:${keys.id}`, value);
  setStoreItem(`uh:${keys.urlHash}`, value);
  setStoreItem(`ch:${keys.contentHash}`, value);
}

// ----------------- Telegraf -----------------
const bot = new Telegraf(BOT_TOKEN, { handlerTimeout: 0 }); // важный фикс для долгих задач

// Глобальный catcher
bot.catch((err, ctx) => {
  log('bot.error', {
    error: err?.message || String(err),
    update_type: ctx?.updateType,
    stack: trunc(err?.stack || '', 1000)
  });
});

bot.use(async (ctx, next) => {
  log('update.received', {
    from: ctx.from ? { id: ctx.from.id, username: ctx.from.username } : null,
    chat: ctx.chat ? { id: ctx.chat.id, type: ctx.chat.type } : null,
    type: ctx.updateType
  });
  await next();
});

const BUSY = new Set();
function setBusy(chatId, v) { if (v) BUSY.add(chatId); else BUSY.delete(chatId); }
function isBusy(chatId) { return BUSY.has(chatId); }

// --- Убираем инлайн-клавиатуру у сообщения с кнопками ---
async function freezeButtons(ctx, toast = 'Обрабатываю…') {
  await ctx.answerCbQuery(toast).catch(() => {});
  try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); }
  catch (e) { log('ui.freezeButtons.error', { error: e.message }); }
}

// Память активных предложений
const OFFERS = new Map();

bot.start(async (ctx) => {
  log('ui.start', { chat: ctx.chat?.id });
  await ctx.reply(
    'Предложение: вы можете опубликовать самый свежий пост.',
    Markup.inlineKeyboard([[Markup.button.callback('🚀 Начать', 'start_offer')]])
  );
});

bot.on('text', async (ctx) => {
  log('ui.text.autoOffer', { chat: ctx.chat?.id, text_len: ctx.message?.text?.length || 0 });
  await ctx.reply(
    'Предложение: вы можете опубликовать самый свежий пост.',
    Markup.inlineKeyboard([[Markup.button.callback('🚀 Начать', 'start_offer')]])
  );
});

bot.action('start_offer', async (ctx) => {
  log('ui.action', { data: 'start_offer', chat: ctx.chat?.id });
  await ctx.answerCbQuery().catch(()=>{});
  await offerNext(ctx);
});

bot.action(/publish:(.+)/, async (ctx) => {
  const chatId = ctx.chat.id;
  const hashId = ctx.match[1];
  log('ui.action', { data: `publish:${hashId}`, chat: chatId });
  if (isBusy(chatId)) {
    await ctx.answerCbQuery('⏳ Уже выполняю предыдущее действие…').catch(()=>{});
    return;
  }
  setBusy(chatId, true);
  await freezeButtons(ctx, '⏳ Публикую…');
  const offer = OFFERS.get(chatId);
  if (!offer || offer.hashId !== hashId) {
    log('ui.publish.stale', { chatId, hashId });
    await ctx.reply(
      'Эта карточка устарела. Нажмите «Начать» ещё раз.',
      Markup.inlineKeyboard([[Markup.button.callback('🚀 Начать', 'start_offer')]])
    );
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
  log('ui.action', { data: 'cancel', chat: ctx.chat?.id });
  const chatId = ctx.chat.id;
  if (isBusy(chatId)) {
    await ctx.answerCbQuery('⏳ Уже выполняю предыдущее действие…').catch(()=>{});
    return;
  }
  setBusy(chatId, true);
  await freezeButtons(ctx, '⏭ Отменяю…');
  try {
    await ctx.reply('⏭ Отменено. Ищу следующую запись…');
    await offerNext(ctx);
  } catch (e) {
    log('ui.cancel.catch', { error: e.message });
  } finally {
    setBusy(chatId, false);
  }
});

// Показ следующей свежей записи (самая свежая из 3×N)
async function offerNext(ctx) {
  log('offer.next.begin', { chat: ctx.chat?.id });
  try {
    await ctx.reply('Ищу самую свежую запись…');
    const items = await fetchAllFeeds();
    const normalized = items.map(it => ({ ...it, ts: toTs(it.isoDate) }));
    normalized.sort((a, b) => b.ts - a.ts);
    log('offer.sorted', { count: normalized.length, top_ts: normalized[0]?.ts });

    let candidate = null;
    let keys = null;

    for (const it of normalized) {
      const k = makeKeys(it);
      if (!k.id) { log('offer.skip.no_id', { link: it.link }); continue; }
      if (!seenAny(k)) { candidate = it; keys = k; break; }
      log('offer.skip.seen', { id: k.id });
    }

    if (!candidate) {
      log('offer.none');
      await ctx.reply('Свежих непредложенных записей не нашлось. Попробуйте позже.');
      return;
    }

    markOffered(candidate, keys);
    const hashId = sha256(keys.id).slice(0, 16);
    OFFERS.set(ctx.chat.id, { item: candidate, keys, hashId });

    const title = candidate.title || '(без заголовка)';
    const url = candidate.link || '';
    const text = `<b>${escapeHtml(title)}</b>\n\n${escapeHtml(url)}`;
    log('offer.show', { id: keys.id, url, source: candidate.source });

    await ctx.replyWithHTML(
      text,
      Markup.inlineKeyboard([
        [
          Markup.button.callback('✅ Опубликовать', `publish:${hashId}`),
          Markup.button.callback('⏭ Отменить (следующая)', 'cancel')
        ]
      ])
    );
  } catch (e) {
    log('offer.error', { error: e.message });
    await ctx.reply('Ошибка при получении записи. Попробуйте снова.');
  }
}

// Публикация: переписываем текст + делаем картинку «оригинальной» (aHash/dHash/pHash) без падения качества
async function publishToChannel(ctx, item, keys) {
  log('publish.begin', { id: keys.id, source: item.source, link: item.link });
  try {
    // 1) Текст -> новый заголовок + тело
    const plain = (item.contentSnippet || stripHtml(item.content || '')).trim();
    const rewrittenRaw = await openaiChatRewrite({ title: item.title || '', plain, link: item.link || '' });
    const { title: newTitle, body: rewrittenBody } = splitTitleFromBody(rewrittenRaw);
    const finalTitle = newTitle || (item.title || '(без заголовка)');

    // 2) Картинки
    const imgUrls = extractImagesFromContent(item.content || '').slice(0, MAX_PHOTOS);
    log('publish.images', { count: imgUrls.length });

    let mediaGroup = [];
    for (let i = 0; i < imgUrls.length; i++) {
      const url = imgUrls[i];
      const buf = await downloadBuffer(url);
      if (!buf) { log('publish.image.skip.download', { url }); continue; }

      try {
        const { png, w, h } = await toPngKeepSize(buf);
        const distinct = await ensureDistinctEnoughSharp(png, w, h);

        // опционально ещё лёгкая фильтрация (если стиль задан)
        const finalBuf = await applyLocalFilterSharp(distinct, { style: IMG_STYLE, strength: IMG_FILTER_STRENGTH });

        mediaGroup.push({
          type: 'photo',
          media: { source: finalBuf, filename: `photo_${i + 1}.png` }
        });
      } catch (e) {
        log('publish.image.error', { error: e.message, url: trunc(url, 180) });
        // Фоллбек — отдать как есть
        mediaGroup.push({
          type: 'photo',
          media: { source: buf, filename: `photo_${i + 1}.png` }
        });
      }
    }
    log('publish.mediaGroup.ready', { photos: mediaGroup.length });

    // 3) Подпись — используем НОВЫЙ заголовок
    const caption = buildCaption(finalTitle, rewrittenBody || rewrittenRaw);
    log('publish.caption', { len: caption.length, sample: trunc(caption, 200) });

    // 4) Отправка
    if (mediaGroup.length > 0) {
      mediaGroup[0].caption = caption;
      mediaGroup[0].parse_mode = 'HTML';
      log('tg.sendMediaGroup.begin', { photos: mediaGroup.length, channel: CHANNEL_ID });
      const res = await ctx.telegram.sendMediaGroup(CHANNEL_ID, mediaGroup).catch(async (e) => {
        log('tg.sendMediaGroup.error', { error: e.message });
        throw e;
      });
      log('tg.sendMediaGroup.done', { messages: res?.length || 0 });
    } else {
      log('tg.sendMessage.begin', { channel: CHANNEL_ID });
      const res = await ctx.telegram.sendMessage(CHANNEL_ID, caption, { parse_mode: 'HTML', disable_web_page_preview: true })
        .catch(async (e) => {
          log('tg.sendMessage.error', { error: e.message });
          throw e;
        });
      log('tg.sendMessage.done', { message_id: res?.message_id });
    }

    // 5) Статус posted
    markPosted(item, keys);
    log('publish.ok', { id: keys.id });
  } catch (e) {
    log('publish.error', { error: e.message });

    if (String(e.message).includes('chat not found')) {
      await ctx.reply(
        '❗️Телеграм отвечает: «chat not found».\n' +
        'Проверьте, что:\n' +
        '— CHANNEL_ID = @username вашего канала (или -100... числовой id);\n' +
        '— бот добавлен в канал и повышен до администратора.\n' +
        'После исправления попробуйте снова.'
      );
    } else {
      await ctx.reply('Ошибка при публикации. Попробуйте другую запись.');
    }
    await offerNext(ctx);
  }
}

function buildCaption(title, body) {
  const cap = `<b>${escapeHtml(title)}</b>\n\n${escapeHtml(body)}`;
  if (cap.length > 1000) log('caption.truncate', { from: cap.length, to: 1000 });
  return cap.length > 1000 ? cap.slice(0, 997) + '…' : cap;
}

// ----------------- Проверка доступа к каналу -----------------
async function verifyChannelAccess(bot) {
  try {
    log('channel.verify.begin', { CHANNEL_ID });
    const chat = await bot.telegram.getChat(CHANNEL_ID);
    log('channel.verify.ok', {
      id: chat.id,
      type: chat.type,
      title: chat.title || chat.username || null
    });
    const me = await bot.telegram.getMe();
    const admins = await bot.telegram.getChatAdministrators(CHANNEL_ID);
    const isAdmin = admins.some(a => a.user.id === me.id);
    log('channel.verify.admins', { me: me.username, isAdmin });
    if (!isAdmin) {
      log('channel.warn.not_admin', {});
      console.warn('ВНИМАНИЕ: бот не администратор канала — публикация может не работать.');
    }
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
