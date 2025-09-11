// index.js — Node 16
// deps: telegraf@4, node-fetch@2, form-data@4, cheerio@1, jimp@0.22, dotenv

require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const fetch = require('node-fetch'); // v2 для Node 16
const FormData = require('form-data');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const Jimp = require('jimp');

// ----------------- Текстовый промпт для переписывания -----------------
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
1) Заголовок (H2) ≤ 60 знаков.
2) Лид: 1–2 коротких предложения.
3) Список 3–6 ключевых фактов (по 1 предложению, ≤110 символов).
4) Подразделы (H3) «Техника и цифры», «Салон и технологии», «Динамика и расход», «Версии и комплектации», «Цены и старт продаж» — только уместные.
5) Финальный штрих: вопрос (если CTA=question) или нейтральный вывод (CTA=none).
ТРЕБОВАНИЯ:
- Средняя длина 9–15 слов; абзацы 1–3 предложения; связки «Кроме того», «При этом» и т.д.
- Единый стиль чисел/единиц.
- Без тавтологии и канцелярита.
ДЛИНА:
- short: ~120–180 слов; medium: ~220–350 слов.
ОФОРМЛЕНИЕ:
- FORMAT=markdown: начинай с \`##\`.
ПРОВЕРКИ:
- Совпадение фактов/чисел.
- Антиплагиат: иной порядок/формулировки.
- Корректность ссылок.
- Ясность и читабельность.
`;

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
const FEED_URLS = (process.env.FEED_URLS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const MAX_PHOTOS = Math.min(Number(process.env.MAX_PHOTOS || 10), 10);
const FEED_DELAY_MS = Number(process.env.FEED_DELAY_MS || 3000);

// Параметры обработки изображений
const IMG_STYLE = (process.env.IMG_STYLE || 'cinematic').toLowerCase(); // cinematic|vivid|matte|noir|bw
const IMG_FILTER_STRENGTH = (process.env.IMG_FILTER_STRENGTH || 'medium').toLowerCase(); // low|medium|high
const IMG_DIFF_THRESHOLD = Number(process.env.IMG_DIFF_THRESHOLD || 0.04); // 0..1 — «слишком похоже»
const IMG_ALWAYS_LOCAL_FILTER = process.env.IMG_ALWAYS_LOCAL_FILTER === '1';

// --- Новые параметры для структурных отличий ---
const IMG_ENSURE_STRUCT = process.env.IMG_ENSURE_STRUCT === '0' ? false : true; // включено по умолчанию
const IMG_PHASH_MIN_DIST = Number(process.env.IMG_PHASH_MIN_DIST || 16); // требуемая дистанция dHash (из 64)
const IMG_ROTATE_MAX_DEG = Number(process.env.IMG_ROTATE_MAX_DEG || 3.0); // ±градусов
const IMG_FLIP_PROB = Number(process.env.IMG_FLIP_PROB || 0.5); // вероятность горизонтального флипа
const IMG_CROP_MIN = Number(process.env.IMG_CROP_MIN || 0.72);  // доля стороны при кропе
const IMG_CROP_MAX = Number(process.env.IMG_CROP_MAX || 0.88);
const IMG_STRUCT_TRIES = Number(process.env.IMG_STRUCT_TRIES || 3); // попыток добиться дистанции

log('config.load.begin');
log('config.values', {
  node: process.version,
  feeds_count: FEED_URLS.length,
  channel_id: CHANNEL_ID,
  bot_token: mask(BOT_TOKEN),
  openai_key: mask(OPENAI_API_KEY),
  openai_base_url: OPENAI_BASE_URL,
  log_to_file: LOG_TO_FILE,
  max_photos: MAX_PHOTOS,
  feed_delay_ms: FEED_DELAY_MS,
  img_style: IMG_STYLE,
  img_strength: IMG_FILTER_STRENGTH,
  img_diff_threshold: IMG_DIFF_THRESHOLD,
  img_always_local_filter: IMG_ALWAYS_LOCAL_FILTER,
  img_ensure_struct: IMG_ENSURE_STRUCT,
  img_phash_min_dist: IMG_PHASH_MIN_DIST,
  img_rotate_max_deg: IMG_ROTATE_MAX_DEG,
  img_flip_prob: IMG_FLIP_PROB,
  img_crop_min: IMG_CROP_MIN,
  img_crop_max: IMG_CROP_MAX,
  img_struct_tries: IMG_STRUCT_TRIES
});

if (!BOT_TOKEN || !CHANNEL_ID || !OPENAI_API_KEY || FEED_URLS.length === 0) {
  log('config.error.missing_env');
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

// ----------------- RSS загрузка -----------------
async function fetchFeed(url) {
  log('rss.fetch.begin', { url });
  const maxTries = 3;
  for (let attempt = 1; attempt <= maxTries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'rss-poster-bot/1.0 (Node16)' },
        timeout: 18000
      });
      log('rss.fetch.status', { url, status: res.status, attempt });
      if (res.status === 429) {
        const wait = 1000 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 1200);
        log('rss.fetch.backoff', { url, wait });
        await sleep(wait);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json().catch(() => ({}));
      const arr = Array.isArray(json) ? json : (json.items || []);
      log('rss.fetch.done', { url, items: arr.length, attempt });
      return arr;
    } catch (e) {
      log('rss.fetch.error', { url, attempt, error: e.message });
      const wait = 900 * attempt + Math.floor(Math.random() * 500);
      await sleep(wait);
    }
  }
  log('rss.fetch.fail', { url });
  return [];
}

