(() => {
'use strict';
const $ = s => document.querySelector(s);

/* ---------- 表示文言 ---------- */
const T = {
  ja: {
    tagline:'あなたの歌声を、一語ずつ文字に。', recLang:'歌の言語',
    idleStage:'マイクを押して、歌うか話してください。声が一語ずつここに現れます。',
    start:'歌いはじめる', stop:'止める', listening:'聞いています', paused:'停止中',
    unsupported:'このブラウザは音声の文字化に対応していません。Chrome・Edge・Safari の最新版で開いてください。',
    denied:'マイクの使用が許可されていません。アドレスバーのマイクアイコンから許可してください。',
    thisSong:'この曲', songIdle:'曲がわかると、ここに曲名と内容が表示されます。',
    matching:'曲を照合しています', yourLyrics:'あなたが歌った歌詞', year:'発表',
    listen:'YouTubeで聴く', lyrics:'歌詞を見る',
    log:'記録', copy:'コピー', copied:'コピーしました', clear:'消去', auto:'自動（ブラウザ設定）'
  },
  en: {
    tagline:'Your singing, word by word.', recLang:'Language',
    idleStage:'Press the mic and sing or speak. Your words will appear here one at a time.',
    start:'Start singing', stop:'Stop', listening:'Listening', paused:'Stopped',
    unsupported:'This browser cannot turn speech into text. Open the page in a current version of Chrome, Edge or Safari.',
    denied:'Microphone access is blocked. Allow it from the mic icon in the address bar.',
    thisSong:'This song', songIdle:'Once the song is recognized, its title and details appear here.',
    matching:'Matching the song', yourLyrics:'Lyrics you sang', year:'Released',
    listen:'Listen on YouTube', lyrics:'View lyrics',
    log:'Transcript', copy:'Copy', copied:'Copied', clear:'Clear', auto:'Auto (browser)'
  }
};
const LANGS = [['auto',null],['ja-JP','日本語'],['en-US','English'],['ko-KR','한국어'],['zh-CN','中文（简体）'],['zh-TW','中文（繁體）'],['yue-Hant-HK','粵語'],['es-ES','Español'],['fr-FR','Français'],['de-DE','Deutsch'],['it-IT','Italiano'],['pt-BR','Português'],['ru-RU','Русский'],['id-ID','Bahasa Indonesia'],['th-TH','ไทย'],['vi-VN','Tiếng Việt'],['hi-IN','हिन्दी'],['tl-PH','Filipino'],['ar-SA','العربية']];

const store = {
  get(k){ try{ return localStorage.getItem(k); }catch{ return null; } },
  set(k,v){ try{ localStorage.setItem(k,v); }catch{} }
};
let ui = store.get('utakoe-ui') || ((navigator.language||'ja').startsWith('ja') ? 'ja' : 'en');
const t = k => T[ui][k] ?? k;

function applyText(){
  document.documentElement.lang = ui;
  document.querySelectorAll('[data-t]').forEach(el => el.textContent = t(el.dataset.t));
  $('#uiToggle').textContent = ui === 'ja' ? 'EN' : '日本語';
  $('#micLabel').textContent = listening ? t('stop') : t('start');
  $('#statusText').textContent = listening ? t('listening') : t('paused');
  const sel = $('#recLang'), cur = sel.value || store.get('utakoe-lang') || 'auto';
  sel.innerHTML = '';
  LANGS.forEach(([v,n]) => { const o = document.createElement('option'); o.value = v; o.textContent = n || t('auto'); sel.appendChild(o); });
  sel.value = cur;
  if (currentSong && songPhase === 'shown') renderSong(currentSong);
}
const recLang = () => { const v = $('#recLang').value; return v === 'auto' ? (navigator.language || 'ja-JP') : v; };

/* ---------- 状態 ---------- */
let listening = false, rec = null, stream = null, audioCtx = null, analyser = null, raf = 0;
let committed = [];               // 認識セッション内の各結果ごとに表示済みの語数
const queue = []; let lastRevealAt = 0, pumpTimer = null;
const words = [];                 // 表示済みの全単語
const logLines = [[]];            // 行ごとの単語
let currentLine = null;
const caret = document.createElement('span');
caret.className = 'thinking'; caret.innerHTML = '<i></i><i></i><i></i>';

/* ---------- 単語分割（日本語・中国語・タイ語にも対応） ---------- */
function segment(text, lang){
  if ('Segmenter' in Intl){
    try{
      const seg = new Intl.Segmenter(lang, {granularity:'word'});
      return [...seg.segment(text)].filter(s => s.isWordLike).map(s => s.segment);
    }catch{}
  }
  return text.split(/\s+/).filter(Boolean);
}
const NOSPACE = /[぀-ヿ㐀-鿿豈-﫿฀-๿가-힯ｦ-ﾟ]/;

/* ---------- 1秒置いてから一語ずつ表示 ---------- */
function enqueue(item){
  const now = performance.now();
  item.at = item.type === 'word' ? Math.max(now + 1000, lastRevealAt + 110) : lastRevealAt + 5;
  lastRevealAt = item.at;
  queue.push(item);
  showCaret(true);
  pump();
}
function pump(){
  if (pumpTimer) return;
  if (!queue.length){ showCaret(false); return; }
  pumpTimer = setTimeout(() => { pumpTimer = null; reveal(queue.shift()); pump(); },
    Math.max(0, queue[0].at - performance.now()));
}
function ensureLine(){
  if (!currentLine){
    $('#placeholder')?.remove();
    currentLine = document.createElement('div');
    currentLine.className = 'lyric-line';
    $('#lyrics').appendChild(currentLine);
    const lines = $('#lyrics').querySelectorAll('.lyric-line');
    if (lines.length > 7) lines[0].remove();
  }
  return currentLine;
}
function showCaret(on){
  if (on){ ensureLine().appendChild(caret); } else caret.remove();
}
function reveal(item){
  if (item.type === 'break'){
    if (currentLine && currentLine.querySelector('.w')){ currentLine = null; logLines.push([]); if (queue.length) showCaret(true); }
    renderLog(); return;
  }
  const line = ensureLine();
  const prev = logLines[logLines.length-1].at(-1);
  if (prev && !(NOSPACE.test(prev.at(-1)) || NOSPACE.test(item.text[0]))) line.insertBefore(document.createTextNode(' '), caret.parentNode === line ? caret : null);
  const span = document.createElement('span');
  span.className = 'w fresh'; span.textContent = item.text;
  line.insertBefore(span, caret.parentNode === line ? caret : null);
  setTimeout(() => span.classList.remove('fresh'), 900);
  words.push(item.text);
  logLines[logLines.length-1].push(item.text);
  renderLog();
  if (songPhase === 'shown') renderYourLyrics();
  maybeIdentify();
}
const joinWords = arr => arr.reduce((s,w,i) => s + (i && !(NOSPACE.test(arr[i-1].at(-1)) || NOSPACE.test(w[0])) ? ' ' : '') + w, '');
let logTimes = [];
function renderLog(){
  const box = $('#logBody'); box.innerHTML = '';
  logLines.forEach((ln, i) => {
    if (!ln.length) return;
    if (!logTimes[i]) logTimes[i] = new Date();
    const row = document.createElement('div');
    const ts = document.createElement('span'); ts.className = 'ts';
    ts.textContent = logTimes[i].toLocaleTimeString(ui === 'ja' ? 'ja-JP' : 'en-US', {hour:'2-digit',minute:'2-digit',second:'2-digit'});
    row.append(ts, document.createTextNode(joinWords(ln)));
    box.appendChild(row);
  });
  box.scrollTop = box.scrollHeight;
}

/* ---------- 音声認識 ---------- */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
function startRecognition(){
  rec = new SR();
  rec.lang = recLang(); rec.continuous = true; rec.interimResults = true; rec.maxAlternatives = 1;
  committed = [];
  rec.onresult = e => {
    for (let i = e.resultIndex; i < e.results.length; i++){
      const r = e.results[i];
      const toks = segment(r[0].transcript, rec.lang);
      const stable = r.isFinal ? toks.length : Math.max(0, toks.length - 2);
      const done = committed[i] || 0;
      for (let k = done; k < stable; k++) enqueue({type:'word', text:toks[k]});
      committed[i] = Math.max(done, stable);
      if (r.isFinal && !r._broke){ r._broke = true; enqueue({type:'break'}); }
    }
  };
  rec.onerror = e => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed'){ showMsg(t('denied')); stop(); }
  };
  rec.onend = () => { if (listening) setTimeout(() => { if (listening) startRecognition(); }, 200); };
  try{ rec.start(); }catch{}
}

/* ---------- 波形の可視化 ---------- */
function startScope(){
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const src = audioCtx.createMediaStreamSource(stream);
  analyser = audioCtx.createAnalyser(); analyser.fftSize = 2048;
  src.connect(analyser);
  const cv = $('#scope'), ctx = cv.getContext('2d');
  const data = new Uint8Array(analyser.fftSize);
  const draw = () => {
    const dpr = devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== w*dpr){ cv.width = w*dpr; cv.height = h*dpr; }
    ctx.setTransform(dpr,0,0,dpr,0,0); ctx.clearRect(0,0,w,h);
    analyser.getByteTimeDomainData(data);
    let sum = 0; for (const v of data){ const d = (v-128)/128; sum += d*d; }
    const lvl = Math.min(1, Math.sqrt(sum/data.length) * 4);
    $('#mic').style.setProperty('--lvl', (1 + lvl*0.35).toFixed(3));
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    ctx.strokeStyle = accent; ctx.lineWidth = 2; ctx.beginPath();
    const step = data.length / w;
    for (let x = 0; x < w; x++){ const v = (data[Math.floor(x*step)] - 128) / 128; const y = h/2 + v * h * 0.9; x ? ctx.lineTo(x,y) : ctx.moveTo(x,y); }
    ctx.stroke();
    raf = requestAnimationFrame(draw);
  };
  draw();
}
function idleScope(){
  const cv = $('#scope'), ctx = cv.getContext('2d'), dpr = devicePixelRatio || 1;
  cv.width = cv.clientWidth*dpr; cv.height = cv.clientHeight*dpr;
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--line').trim();
  ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(0, cv.clientHeight/2); ctx.lineTo(cv.clientWidth, cv.clientHeight/2); ctx.stroke();
}

