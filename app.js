// CryptoBib client-side search.
// Loads parsed entries from IndexedDB, revalidates against
// raw.githubusercontent.com via ETag, and renders a search UI.

const CRYPTO_BIB_URL =
  'https://raw.githubusercontent.com/cryptobib/export/master/crypto.bib';

const DB_NAME = 'cryptobib';
const DB_VERSION = 1;
const STORE = 'cache';
const CACHE_KEY = 'crypto.bib';
const RESULT_PAGE = 200;

const $ = (id) => document.getElementById(id);
const statusMsg = $('status-msg');
const progressWrap = $('progress-wrap');
const progressFill = $('progress-fill');
const progressText = $('progress-text');
const controls = $('controls');
const results = $('results');
const resultMeta = $('result-meta');
const footer = $('footer');
const dataInfo = $('data-info');
const qInput = $('q');
const caseInput = $('case');
const yminInput = $('ymin');
const ymaxInput = $('ymax');
const venuesEl = $('venues');
const venueSummary = $('venue-summary');

let ENTRIES = [];
let VENUES_SELECTED = new Set();
let ALL_VENUES = [];
let SHOWN_LIMIT = RESULT_PAGE;

caseInput.checked = localStorage.getItem('cs') === '1';
caseInput.addEventListener('change', () => {
  localStorage.setItem('cs', caseInput.checked ? '1' : '0');
  rerender();
});

let searchT;
qInput.addEventListener('input', () => {
  clearTimeout(searchT);
  searchT = setTimeout(() => { SHOWN_LIMIT = RESULT_PAGE; rerender(); }, 120);
});
yminInput.addEventListener('change', () => { SHOWN_LIMIT = RESULT_PAGE; rerender(); });
ymaxInput.addEventListener('change', () => { SHOWN_LIMIT = RESULT_PAGE; rerender(); });
$('reset-filters').addEventListener('click', () => {
  qInput.value = '';
  VENUES_SELECTED.clear();
  document.querySelectorAll('.chip.on').forEach(el => el.classList.remove('on'));
  yminInput.value = yminInput.min;
  ymaxInput.value = ymaxInput.max;
  updateVenueSummary();
  SHOWN_LIMIT = RESULT_PAGE;
  rerender();
});

$('refresh').addEventListener('click', async (e) => {
  e.preventDefault();
  await idbDel();
  location.reload();
});