async function fetchAllFeeds() {
  log('rss.all.begin', { count: FEED_URLS.length });
  const items = [];

  for (let idx = 0; idx < FEED_URLS.length; idx++) {
    const url = FEED_URLS[idx];
    const arr = await fetchFeed(url);
    const srcPath = new URL(url).pathname;
    const source = srcPath.split('/').pop().split('?')[0] || 'unknown';

    for (const it of arr) {
      const id = it.id || it.guid || it.url || it.link || '';
      const link = it.url || it.link || it.guid || it.id || '';
      const title = it.title || it.name || '';
      const contentHtml = it.content_html || it.content || it.summary || '';
      const contentText = it.content_text || stripHtml(contentHtml) || it.description || '';
      const isoDate = it.isoDate || it.pubDate || it.date_published || it.date_modified || it.date || null;

      items.push({
        source,
        id,
        link,
        title,
        isoDate,
        content: contentHtml,
        contentSnippet: contentText
      });
    }

    log('rss.all.after_one', { url, added: arr.length, total: items.length });
    if (idx < FEED_URLS.length - 1) {
      log('rss.all.sleep', { ms: FEED_DELAY_MS });
      await sleep(FEED_DELAY_MS);
    }
  }

  log('rss.all.merged', { total: items.length });
  return items;
}

// ----------------- OpenAI -----------------
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

// PNG без ресайза (сохраняем W×H), конвертируем в PNG для edits
async function toPngKeepSize(buffer) {
  log('img.toPngKeepSize.begin', { in_size: buffer.length });
  const img = await Jimp.read(buffer);
  const w = img.getWidth();
  const h = img.getHeight();
  log('img.info', { w, h });
  const out = await img.getBufferAsync(Jimp.MIME_PNG);
  log('img.toPngKeepSize.done', { out_size: out.length });
  return { png: out, w, h };
}

// Растянуть квадрат OpenAI (1024×1024) в точные W×H БЕЗ сохранения пропорций
async function stretchToOriginalSize(editedBuf, targetW, targetH) {
  log('img.stretchToOriginal.begin', { in_size: editedBuf.length, targetW, targetH });
  const edited = await Jimp.read(editedBuf);
  const out = await edited
    .resize(targetW, targetH, Jimp.RESIZE_BILINEAR) // деформация до W×H
    .getBufferAsync(Jimp.MIME_PNG);
  log('img.stretchToOriginal.done', { out_size: out.length });
  return out;
}

