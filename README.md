# hreflang-audit

[![CI](https://github.com/madahzadeh/hreflang-audit/actions/workflows/ci.yml/badge.svg)](https://github.com/madahzadeh/hreflang-audit/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/hreflang-audit)](https://www.npmjs.com/package/hreflang-audit)
[![Node.js 20+](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Zero dependencies](https://img.shields.io/badge/dependencies-0-lightgrey)](package.json)

Zero-dependency CLI + GitHub Action that audits your **hreflang** (international SEO) implementation the way a senior SEO consultant would: return links, invalid locale codes, canonical conflicts, broken alternates — with fix hints and CI-friendly exit codes.

![hreflang-audit demo](docs/demo.gif)


## Quick start

No install, no clone — just Node.js 20+:

```bash
npx hreflang-audit https://example.com/                          # crawl and audit
npx hreflang-audit --sitemap https://example.com/sitemap.xml     # audit from a sitemap
```

Prefer a global install? `npm i -g hreflang-audit`, then run `hreflang-audit <url>`.

<details>
<summary>Run from source instead</summary>

```bash
git clone https://github.com/madahzadeh/hreflang-audit.git
cd hreflang-audit
node hreflang-audit.mjs https://example.com/
npm run demo   # offline demo with seeded issues
npm test       # deterministic test suite
```
</details>

<details>
<summary>Example output</summary>

```
hreflang-audit v1.0.1

✓ No hreflang issues found.

Summary
  pages scanned: 57   pages with hreflang: 57
  errors: 0   warnings: 0
npm notice
npm notice New major version of npm available! 10.9.2 -> 12.0.2
npm notice Changelog: https://github.com/npm/cli/releases/tag/v12.0.2
npm notice To update run: npm install -g npm@12.0.2
npm notice
```

</details>

## What it checks

| Code | Check | Meaning |
|---|---|---|
| E001 | invalid-code | hreflang value is not a valid ISO 639-1 language (+ optional ISO 15924 script + ISO 3166-1 alpha-2 region), e.g. `en-UK` (hint: `en-GB`) |
| E002 | underscore-locale | `en_US` style — hreflang requires hyphens |
| E003 | relative-href | hreflang href must be an absolute URL |
| E004 | missing-return-link | page A lists B, but B does not link back to A |
| E005 | conflicting-entries | the same hreflang value points to two different URLs on one page |
| E006 | broken-target | alternate URL returns HTTP ≥ 400 or fails to load |
| W101 | missing-self-reference | the page does not include itself in its hreflang set |
| W102 | missing-x-default | the set has no `x-default` entry |
| W103 | redirected-target | alternate URL responds with a redirect |
| W104 | canonical-mismatch | the target page canonicalizes to a different URL |
| W105 | duplicate-entries | exact duplicate hreflang+href pairs on one page |

Annotations are read from HTML `<link rel="alternate" hreflang>`, HTTP `Link:` headers, and XML sitemaps (`xhtml:link`, sitemap-index supported).

## CLI options

| Option | Default | Description |
|---|---|---|
| `--sitemap <url>` | — | audit a sitemap instead of crawling |
| `--urls <file>` | — | audit an explicit list of URLs (one per line) |
| `--max-pages <n>` | 200 | crawl limit |
| `--concurrency <n>` | 5 | parallel requests |
| `--timeout <ms>` | 10000 | per-request timeout |
| `--user-agent <ua>` | `hreflang-audit/1.0` | custom User-Agent |
| `--fail-on <level>` | `error` | `error` \| `warning` \| `none` — controls exit code |
| `--json` | — | machine-readable JSON report |
| `--no-color` | — | disable colored output |

Exit codes: `0` clean · `1` findings at/above `--fail-on` · `2` usage/runtime error.

## GitHub Action

```yaml
name: hreflang
on:
  schedule:
    - cron: "0 6 * * 1"
  workflow_dispatch:

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: madahzadeh/hreflang-audit@v1
        with:
          url: https://example.com/
          max-pages: '300'
          fail-on: error
```

## JSON output

```json
{
  "summary": { "pagesScanned": 12, "pagesWithHreflang": 8, "errors": 4, "warnings": 3 },
  "findings": [
    {
      "code": "E004",
      "check": "missing-return-link",
      "severity": "error",
      "page": "https://example.com/de/",
      "detail": "https://example.com/en/ (hreflang=\"en\") does not link back to this page",
      "hint": "add <link rel=\"alternate\" hreflang=\"…\" href=\"https://example.com/de/\"> on https://example.com/en/"
    }
  ]
}
```

## Limitations

Honest scope: HTML is parsed with tolerant regexes, not a full DOM — pathological markup may be misread. JavaScript-rendered pages are not executed; audit the server-rendered HTML. This tool complements, but does not replace, Google Search Console's international targeting reports.

## Related tools

- [schema-audit](https://github.com/madahzadeh/schema-audit) — crawls a site and validates JSON-LD structured data for rich results
- [llms-txt-audit](https://github.com/madahzadeh/llms-txt-audit) — generates and validates `llms.txt` so AI answer engines can read and cite your site

## Hire me

I build AI automation, release workflows, mobile products, and technical-SEO-driven web systems for founders and international businesses.

- Upwork: [madahzadeh.com/upwork](https://madahzadeh.com/upwork)
- Portfolio and contact: [github.com/madahzadeh](https://github.com/madahzadeh) · [iequity.co](https://iequity.co)
