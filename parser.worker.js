// Web Worker: streams crypto.bib from GitHub raw and parses entries
// off the main thread. Posts {type:'progress'|'done'|'error'} messages.

const CRYPTO_BIB_URL =
  'https://raw.githubusercontent.com/cryptobib/export/master/crypto.bib';

// Approximate uncompressed size used for progress estimation when
// Content-Length is missing (raw.githubusercontent.com serves chunked).
const APPROX_TOTAL = 41_500_000;

self.onmessage = async (e) => {
  if (e.data && e.data.cmd === 'fetch') {
    try {
      await fetchAndParse();
    } catch (err) {
      self.postMessage({ type: 'error', message: String(err && err.message || err) });
    }
  }
};

async function fetchAndParse() {
  const res = await fetch(CRYPTO_BIB_URL, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching crypto.bib`);
  const etag = res.headers.get('ETag') || '';
  const lenHeader = res.headers.get('Content-Length');
  const total = lenHeader ? parseInt(lenHeader, 10) : APPROX_TOTAL;

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let received = 0;
  let text = '';
  let lastReport = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    text += decoder.decode(value, { stream: true });
    const now = Date.now();
    if (now - lastReport > 80) {
      self.postMessage({ type: 'progress', received, total });
      lastReport = now;
    }
  }
  text += decoder.decode();
  self.postMessage({ type: 'progress', received, total: Math.max(total, received) });
  self.postMessage({ type: 'parsing' });

  const bibDate = extractBibDate(text);
  const entries = parseAll(text);
  self.postMessage({ type: 'done', entries, etag, bibDate });
}

// Pulls the upstream release date out of the comment header:
//   %  Date:
//   %      2026-04-22
function extractBibDate(text) {
  const head = text.slice(0, 4096);
  const m = head.match(/%\s*Date:\s*\n\s*%\s*(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}

// --- Parser --------------------------------------------------------------
// Format-specific to cryptobib/export. Not a general BibTeX parser.

function parseAll(text) {
  const out = [];
  const re = /^@([A-Za-z]+)\s*\{/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    const start = m.index;
    let i = re.lastIndex;
    const type = m[1];

    // Cite key: read until ',' or '}' or whitespace
    while (i < text.length && /\s/.test(text[i])) i++;
    const keyStart = i;
    while (i < text.length && text[i] !== ',' && text[i] !== '}' && !/\s/.test(text[i])) i++;
    const key = text.slice(keyStart, i);
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text[i] === ',') i++;

    const fields = Object.create(null);
    while (i < text.length) {
      while (i < text.length && /\s/.test(text[i])) i++;
      if (text[i] === '}') { i++; break; }
      if (text[i] === undefined) break;

      // field name
      const ns = i;
      while (i < text.length && /[A-Za-z0-9_-]/.test(text[i])) i++;
      const name = text.slice(ns, i).toLowerCase();
      if (!name) { i++; continue; }
      while (i < text.length && /\s/.test(text[i])) i++;
      if (text[i] !== '=') break;
      i++;
      while (i < text.length && /\s/.test(text[i])) i++;

      let value = '';
      const c = text[i];
      if (c === '"') {
        i++;
        const vs = i;
        let depth = 0;
        while (i < text.length) {
          const ch = text[i];
          if (ch === '{') depth++;
          else if (ch === '}') depth--;
          else if (ch === '"' && depth === 0) break;
          i++;
        }
        value = text.slice(vs, i);
        if (text[i] === '"') i++;
      } else if (c === '{') {
        i++;
        const vs = i;
        let depth = 1;
        while (i < text.length) {
          const ch = text[i];
          if (ch === '{') depth++;
          else if (ch === '}') {
            depth--;
            if (depth === 0) break;
          }
          i++;
        }
        value = text.slice(vs, i);
        if (text[i] === '}') i++;
      } else {
        const vs = i;
        while (i < text.length && text[i] !== ',' && text[i] !== '}') i++;
        value = text.slice(vs, i).trim();
      }

      fields[name] = value;
      while (i < text.length && /\s/.test(text[i])) i++;
      if (text[i] === ',') i++;
    }

    const raw = text.slice(start, i);
    re.lastIndex = i;

    const colonIdx = key.indexOf(':');
    const venue = colonIdx >= 0 ? key.slice(0, colonIdx) : '';

    const author = fields.author
      ? fields.author.replace(/\s+/g, ' ').split(/\s+and\s+/).map(s => s.trim()).filter(Boolean)
      : [];

    let year = null;
    if (fields.year) {
      const ym = fields.year.match(/\d{4}/);
      if (ym) year = parseInt(ym[0], 10);
    }

    out.push({
      key,
      type,
      venue,
      author,
      title: fields.title || '',
      year,
      doi: fields.doi || '',
      url: fields.url || '',
      raw,
    });
  }
  return out;
}