// OpenAI edits — всегда 1024×1024 + заметный color grading по стилю
async function openaiEditBackground(pngBuffer) {
  log('openai.img.req.begin', { in_size: pngBuffer.length, size: '1024x1024', IMG_STYLE, IMG_FILTER_STRENGTH });

  const stylePromptMap = {
    cinematic: 'apply a clearly visible cinematic teal-orange color grading, subtle film grain, cooler white balance',
    vivid:     'apply a clearly visible vivid color grading with higher saturation and crisp contrast',
    matte:     'apply a clearly visible matte color grading with softened highlights and muted saturation',
    noir:      'apply a clearly visible high-contrast noir grading with deep blacks and soft highlights',
    bw:        'convert to clearly visible black-and-white with rich mid-tones and film grain'
  };
  const styleLine = stylePromptMap[IMG_STYLE] || stylePromptMap.cinematic;
  const strengthLine = (IMG_FILTER_STRENGTH === 'high')
    ? 'strength: high; strong but still realistic'
    : (IMG_FILTER_STRENGTH === 'low')
      ? 'strength: low; yet clearly noticeable'
      : 'strength: medium; clearly noticeable';

  const form = new FormData();
  form.append('image', pngBuffer, { filename: 'image.png', contentType: 'image/png' });
  form.append('prompt', [
    'Change the background to a neutral soft bokeh; remove any text/watermarks.',
    'Keep the main subject intact, composition and realism preserved.',
    styleLine + '; ' + strengthLine + '; no borders; no frames; no text.',
  ].join(' '));
  form.append('size', '1024x1024');
  form.append('n', '1');
  form.append('response_format', 'b64_json');

  try {
    const res = await fetch(`${OPENAI_BASE_URL}/v1/images/edits`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, ...form.getHeaders() },
      body: form,
      timeout: 90000
    });
    const txt = await res.text();
    log('openai.img.status', { status: res.status, len: txt.length });
    const json = JSON.parse(txt);
    if (!res.ok) throw new Error(txt);
    const b64 = json.data?.[0]?.b64_json;
    if (!b64) throw new Error('No b64_json');
    const buf = Buffer.from(b64, 'base64');
    log('openai.img.ok', { out_size: buf.length });
    return buf;
  } catch (e) {
    log('openai.img.error', { error: e.message });
    return null;
  }
}

// ---- dHash 64-бит (инвариантен к цвету/яркости, реагирует на композицию) ----
async function dhash64(buf) {
  const W = 9, H = 8; // (W-1)*H = 64 бита
  const img = await Jimp.read(buf);
  img.resize(W, H).greyscale();
  let bits = '';
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W - 1; x++) {
      const a = Jimp.intToRGBA(img.getPixelColor(x, y)).r;
      const b = Jimp.intToRGBA(img.getPixelColor(x + 1, y)).r;
      bits += (a > b) ? '1' : '0';
    }
  }
  return bits;
}
function hamming(a, b) {
  let d = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) d++;
  return d;
}

// ---- Структурная аугментация (кроп 72–88%, флип, поворот, перепозиционирование на блюр-фоне) ----
async function structuralAugment(buf, targetW, targetH) {
  const img = await Jimp.read(buf);

  // вероятностный флип
  if (Math.random() < IMG_FLIP_PROB) img.flip(true, false);

  // лёгкий поворот
  const ang = (Math.random() * 2 - 1) * IMG_ROTATE_MAX_DEG;
  img.rotate(ang, false); // без увеличения канвы

  // кроп
  const cropK = IMG_CROP_MIN + Math.random() * (IMG_CROP_MAX - IMG_CROP_MIN);
  const cw = Math.max(8, Math.floor(img.getWidth() * cropK));
  const ch = Math.max(8, Math.floor(img.getHeight() * cropK));
  const maxX = Math.max(0, img.getWidth() - cw);
  const maxY = Math.max(0, img.getHeight() - ch);
  const x = Math.floor(Math.random() * (maxX + 1));
  const y = Math.floor(Math.random() * (maxY + 1));
  const cropped = img.clone().crop(x, y, cw, ch);

  // фон из блюра исходника
  const bg = img.clone().blur(12).resize(targetW, targetH);
  const out = new Jimp(targetW, targetH);
  out.composite(bg, 0, 0);

  // вписываем кроп + небольшое "смещение к третям"
  const k = Math.min(targetW / cw, targetH / ch);
  const nw = Math.max(1, Math.floor(cw * k));
  const nh = Math.max(1, Math.floor(ch * k));
  const ox = Math.floor((targetW - nw) * (0.25 + Math.random() * 0.5));
  const oy = Math.floor((targetH - nh) * (0.25 + Math.random() * 0.5));
  cropped.resize(nw, nh, Jimp.RESIZE_BILINEAR);
  out.composite(cropped, ox, oy);

  // лёгкая виньетка по краям
  const vign = new Jimp(targetW, targetH, 0x00000000);
  const edge = Math.max(targetW, targetH);
  for (let yy = 0; yy < targetH; yy++) {
    for (let xx = 0; xx < targetW; xx++) {
      const dx = (xx - targetW / 2), dy = (yy - targetH / 2);
      const r = Math.sqrt(dx * dx + dy * dy) / (edge / 2);
      const a = Math.max(0, Math.min(80, Math.floor((r - 0.6) * 220))); // 0..80
      vign.setPixelColor(Jimp.rgbaToInt(0, 0, 0, a), xx, yy);
    }
  }
  out.composite(vign, 0, 0);
  return await out.getBufferAsync(Jimp.MIME_PNG);
}