/* ---------- 音声クリップ（曲照合用） ---------- */
let cfg = {text:false, audio:false}, lastClip = null, clipRec = null;
function startClips(){
  if (!cfg.audio || !window.MediaRecorder) return;
  const mime = ['audio/webm;codecs=opus','audio/webm','audio/mp4'].find(m => MediaRecorder.isTypeSupported?.(m));
  const loop = () => {
    if (!listening) return;
    const chunks = [];
    clipRec = new MediaRecorder(stream, mime ? {mimeType:mime} : undefined);
    clipRec.ondataavailable = e => e.data.size && chunks.push(e.data);
    clipRec.onstop = () => { if (chunks.length) lastClip = new Blob(chunks, {type:clipRec.mimeType}); loop(); };
    clipRec.start();
    setTimeout(() => clipRec && clipRec.state !== 'inactive' && clipRec.stop(), 9000);
  };
  loop();
}
const toB64 = blob => new Promise(res => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.readAsDataURL(blob); });

/* ---------- 曲の照合 ---------- */
let checking = false, lastCheckN = 0, lastCheckAt = 0, songPhase = 'idle', currentSong = null, currentKey = '', songFromLine = 0;
/* サーバーなしで動く照合：歌った言葉の中に曲名が含まれているかを、公開の楽曲カタログで調べる */
const norm = s => String(s || '').toLowerCase()
  .replace(/[\(\[（【].*?[\)\]）】]/g, '')
  .replace(/\s*[-–—~〜].*(remaster|version|ver\.|mix|edit|live|instrumental).*$/i, '')
  .normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '');
