// UTAKOE server
// - public/ を配信
// - /api/identify : 歌声の文字起こし（＋任意で音声クリップ）から曲を特定し、曲の内容を要約して返す
// 管理用のキーはすべてここ（サーバー側）だけで扱い、利用者のブラウザには一切出しません。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- .env 読み込み（依存パッケージなし） ---
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

const PORT = Number(process.env.PORT || 3000);
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ENGINE_MODEL = process.env.ENGINE_MODEL || 'claude-sonnet-5-5';
const AUDD_API_TOKEN = process.env.AUDD_API_TOKEN || '';
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

// --- 簡易レート制限（IPごとに1分20回） ---
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < 60_000);
  arr.push(now); hits.set(ip, arr);
  return arr.length > 20;
}

// --- 同じ歌詞への重複問い合わせを避けるキャッシュ ---
const cache = new Map();
function cacheGet(k) { const v = cache.get(k); return v && Date.now() - v.t < 10 * 60_000 ? v.v : null; }
function cacheSet(k, v) { cache.set(k, { t: Date.now(), v }); if (cache.size > 500) cache.delete(cache.keys().next().value); }

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req, max = 6 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > max) { reject(new Error('too_large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ---------- 照合エンジン ----------
const UI_LANG = { ja: 'Japanese', en: 'English' };

async function askEngine(system, user, maxTokens = 700) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: ENGINE_MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
  });
  if (!r.ok) throw new Error('engine_' + r.status);
  const j = await r.json();
  const text = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  if (s < 0 || e < s) throw new Error('engine_parse');
  return JSON.parse(text.slice(s, e + 1));
}

const IDENTIFY_SYSTEM = (ui) => `You identify songs from a transcript of someone singing.
The transcript comes from automatic speech recognition of a singing voice, so expect misheard words, dropped particles, odd word boundaries, repeated lines and mixed languages.
Find the single most likely existing, published song. Consider well-known songs in every language (J-pop, anime songs, K-pop, Western pop, etc.).
Reply with JSON only, no prose:
{"match":boolean,"confidence":number 0-1,"title":"official title","artist":"main artist","album":"","year":"","language":"language of the song, written in ${UI_LANG[ui] || 'Japanese'}","summary":"2-3 sentences in ${UI_LANG[ui] || 'Japanese'} on what the song is about and its background","themes":["3-5 short theme words in ${UI_LANG[ui] || 'Japanese'}"]}
Rules: never quote or reproduce any of the song's lyrics. If the transcript is ordinary speech or you are not reasonably sure, set "match": false and "confidence" below 0.5.`;

const DESCRIBE_SYSTEM = (ui) => `You describe a known song. Reply with JSON only:
{"album":"","year":"","language":"language of the song, written in ${UI_LANG[ui] || 'Japanese'}","summary":"2-3 sentences in ${UI_LANG[ui] || 'Japanese'} on what the song is about and its background","themes":["3-5 short theme words in ${UI_LANG[ui] || 'Japanese'}"]}
Never quote or reproduce any lyrics.`;

async function identifyByAudio(b64, mime) {
  const fd = new FormData();
  fd.append('api_token', AUDD_API_TOKEN);
  fd.append('return', 'spotify,apple_music');
  fd.append('file', new Blob([Buffer.from(b64, 'base64')], { type: mime || 'audio/webm' }), 'clip.webm');
  const r = await fetch('https://api.audd.io/', { method: 'POST', body: fd });
  if (!r.ok) return null;
  const j = await r.json();
  const s = j && j.result;
  if (!s || !s.title) return null;
  return {
    match: true, confidence: 0.95, title: s.title, artist: s.artist || '', album: s.album || '',
    year: (s.release_date || '').slice(0, 4),
    links: { spotify: s.spotify?.external_urls?.spotify, apple: s.apple_music?.url },
  };
}

async function identify({ text, lang, ui, audio, mime }) {
  ui = ui === 'en' ? 'en' : 'ja';
  text = String(text || '').slice(0, 1500);

  // 1) 音声クリップで照合（設定がある場合）
  if (audio && AUDD_API_TOKEN) {
    try {
      const hit = await identifyByAudio(audio, mime);
      if (hit) {
        if (ANTHROPIC_API_KEY) {
          try {
            const d = await askEngine(DESCRIBE_SYSTEM(ui), `Song: "${hit.title}" by ${hit.artist}`, 400);
            Object.assign(hit, { album: hit.album || d.album, year: hit.year || d.year, language: d.language, summary: d.summary, themes: d.themes });
          } catch {}
        }
        return hit;
      }
    } catch {}
  }

  // 2) 歌詞の文字起こしで照合
  if (!ANTHROPIC_API_KEY || text.replace(/\s/g, '').length < 12) return { match: false };
  const key = ui + '|' + text;
  const c = cacheGet(key); if (c) return c;
  const out = await askEngine(IDENTIFY_SYSTEM(ui), `Recognition language: ${lang}\nTranscript:\n${text}`);
  const result = out && out.match ? {
    match: true, confidence: Number(out.confidence) || 0, title: String(out.title || ''), artist: String(out.artist || ''),
    album: String(out.album || ''), year: String(out.year || ''), language: String(out.language || ''),
    summary: String(out.summary || ''), themes: Array.isArray(out.themes) ? out.themes.map(String).slice(0, 5) : [],
  } : { match: false };
  cacheSet(key, result);
  return result;
}

// ---------- HTTP ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;

  if (url.pathname === '/api/config' && req.method === 'GET') {
    return send(res, 200, { text: !!ANTHROPIC_API_KEY, audio: !!AUDD_API_TOKEN });
  }

  if (url.pathname === '/api/identify' && req.method === 'POST') {
    if (limited(ip)) return send(res, 429, { match: false });
    try {
      const body = JSON.parse(await readBody(req));
      return send(res, 200, await identify(body));
    } catch (e) {
      return send(res, e.message === 'too_large' ? 413 : 200, { match: false });
    }
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method' });
  let p = decodeURIComponent(url.pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, 'Forbidden', 'text/plain');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found', 'text/plain');
    send(res, 200, data, MIME[path.extname(file)] || 'application/octet-stream');
  });
});

server.listen(PORT, () => console.log(`UTAKOE: http://localhost:${PORT}`));
