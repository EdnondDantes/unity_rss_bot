// fetcher-mtproto.js
// Node 16.20.2 + telegram@2.26.20
require('dotenv').config();
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');

let _client = null;
let _ready = null;

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

async function initMTProto() {
  if (_ready) return _ready;
  _ready = (async () => {
    const apiId = Number(process.env.TG_API_ID);
    const apiHash = process.env.TG_API_HASH;
    const session = new StringSession(process.env.TG_SESSION || '');
    if (!apiId || !apiHash || !process.env.TG_SESSION) {
      throw new Error('Нет TG_API_ID / TG_API_HASH / TG_SESSION в .env');
    }
    _client = new TelegramClient(session, apiId, apiHash, {
      connectionRetries: 5,
      useWSS: false,         // корректно для SOCKS/MTProxy
      proxy: buildProxy(),
      deviceModel: 'Node16.20.2',
      appVersion: '1.0.0',
      systemVersion: 'Linux/Windows/macOS'
    });
    await _client.connect();
    return _client;
  })();
  return _ready;
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

/**
 * Скачивает оригинальные медиа по ссылке t.me/<channel>/<id>.
 * Возвращает массив объектов:
 *  [{ buffer, filename, mime, type: 'photo'|'document'|'video' }]
 */
async function fetchMediaByLink(tmeLink, { includeVideo = true } = {}) {
  const client = await initMTProto();
  const parsed = parseTmeLink(tmeLink);
  if (!parsed) return [];

  const entity = await client.getEntity(parsed.username).catch(() => null);
  if (!entity) return [];

  // попытка тихо «вступить» в публичный канал (необязательно, но повышает шанс в некоторых случаях)
  try {
    await client.invoke(new Api.channels.JoinChannel({ channel: entity }));
  } catch (_) {}

  let [msg] = await client.getMessages(entity, { ids: [parsed.msgId] });
  if (!msg) return [];

  // если альбом — собираем все части альбома
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
    // photo (максимально доступный размер от Telegram)
    if (m.photo) {
      const buf = await client.downloadMedia(m, { workers: 2 });
      out.push({
        buffer: buf,
        filename: `photo_${parsed.username}_${m.id}.jpg`,
        mime: 'image/jpeg',
        type: 'photo'
      });
    }
    // изображение-документ (часто без сжатия)
    if (m.document && (m.document.mimeType || '').startsWith('image/')) {
      const mime = m.document.mimeType;
      const ext = extFromMime(mime);
      const buf = await client.downloadMedia(m, { workers: 2 });
      out.push({
        buffer: buf,
        filename: `image_${parsed.username}_${m.id}.${ext}`,
        mime,
        type: 'document'
      });
    }
    // видео (по желанию)
    if (includeVideo && m.video) {
      const buf = await client.downloadMedia(m, { workers: 2 });
      out.push({
        buffer: buf,
        filename: `video_${parsed.username}_${m.id}.mp4`,
        mime: 'video/mp4',
        type: 'video'
      });
    }
  }
  return out;
}

module.exports = { initMTProto, fetchMediaByLink };
