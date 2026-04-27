# CryptoBib Search

A static, client-side-only search UI for [CryptoBib](https://cryptobib.di.ens.fr/).

`crypto.bib` (~41 MB) is fetched once from
[`cryptobib/export`](https://github.com/cryptobib/export) on GitHub, parsed in
a Web Worker, and cached as a parsed entry array in IndexedDB. On subsequent
visits the page revalidates against the upstream `ETag` and only re-downloads
when the bibliography has actually changed.

## Features

- Substring search across cite key, author, title, and year (with a
  case-sensitivity toggle — defaults to insensitive).
- Multi-token AND search (e.g. `bellare rogaway random oracle`).
- Venue filter chips and a year range filter.
- One-click `\cite{key}` to clipboard, plus a "Show BibTeX" expander
  with the raw entry verbatim.
- DOI and ePrint links rendered when the entry provides them.

## Running locally

`fetch` is blocked over `file://`, so use a local static server:

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

## Deploying to GitHub Pages

1. Push this directory to a GitHub repository.
2. In **Settings → Pages**, set the source to `main` / `/` (root).
3. The site is plain static files — no build step.