// Гарантировать расстояние dHash с исходником; несколько попыток
async function ensureStructDiff(origPng, candidateBuf, W, H) {
  let out = candidateBuf;
  const origHash = await dhash64(origPng);
  for (let i = 0; i < IMG_STRUCT_TRIES; i++) {
    const aug = await structuralAugment(out, W, H);
    const augHash = await dhash64(aug);
    const dist = hamming(origHash, augHash);
    log('img.struct.check', { try: i + 1, phash_dist: dist, need: IMG_PHASH_MIN_DIST });
    out = aug;
    if (dist >= IMG_PHASH_MIN_DIST) return aug;
  }
  return out;
}

// Оценка «насколько отличаются» картинки (0..1): downscale до 64×64 и суммарная разница RGB
async function diffRatio(aBuf, bBuf) {
  const SIZE = 64;
  const a = await Jimp.read(aBuf);
  const b = await Jimp.read(bBuf);
  a.resize(SIZE, SIZE, Jimp.RESIZE_BILINEAR);
  b.resize(SIZE, SIZE, Jimp.RESIZE_BILINEAR);
  let diff = 0;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const ca = Jimp.intToRGBA(a.getPixelColor(x, y));
      const cb = Jimp.intToRGBA(b.getPixelColor(x, y));
      diff += Math.abs(ca.r - cb.r) + Math.abs(ca.g - cb.g) + Math.abs(ca.b - cb.b);
    }
  }
  const max = SIZE * SIZE * 255 * 3;
  const ratio = diff / max;
  log('img.diff.ratio', { ratio: Number(ratio.toFixed(5)) });
  return ratio;
}

// Локальный фильтр (Jimp) — гарантированная «заметность»
async function applyLocalFilter(buf, { style = IMG_STYLE, strength = IMG_FILTER_STRENGTH } = {}) {
  const img = await Jimp.read(buf);
  const w = img.getWidth(), h = img.getHeight();
  const s = (strength === 'high') ? { c: 0.28, br: 0.05, sat: 26, o1: 0.28, o2: 0.22, noise: 8 }
          : (strength === 'low')  ? { c: 0.12, br: 0.02, sat: 12, o1: 0.18, o2: 0.12, noise: 4 }
                                  : { c: 0.20, br: 0.03, sat: 18, o1: 0.22, o2: 0.15, noise: 6 };

  // Базовые правки
  img.contrast(s.c).brightness(s.br);
  if (style !== 'bw' && style !== 'noir') {
    img.color([{ apply: 'saturate', params: [s.sat] }]);
  }
  if (style === 'cinematic') {
    const teal = new Jimp(w, h, '#0e3a59');
    const orange = new Jimp(w, h, '#ff8a00');
    img.composite(teal, 0, 0, { mode: Jimp.BLEND_OVERLAY, opacitySource: s.o1, opacityDest: 1 });
    img.composite(orange, 0, 0, { mode: Jimp.BLEND_SOFTLIGHT, opacitySource: s.o2, opacityDest: 1 });
  } else if (style === 'vivid') {
    img.color([{ apply: 'saturate', params: [s.sat] }, { apply: 'spin', params: [8] }]);
  } else if (style === 'matte') {
    img.color([{ apply: 'desaturate', params: [10] }]).contrast(-0.05);
    const matte = new Jimp(w, h, '#2b2b2b');
    img.composite(matte, 0, 0, { mode: Jimp.BLEND_SOFTLIGHT, opacitySource: 0.15, opacityDest: 1 });
  } else if (style === 'noir') {
    img.greyscale().contrast(0.25);
  } else if (style === 'bw') {
    img.greyscale().contrast(0.18);
  }

  // Лёгкое зерно (если доступно)
  if (typeof img.noise === 'function') {
    img.noise(s.noise);
  } else {
    log('img.localFilter.warn', { reason: 'noise_not_supported_in_this_jimp' });
  }

  const out = await img.getBufferAsync(Jimp.MIME_PNG);
  log('img.localFilter.out', { size: out.length, style, strength });
  return out;
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
  await ctx.answerCbQuery().catch(()=>{});
  const offer = OFFERS.get(chatId);
  if (!offer || offer.hashId !== hashId) {
    log('ui.publish.stale', { chatId, hashId });
    await ctx.reply(
      'Эта карточка устарела. Нажмите «Начать» ещё раз.',
      Markup.inlineKeyboard([[Markup.button.callback('🚀 Начать', 'start_offer')]])
    );
    return;
  }
  await publishToChannel(ctx, offer.item, offer.keys);
});