const countIn = (hay, needle) => { let c = 0, i = 0; while ((i = hay.indexOf(needle, i)) >= 0){ c++; i += needle.length; } return c; };
const CJK = /[぀-ヿ㐀-鿿가-힯฀-๿]/;
function catalogSearch(term, country){
  return new Promise(resolve => {
    const cb = 'uk' + Math.random().toString(36).slice(2);
    const s = document.createElement('script');
    const done = v => { clearTimeout(timer); delete window[cb]; s.remove(); resolve(v); };
    const timer = setTimeout(() => done([]), 8000);
    window[cb] = d => done((d && d.results) || []);
    s.onerror = () => done([]);
    s.src = `https://itunes.apple.com/search?term=${q(term)}&entity=song&limit=15&country=${country}&callback=${cb}`;
    document.head.appendChild(s);
  });
}
const searched = new Set();
async function identifyLocal(){
  const lang = recLang().toLowerCase();
  const country = lang.startsWith('ja') ? 'JP' : lang.startsWith('ko') ? 'KR' : lang.startsWith('zh-tw') ? 'TW' : lang.startsWith('zh') ? 'HK' : 'US';
  const all = norm(joinWords(words));
  const recent = words.slice(-24);
  // 繰り返し歌われたフレーズ（サビ）を優先して検索語を作る
  const cands = new Map();
  for (let n = 4; n >= 1; n--){
    for (let i = 0; i + n <= recent.length; i++){
      const phrase = joinWords(recent.slice(i, i + n));
      const key = norm(phrase);
      const minLen = CJK.test(key) ? 2 : 4;
      if (key.length < minLen || cands.has(key) || searched.has(country + key)) continue;
      const rep = countIn(all, key);
      cands.set(key, {phrase, score: rep * 3 + n + key.length / 6});
    }
  }
  const picks = [...cands.entries()].sort((a,b) => b[1].score - a[1].score).slice(0, 4);
  let best = null;
  for (const [key, c] of picks){
    searched.add(country + key);
    const results = await catalogSearch(c.phrase, country);
    results.forEach((r, idx) => {
      const tn = norm(r.trackName);
      if (!tn || tn.length < (CJK.test(tn) ? 2 : 3)) return;
      const occ = countIn(all, tn);
      if (!occ) return;
      const artistHit = norm(r.artistName) && all.includes(norm(r.artistName)) ? 0.15 : 0;
      const conf = Math.min(0.97, 0.45 + Math.min(occ, 4) * 0.08 + Math.min(tn.length, 12) * 0.02 + artistHit - idx * 0.01);
      if (!best || conf > best.confidence){
        best = {
          match: true, confidence: conf, title: r.trackName, artist: r.artistName, album: r.collectionName,
          year: (r.releaseDate || '').slice(0, 4), genre: r.primaryGenreName,
          artwork: r.artworkUrl100 ? r.artworkUrl100.replace('100x100', '300x300') : '',
          links: { apple: r.trackViewUrl }
        };
      }
    });
    if (best && best.confidence >= 0.8) break;
  }
  return best || {match: false};
}