// --- IndexedDB -----------------------------------------------------------

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbGet() {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(CACHE_KEY);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}
async function idbPut(value) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, CACHE_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function idbDel() {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(CACHE_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// --- Boot ----------------------------------------------------------------

(async function main() {
  let cached = null;
  try { cached = await idbGet(); } catch (e) { /* ignore */ }

  let remoteEtag = null;
  try {
    const head = await fetch(CRYPTO_BIB_URL, { method: 'HEAD', cache: 'no-cache' });
    if (head.ok) remoteEtag = head.headers.get('ETag');
  } catch (e) { /* offline; fall through */ }

  if (cached && cached.entries && (!remoteEtag || cached.etag === remoteEtag)) {
    install(cached.entries, cached.etag, cached.fetchedAt);
    return;
  }

  if (cached && cached.entries) {
    install(cached.entries, cached.etag, cached.fetchedAt, /*staleNotice*/ true);
    refreshInBackground();
    return;
  }

  await downloadAndInstall();
})().catch(err => {
  statusMsg.textContent = 'Error: ' + (err && err.message || err);
});

async function refreshInBackground() {
  try { await downloadAndInstall(/*background*/ true); } catch (e) { /* keep cache */ }
}

function downloadAndInstall(background = false) {
  return new Promise((resolve, reject) => {
    if (!background) {
      statusMsg.textContent = 'Downloading crypto.bib (~41 MB)…';
      progressWrap.hidden = false;
    }
    const worker = new Worker('parser.worker.js');
    worker.onmessage = async (e) => {
      const m = e.data;
      if (m.type === 'progress') {
        if (background) return;
        const pct = Math.min(100, Math.round((m.received / m.total) * 100));
        progressFill.style.width = pct + '%';
        progressText.textContent =
          fmtBytes(m.received) + ' / ~' + fmtBytes(m.total) + ' (' + pct + '%)';
      } else if (m.type === 'parsing') {
        if (!background) {
          statusMsg.textContent = 'Parsing entries…';
          progressFill.style.width = '100%';
          progressText.textContent = '';
        }
      } else if (m.type === 'done') {
        const fetchedAt = Date.now();
        try {
          await idbPut({ etag: m.etag, fetchedAt, entries: m.entries });
        } catch (e) { /* storage may be full; still render */ }
        worker.terminate();
        install(m.entries, m.etag, fetchedAt);
        resolve();
      } else if (m.type === 'error') {
        worker.terminate();
        reject(new Error(m.message));
      }
    };
    worker.onerror = (e) => { worker.terminate(); reject(new Error(e.message || 'worker error')); };
    worker.postMessage({ cmd: 'fetch' });
  });
}

function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function install(entries, etag, fetchedAt, staleNotice = false) {
  ENTRIES = entries;
  $('status').hidden = true;
  controls.hidden = false;
  footer.hidden = false;

  ALL_VENUES = Array.from(new Set(entries.map(e => e.venue).filter(Boolean))).sort();
  renderVenues();

  const years = entries.map(e => e.year).filter(y => Number.isFinite(y));
  const ymin = Math.min(...years);
  const ymax = Math.max(...years);
  yminInput.min = ymin; yminInput.max = ymax; yminInput.placeholder = ymin; yminInput.value = ymin;
  ymaxInput.min = ymin; ymaxInput.max = ymax; ymaxInput.placeholder = ymax; ymaxInput.value = ymax;

  const shortEtag = (etag || '').replace(/"/g, '').slice(0, 12);
  const ago = fetchedAt ? relTime(fetchedAt) : 'just now';
  dataInfo.innerHTML =
    `${entries.length.toLocaleString()} entries${shortEtag ? ` &middot; etag <code>${shortEtag}</code>` : ''} &middot; fetched ${ago}` +
    (staleNotice ? ' (refreshing in background…)' : '');

  rerender();
  qInput.focus();
}

function relTime(ts) {
  const d = (Date.now() - ts) / 1000;
  if (d < 60) return 'just now';
  if (d < 3600) return Math.round(d / 60) + ' min ago';
  if (d < 86400) return Math.round(d / 3600) + ' h ago';
  return Math.round(d / 86400) + ' d ago';
}

// --- Venue chips ---------------------------------------------------------

function renderVenues() {
  venuesEl.innerHTML = '';
  for (const v of ALL_VENUES) {
    const el = document.createElement('span');
    el.className = 'chip';
    el.textContent = v;
    el.addEventListener('click', () => {
      if (VENUES_SELECTED.has(v)) { VENUES_SELECTED.delete(v); el.classList.remove('on'); }
      else { VENUES_SELECTED.add(v); el.classList.add('on'); }
      updateVenueSummary();
      SHOWN_LIMIT = RESULT_PAGE;
      rerender();
    });
    venuesEl.appendChild(el);
  }
  updateVenueSummary();
}
function updateVenueSummary() {
  venueSummary.textContent = VENUES_SELECTED.size
    ? `Venues: ${Array.from(VENUES_SELECTED).join(', ')}`
    : 'Venues: all';
}

// --- Search + render -----------------------------------------------------

function rerender() {
  const raw = qInput.value.trim();
  const cs = caseInput.checked;
  const tokens = raw ? (cs ? raw.split(/\s+/) : raw.toLowerCase().split(/\s+/)) : [];

  const ymin = parseInt(yminInput.value, 10);
  const ymax = parseInt(ymaxInput.value, 10);
  const venueFilter = VENUES_SELECTED.size ? VENUES_SELECTED : null;

  const matches = [];
  for (let i = 0; i < ENTRIES.length; i++) {
    const e = ENTRIES[i];
    if (venueFilter && !venueFilter.has(e.venue)) continue;
    if (Number.isFinite(e.year)) {
      if (Number.isFinite(ymin) && e.year < ymin) continue;
      if (Number.isFinite(ymax) && e.year > ymax) continue;
    }
    if (tokens.length) {
      const hay = cs
        ? (e.key + '\n' + e.author.join('\n') + '\n' + e.title + '\n' + (e.year || ''))
        : (e.key + '\n' + e.author.join('\n') + '\n' + e.title + '\n' + (e.year || '')).toLowerCase();
      let ok = true;
      for (const t of tokens) { if (hay.indexOf(t) < 0) { ok = false; break; } }
      if (!ok) continue;
    }
    matches.push(e);
  }

  resultMeta.textContent =
    `${matches.length.toLocaleString()} match${matches.length === 1 ? '' : 'es'}` +
    (matches.length > SHOWN_LIMIT ? ` (showing first ${SHOWN_LIMIT.toLocaleString()})` : '');

  results.innerHTML = '';
  const frag = document.createDocumentFragment();
  const limit = Math.min(matches.length, SHOWN_LIMIT);
  for (let i = 0; i < limit; i++) frag.appendChild(renderEntry(matches[i], tokens, cs));
  if (matches.length > SHOWN_LIMIT) {
    const btn = document.createElement('button');
    btn.id = 'show-more';
    btn.textContent = `Show ${Math.min(RESULT_PAGE, matches.length - SHOWN_LIMIT)} more`;
    btn.addEventListener('click', () => { SHOWN_LIMIT += RESULT_PAGE; rerender(); });
    frag.appendChild(btn);
  }
  results.appendChild(frag);
}

function renderEntry(e, tokens, cs) {
  const div = document.createElement('div');
  div.className = 'entry';

  const head = document.createElement('div');
  head.className = 'head';
  const keyEl = document.createElement('span');
  keyEl.className = 'key';
  keyEl.appendChild(highlight(e.key, tokens, cs));
  const meta = document.createElement('span');
  meta.className = 'meta';
  meta.innerHTML = (e.year ? e.year : '') +
    (e.venue ? ` <span class="venue">${escapeHtml(e.venue)}</span>` : '');
  head.appendChild(keyEl);
  head.appendChild(meta);

  const title = document.createElement('div');
  title.className = 'title';
  title.appendChild(highlight(stripBraces(e.title), tokens, cs));

  const authors = document.createElement('div');
  authors.className = 'authors';
  authors.appendChild(highlight(e.author.join(', '), tokens, cs));

  const actions = document.createElement('div');
  actions.className = 'actions';

  const cite = document.createElement('button');
  cite.type = 'button';
  cite.textContent = 'Copy \\cite';
  const copied = document.createElement('span');
  copied.className = 'copied';
  copied.hidden = true;
  cite.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText('\\cite{' + e.key + '}');
      copied.textContent = 'copied!';
      copied.hidden = false;
      setTimeout(() => { copied.hidden = true; }, 1200);
    } catch (err) {
      copied.textContent = 'copy failed';
      copied.hidden = false;
    }
  });
  actions.appendChild(cite);

  if (e.doi) {
    const a = document.createElement('a');
    a.className = 'btn';
    a.href = 'https://doi.org/' + e.doi;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = 'DOI';
    actions.appendChild(a);
  }
  if (e.url && /eprint\.iacr\.org/.test(e.url)) {
    const a = document.createElement('a');
    a.className = 'btn';
    a.href = e.url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = 'ePrint';
    actions.appendChild(a);
  } else if (e.url) {
    const a = document.createElement('a');
    a.className = 'btn';
    a.href = e.url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = 'URL';
    actions.appendChild(a);
  }

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.textContent = 'Show BibTeX';
  const pre = document.createElement('pre');
  pre.className = 'bib';
  pre.hidden = true;
  pre.textContent = e.raw;
  toggle.addEventListener('click', () => {
    pre.hidden = !pre.hidden;
    toggle.textContent = pre.hidden ? 'Show BibTeX' : 'Hide BibTeX';
  });
  actions.appendChild(toggle);
  actions.appendChild(copied);

  div.appendChild(head);
  div.appendChild(title);
  if (e.author.length) div.appendChild(authors);
  div.appendChild(actions);
  div.appendChild(pre);
  return div;
}

// Drop the {…} grouping braces LaTeX uses to protect capitalisation,
// purely for display. Entry.raw is left untouched.
function stripBraces(s) {
  return s.replace(/\{([^{}]*)\}/g, '$1');
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function highlight(text, tokens, cs) {
  const frag = document.createDocumentFragment();
  if (!tokens.length || !text) {
    frag.appendChild(document.createTextNode(text));
    return frag;
  }
  // Build a single regex that matches any token; longest first.
  const sorted = tokens.slice().sort((a, b) => b.length - a.length);
  const escaped = sorted.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp('(' + escaped.join('|') + ')', cs ? 'g' : 'gi');
  let lastIdx = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > lastIdx) frag.appendChild(document.createTextNode(text.slice(lastIdx, m.index)));
    const mark = document.createElement('mark');
    mark.textContent = m[0];
    frag.appendChild(mark);
    lastIdx = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex++;
  }
  if (lastIdx < text.length) frag.appendChild(document.createTextNode(text.slice(lastIdx)));
  return frag;
}