bot.action('cancel', async (ctx) => {
  log('ui.action', { data: 'cancel', chat: ctx.chat?.id });
  await ctx.answerCbQuery().catch(()=>{});
  await offerNext(ctx);
});

// Показ следующей свежей записи
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

// Публикация: переписываем текст, правим фон/тон, гарантируем структурные отличия и отправляем
async function publishToChannel(ctx, item, keys) {
  log('publish.begin', { id: keys.id, source: item.source, link: item.link });
  try {
    // 1) Текст -> получаем новый заголовок + тело
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

      const converted = await toPngKeepSize(buf).catch(e => { log('img.toPngKeepSize.error', { error: e.message }); return null; });
      let finalBuf = null;

      if (converted && converted.png) {
        const { png, w, h } = converted;

        // OpenAI edits: 1024×1024
        const edited = await openaiEditBackground(png);

        // Базовый кандидат: edited если удалось, иначе оригинал PNG
        let candidate = edited || png;

        // Растягиваем квадрат до точных исходных W×H (без белых полей)
        let stretched = await stretchToOriginalSize(candidate, w, h).catch(e => {
          log('img.stretchToOriginal.error', { error: e.message });
          return candidate;
        });

        // Проверяем «заметность»; при слабом отличии — локальный фильтр
        try {
          const ratio = await diffRatio(png, stretched);
          const needLocal = IMG_ALWAYS_LOCAL_FILTER || (ratio < IMG_DIFF_THRESHOLD);
          log('img.diff.decision', { ratio: Number(ratio.toFixed(5)), threshold: IMG_DIFF_THRESHOLD, apply_local: needLocal });
          if (needLocal) {
            stretched = await applyLocalFilter(stretched, { style: IMG_STYLE, strength: IMG_FILTER_STRENGTH });
            log('img.localFilter.applied', { idx: i + 1 });
          }
        } catch (e) {
          log('img.diff.error', { error: e.message });
        }

        // Гарантируем структурное отличие по dHash
        let structural = stretched;
        try {
          if (IMG_ENSURE_STRUCT) structural = await ensureStructDiff(png, stretched, w, h);
        } catch (e) { log('img.struct.error', { error: e.message }); }

        finalBuf = structural;
        log('publish.image.use.stretched', { idx: i + 1, size: finalBuf.length, target_w: w, target_h: h });
      } else {
        finalBuf = buf;
        log('publish.image.use.original_noresize', { idx: i + 1, size: buf.length });
      }

      mediaGroup.push({
        type: 'photo',
        media: { source: finalBuf, filename: `photo_${i + 1}.png` } // соответствует PNG-контенту
      });
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
    await ctx.reply('✅ Опубликовано в канале.');
    log('publish.ok', { id: keys.id });

    // 6) Следующая карточка
    await offerNext(ctx);
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
  if (cap.length > 1000) {
    log('caption.truncate', { from: cap.length, to: 1000 });
  }
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
    log('bot.launch.ok', { feeds: FEED_URLS.length, store: STORE_PATH, log: LOG_PATH });

    // Проверим доступ к каналу один раз при старте
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