async function maybeIdentify(){
  if (checking || songPhase === 'thinking') return;
  const now = Date.now();
  if (words.length - lastCheckN < 8 || now - lastCheckAt < 6000) return;
  checking = true; lastCheckN = words.length; lastCheckAt = now;
  try{
    let j;
    if (cfg.text || cfg.audio){
      const body = {text: joinWords(words.slice(-90)), lang: recLang(), ui};
      if (cfg.audio && lastClip){ body.audio = await toB64(lastClip); body.mime = lastClip.type; }
      const r = await fetch('api/identify', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body)});
      if (!r.ok) return;
      j = await r.json();
    } else {
      j = await identifyLocal();
    }
    if (j.match && j.confidence >= 0.6 && j.title){
      const key = (j.title + '|' + j.artist).toLowerCase();
      if (key !== currentKey) think(j, key);
    }
  }catch{} finally{ checking = false; }
}
function think(song, key){
  songPhase = 'thinking';
  const body = $('#songBody');
  body.innerHTML = `<div class="ring-wrap reveal"><svg class="ring" viewBox="0 0 54 54"><circle class="bgc" cx="27" cy="27" r="24"/><circle class="fg" cx="27" cy="27" r="24"/><text x="27" y="32" text-anchor="middle" id="cnt">5</text></svg><strong></strong></div>`;
  body.querySelector('strong').textContent = t('matching');
  requestAnimationFrame(() => body.querySelector('.ring').classList.add('go'));
  let n = 5;
  const iv = setInterval(() => { n--; const c = $('#cnt'); if (c) c.textContent = Math.max(n,0); }, 1000);
  setTimeout(() => {
    clearInterval(iv);
    currentSong = song; currentKey = key; songPhase = 'shown';
    songFromLine = Math.max(0, logLines.length - 4);
    renderSong(song);
  }, 5000);
}
const q = s => encodeURIComponent(s);
function link(href, label, cls){ const a = document.createElement('a'); a.href = href; a.target = '_blank'; a.rel = 'noopener'; a.textContent = label; if (cls) a.className = cls; return a; }
function renderSong(s){
  const body = $('#songBody'); body.innerHTML = '';
  const box = document.createElement('div'); box.className = 'reveal'; box.style.cssText = 'display:flex;flex-direction:column;gap:12px';
  const h = document.createElement('h2'); h.className = 'song-title'; h.textContent = s.title;
  const a = document.createElement('p'); a.className = 'song-artist'; a.textContent = s.artist || '';
  if (s.artwork){ const img = document.createElement('img'); img.src = s.artwork; img.alt = ''; img.width = 300; img.height = 300; img.style.cssText = 'width:100%;max-width:220px;height:auto;border-radius:10px'; box.append(img); }
  box.append(h, a);
  const metaBits = [s.year && `${t('year')} ${s.year}`, s.album, s.genre, s.language].filter(Boolean);
  if (metaBits.length){ const m = document.createElement('span'); m.className = 'meta'; m.textContent = metaBits.join(' · '); box.append(m); }
  if (s.summary){ const p = document.createElement('p'); p.className = 'summary'; p.textContent = s.summary; box.append(p); }
  if (s.themes?.length){ const tg = document.createElement('div'); tg.className = 'tags'; s.themes.slice(0,5).forEach(x => { const sp = document.createElement('span'); sp.textContent = x; tg.append(sp); }); box.append(tg); }
  const term = `${s.title} ${s.artist || ''}`.trim();
  const links = document.createElement('div'); links.className = 'links';
  links.append(
    link(s.links?.youtube || `https://www.youtube.com/results?search_query=${q(term)}`, t('listen'), 'primary'),
    link(s.links?.spotify || `https://open.spotify.com/search/${q(term)}`, 'Spotify'),
    link(s.links?.apple || `https://music.apple.com/search?term=${q(term)}`, 'Apple Music'),
    link(`https://www.google.com/search?q=${q(term + (ui === 'ja' ? ' 歌詞' : ' lyrics'))}`, t('lyrics')),
    link(`https://genius.com/search?q=${q(term)}`, 'Genius')
  );
  box.append(links);
  const yl = document.createElement('div'); yl.className = 'your-lyrics'; yl.id = 'yourLyrics';
  box.append(yl);
  body.append(box);
  renderYourLyrics();
}
function renderYourLyrics(){
  const yl = $('#yourLyrics'); if (!yl) return;
  yl.innerHTML = '';
  const e = document.createElement('span'); e.className = 'eyebrow'; e.textContent = t('yourLyrics'); yl.append(e);
  logLines.slice(songFromLine).filter(l => l.length).forEach(l => { const p = document.createElement('p'); p.textContent = joinWords(l); yl.append(p); });
  yl.scrollTop = yl.scrollHeight;
}

