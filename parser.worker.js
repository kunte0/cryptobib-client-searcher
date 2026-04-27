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

// --- LaTeX → Unicode (display only) --------------------------------------
// Covers the diacritic and special-letter forms that actually appear in
// cryptobib author/title fields. entry.raw is left untouched, so the
// "Show BibTeX" view still shows the original encoding.

const LETTER = {
  ss:'ß', SS:'ẞ', o:'ø', O:'Ø', l:'ł', L:'Ł',
  aa:'å', AA:'Å', ae:'æ', AE:'Æ', oe:'œ', OE:'Œ',
  i:'ı', j:'ȷ', th:'þ', TH:'Þ', dh:'ð', DH:'Ð',
};
const ACCENT = {
  '"': { a:'ä', A:'Ä', e:'ë', E:'Ë', i:'ï', I:'Ï', o:'ö', O:'Ö', u:'ü', U:'Ü', y:'ÿ', Y:'Ÿ' },
  "'": { a:'á', A:'Á', e:'é', E:'É', i:'í', I:'Í', o:'ó', O:'Ó', u:'ú', U:'Ú', y:'ý', Y:'Ý',
         c:'ć', C:'Ć', n:'ń', N:'Ń', s:'ś', S:'Ś', z:'ź', Z:'Ź', l:'ĺ', L:'Ĺ', r:'ŕ', R:'Ŕ' },
  '`': { a:'à', A:'À', e:'è', E:'È', i:'ì', I:'Ì', o:'ò', O:'Ò', u:'ù', U:'Ù' },
  '^': { a:'â', A:'Â', e:'ê', E:'Ê', i:'î', I:'Î', o:'ô', O:'Ô', u:'û', U:'Û',
         c:'ĉ', C:'Ĉ', g:'ĝ', G:'Ĝ', h:'ĥ', H:'Ĥ', j:'ĵ', s:'ŝ', S:'Ŝ', w:'ŵ', W:'Ŵ', y:'ŷ', Y:'Ŷ' },
  '~': { a:'ã', A:'Ã', n:'ñ', N:'Ñ', o:'õ', O:'Õ' },
  '=': { a:'ā', e:'ē', i:'ī', o:'ō', u:'ū', A:'Ā', E:'Ē', I:'Ī', O:'Ō', U:'Ū' },
  '.': { c:'ċ', g:'ġ', z:'ż', e:'ė', E:'Ė' },
  c:   { c:'ç', C:'Ç', s:'ş', S:'Ş', t:'ţ', T:'Ţ' },
  v:   { c:'č', C:'Č', s:'š', S:'Š', z:'ž', Z:'Ž', n:'ň', N:'Ň', r:'ř', R:'Ř',
         t:'ť', T:'Ť', e:'ě', E:'Ě', l:'ľ', L:'Ľ', d:'ď', D:'Ď' },
  u:   { g:'ğ', G:'Ğ', a:'ă', A:'Ă' },
  H:   { o:'ő', O:'Ő', u:'ű', U:'Ű' },
  r:   { a:'å', A:'Å', u:'ů', U:'Ů' },
  k:   { a:'ą', A:'Ą', e:'ę', E:'Ę', i:'į', I:'Į' },
};

function decodeLatex(s) {
  if (!s) return s;
  if (s.indexOf('\\') < 0 && s.indexOf('{') < 0) return s;

  // Accent applied to a dotless letter, e.g. \"\i → ï
  s = s.replace(/\\(["'`^~=.])\\([ij])/g,
    (m, a, l) => (ACCENT[a] && ACCENT[a][l === 'i' ? 'i' : 'j']) || l);

  // {\<letter-form>}  e.g. {\ss}, {\o}, {\AE}
  s = s.replace(/\{\\([a-zA-Z]+)\}/g, (m, n) => LETTER[n] !== undefined ? LETTER[n] : m);

  // Symbol-accent commands. Two separate forms so the outer braces in
  // patterns like {\"o} are not consumed asymmetrically:
  //   \"{o}  → ö
  s = s.replace(/\\(["'`^~=.])\{([a-zA-Z])\}/g,
    (m, a, l) => (ACCENT[a] && ACCENT[a][l]) || l);
  //   \"o    → ö
  s = s.replace(/\\(["'`^~=.])([a-zA-Z])/g,
    (m, a, l) => (ACCENT[a] && ACCENT[a][l]) || l);

  // Letter-named accents: \c{c}, \v{S}, \u{a}, \H{o}, \r{a}, \k{a}
  s = s.replace(/\\([cvuHrk])\{([a-zA-Z])\}/g,
    (m, a, l) => (ACCENT[a] && ACCENT[a][l]) || l);
  // …and the whitespace-separator form: \c c
  s = s.replace(/\\([cvuHrk])\s+([a-zA-Z])(?=[\s,.;:!?}]|$)/g,
    (m, a, l) => (ACCENT[a] && ACCENT[a][l]) || l);

  // Standalone letter-form macros: \ss, \o, \aa, \i, \j (not in braces)
  s = s.replace(/\\(ss|SS|aa|AA|ae|AE|oe|OE|o|O|l|L|i|j|th|TH|dh|DH)(?![a-zA-Z])/g,
    (m, n) => LETTER[n]);

  // Escaped punctuation
  s = s.replace(/\\([&%#_$])/g, '$1');

  // Drop unknown formatting commands, keep their argument:
  //   \textsf{Glitter} → Glitter,  \emph{foo} → foo
  s = s.replace(/\\[a-zA-Z]+\*?\{([^{}]*)\}/g, '$1');

  // Strip remaining LaTeX capitalisation braces (innermost first)
  while (/\{[^{}]*\}/.test(s)) {
    s = s.replace(/\{([^{}]*)\}/g, '$1');
  }

  return s;
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
      ? fields.author.replace(/\s+/g, ' ').split(/\s+and\s+/)
          .map(s => decodeLatex(s.trim())).filter(Boolean)
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
      title: decodeLatex(fields.title || ''),
      year,
      doi: fields.doi || '',
      url: fields.url || '',
      raw,
    });
  }
  return out;
}