/* ---------- 開始・停止 ---------- */
function showMsg(m){ const el = $('#msg'); el.textContent = m; el.hidden = !m; }
async function start(){
  showMsg('');
  if (!SR){ showMsg(t('unsupported')); return; }
  try{ stream = await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true, noiseSuppression:false}}); }
  catch{ showMsg(t('denied')); return; }
  listening = true; setUI();
  startScope(); startRecognition(); startClips();
}
function stop(){
  listening = false; setUI();
  try{ rec && rec.stop(); }catch{}
  try{ clipRec && clipRec.state !== 'inactive' && clipRec.stop(); }catch{}
  stream?.getTracks().forEach(tr => tr.stop());
  cancelAnimationFrame(raf); audioCtx?.close(); audioCtx = null;
  $('#mic').style.setProperty('--lvl', 1); idleScope();
}
function setUI(){
  $('#mic').classList.toggle('on', listening);
  $('#mic').setAttribute('aria-label', listening ? t('stop') : t('start'));
  $('#status').classList.toggle('live', listening);
  $('#micLabel').textContent = listening ? t('stop') : t('start');
  $('#statusText').textContent = listening ? t('listening') : t('paused');
}

$('#mic').addEventListener('click', () => listening ? stop() : start());
$('#recLang').addEventListener('change', e => { store.set('utakoe-lang', e.target.value); if (listening){ try{ rec.stop(); }catch{} } });
$('#uiToggle').addEventListener('click', () => { ui = ui === 'ja' ? 'en' : 'ja'; store.set('utakoe-ui', ui); applyText(); setUI(); });
$('#copyBtn').addEventListener('click', async () => {
  const text = logLines.filter(l => l.length).map(joinWords).join('\n');
  try{ await navigator.clipboard.writeText(text); const b = $('#copyBtn'); b.textContent = t('copied'); setTimeout(() => b.textContent = t('copy'), 1500); }catch{}
});
$('#clearBtn').addEventListener('click', () => {
  words.length = 0; logLines.length = 0; logLines.push([]); logTimes = []; currentLine = null; queue.length = 0;
  lastCheckN = 0; currentKey = ''; currentSong = null; songPhase = 'idle';
  $('#lyrics').innerHTML = `<p class="placeholder" id="placeholder">${t('idleStage')}</p>`;
  $('#songBody').innerHTML = `<p class="song-idle">${t('songIdle')}</p>`;
  renderLog();
});

applyText(); setUI(); idleScope();
addEventListener('resize', () => { if (!listening) idleScope(); });
fetch('api/config').then(r => r.ok ? r.json() : null).then(c => { if (c) cfg = c; }).catch(() => {});
})();
