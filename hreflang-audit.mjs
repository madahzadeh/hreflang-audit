#!/usr/bin/env node
/**
 * hreflang-audit — zero-dependency CLI + GitHub Action for auditing hreflang
 * (international SEO) implementations.
 *
 * https://github.com/madahzadeh/hreflang-audit
 * License: MIT
 */

import { createServer } from "node:http";
import { readFileSync, realpathSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const VERSION = "1.0.3";

/* ------------------------------------------------------------------ */
/* Language / region data                                              */
/* ------------------------------------------------------------------ */

export const ISO_639_1 = new Set((
  "aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce " +
  "ch co cr cs cu cv cy da de dv dz ee el en eo es et eu fa ff fi fj fo fr " +
  "fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik io is " +
  "it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb lg li ln " +
  "lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv " +
  "ny oc oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk " +
  "sl sm sn so sq sr ss st su sv sw ta te tg th ti tk tl tn to tr ts tt tw " +
  "ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu"
).split(" "));

export const ISO_3166_1 = new Set((
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI " +
  "BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN " +
  "CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK " +
  "FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM " +
  "HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN " +
  "KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK " +
  "ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP " +
  "NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW " +
  "SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF " +
  "TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI " +
  "VN VU WF WS YE YT ZA ZM ZW"
).split(" "));

/**
 * Validate an hreflang value.
 * Returns { ok:true } or { ok:false, code:"E001"|"E002", reason }.
 */
export function validateHreflangCode(value) {
  const v = String(value ?? "").trim();
  if (v === "") return { ok: false, code: "E001", reason: "empty hreflang value" };
  if (/^x-default$/i.test(v)) return { ok: true, xdefault: true };
  if (v.includes("_")) {
    return {
      ok: false, code: "E002",
      reason: `"${v}" uses an underscore; hreflang requires hyphens (e.g. "${v.replace(/_/g, "-")}")`,
    };
  }
  const parts = v.split("-");
  const lang = parts[0].toLowerCase();
  if (!/^[a-z]{2}$/i.test(parts[0]) || !ISO_639_1.has(lang)) {
    return { ok: false, code: "E001", reason: `unknown language code "${parts[0]}" (must be ISO 639-1)` };
  }
  let i = 1;
  if (parts[i] && /^[a-z]{4}$/i.test(parts[i])) i += 1; // script subtag (ISO 15924 format)
  if (parts[i]) {
    const region = parts[i].toUpperCase();
    if (!/^[A-Z]{2}$/.test(region) || !ISO_3166_1.has(region)) {
      const hint = region === "UK" ? ' (did you mean "GB"?)' : "";
      return { ok: false, code: "E001", reason: `unknown region code "${parts[i]}" (must be ISO 3166-1 alpha-2)${hint}` };
    }
    i += 1;
  }
  if (parts[i]) {
    return { ok: false, code: "E001", reason: `unexpected subtag "${parts[i]}" in "${v}"` };
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* URL helpers                                                         */
/* ------------------------------------------------------------------ */

export function normalizeUrl(input, base) {
  try {
    const u = base ? new URL(input, base) : new URL(input);
    u.hash = "";
    u.hostname = u.hostname.toLowerCase();
    if ((u.protocol === "http:" && u.port === "80") || (u.protocol === "https:" && u.port === "443")) {
      u.port = "";
    }
    return u.href;
  } catch {
    return null;
  }
}

export function isAbsoluteHttp(href) {
  return /^https?:\/\//i.test(String(href ?? "").trim());
}

/* ------------------------------------------------------------------ */
/* HTML parsing (tolerant, regex-based)                                */
/* ------------------------------------------------------------------ */

export function parseAttrs(tag) {
  const attrs = {};
  const re = /([a-zA-Z][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m;
  while ((m = re.exec(tag)) !== null) {
    attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  }
  return attrs;
}

function relMatches(relValue, token) {
  return new RegExp(`(^|\\s)${token}(\\s|$)`, "i").test(relValue ?? "");
}

/**
 * Extract hreflang entries, canonical and base from an HTML document.
 * Returns { entries:[{lang, href, raw}], canonical, base }
 */
export function extractFromHtml(html, pageUrl) {
  const head = html; // scan the whole document; tolerant of malformed <head>
  let base = pageUrl;
  const baseTag = head.match(/<base\b[^>]*>/i);
  if (baseTag) {
    const a = parseAttrs(baseTag[0]);
    if (a.href) base = normalizeUrl(a.href, pageUrl) ?? pageUrl;
  }
  const entries = [];
  let canonical = null;
  for (const m of head.matchAll(/<link\b[^>]*>/gi)) {
    const a = parseAttrs(m[0]);
    if (relMatches(a.rel, "alternate") && a.hreflang !== undefined) {
      entries.push({ lang: a.hreflang.trim(), href: (a.href ?? "").trim(), raw: m[0] });
    } else if (relMatches(a.rel, "canonical") && a.href) {
      canonical = normalizeUrl(a.href, base);
    }
  }
  return { entries, canonical, base };
}

/** Parse an HTTP Link header for rel=alternate hreflang entries. */
export function parseLinkHeader(header) {
  const entries = [];
  if (!header) return entries;
  for (const part of String(header).split(/,(?=\s*<)/)) {
    const m = part.match(/<([^>]*)>\s*((?:;[^;]*)*)/);
    if (!m) continue;
    const params = {};
    for (const p of m[2].split(";")) {
      const kv = p.match(/\s*([\w-]+)\s*=\s*"?([^";]*)"?/);
      if (kv) params[kv[1].toLowerCase()] = kv[2].trim();
    }
    if (relMatches(params.rel, "alternate") && params.hreflang !== undefined) {
      entries.push({ lang: params.hreflang, href: m[1].trim(), raw: part.trim() });
    }
  }
  return entries;
}

export function extractAnchors(html, base) {
  const out = new Set();
  for (const m of html.matchAll(/<a\b[^>]*>/gi)) {
    const a = parseAttrs(m[0]);
    if (!a.href || a.href.startsWith("#") || /^(mailto|tel|javascript):/i.test(a.href)) continue;
    const u = normalizeUrl(a.href, base);
    if (u) out.add(u);
  }
  return [...out];
}

/* ------------------------------------------------------------------ */
/* Sitemap parsing                                                     */
/* ------------------------------------------------------------------ */

/**
 * Parse a sitemap or sitemap-index XML document.
 * Returns { sitemaps:[url], urls:[{ loc, alternates:[{lang, href}] }] }
 */
export function parseSitemapXml(xml) {
  const sitemaps = [];
  const urls = [];
  for (const sm of xml.matchAll(/<sitemap\b[^>]*>([\s\S]*?)<\/sitemap>/gi)) {
    const loc = sm[1].match(/<loc>\s*([\s\S]*?)\s*<\/loc>/i);
    if (loc) sitemaps.push(decodeXml(loc[1].trim()));
  }
  for (const u of xml.matchAll(/<url\b[^>]*>([\s\S]*?)<\/url>/gi)) {
    const block = u[1];
    const loc = block.match(/<loc>\s*([\s\S]*?)\s*<\/loc>/i);
    if (!loc) continue;
    const alternates = [];
    for (const l of block.matchAll(/<xhtml:link\b[^>]*>/gi)) {
      const a = parseAttrs(l[0]);
      if (relMatches(a.rel, "alternate") && a.hreflang !== undefined) {
        alternates.push({ lang: a.hreflang.trim(), href: decodeXml((a.href ?? "").trim()), raw: l[0] });
      }
    }
    urls.push({ loc: decodeXml(loc[1].trim()), alternates });
  }
  return { sitemaps, urls };
}

function decodeXml(s) {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'");
}

/* ------------------------------------------------------------------ */
/* Fetching                                                            */
/* ------------------------------------------------------------------ */

async function fetchPage(url, opts) {
  const page = { url, status: 0, finalUrl: url, redirected: false, entries: null, canonical: null, links: [], fetchError: null };
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(opts.timeout),
      headers: { "user-agent": opts.userAgent, accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
    });
    page.status = res.status;
    page.finalUrl = normalizeUrl(res.url) ?? url;
    page.redirected = res.redirected || page.finalUrl !== normalizeUrl(url);
    const headerEntries = parseLinkHeader(res.headers.get("link"));
    const ct = res.headers.get("content-type") ?? "";
    let entries = headerEntries;
    if (res.status < 400 && /html|xml/i.test(ct)) {
      const html = await res.text();
      const ex = extractFromHtml(html, page.finalUrl);
      entries = entries.concat(ex.entries);
      page.canonical = ex.canonical;
      page.base = ex.base;
      page.links = extractAnchors(html, ex.base);
    }
    page.entries = entries;
  } catch (e) {
    page.fetchError = e?.message ?? String(e);
  }
  return page;
}

async function pool(items, worker, size) {
  const results = [];
  let i = 0;
  const lanes = Array.from({ length: Math.max(1, size) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await worker(items[idx]);
    }
  });
  await Promise.all(lanes);
  return results;
}

/* ------------------------------------------------------------------ */
/* Audit engine                                                        */
/* ------------------------------------------------------------------ */

const CHECKS = {
  E001: { name: "invalid-code", severity: "error" },
  E002: { name: "underscore-locale", severity: "error" },
  E003: { name: "relative-href", severity: "error" },
  E004: { name: "missing-return-link", severity: "error" },
  E005: { name: "conflicting-entries", severity: "error" },
  E006: { name: "broken-target", severity: "error" },
  W101: { name: "missing-self-reference", severity: "warning" },
  W102: { name: "missing-x-default", severity: "warning" },
  W103: { name: "redirected-target", severity: "warning" },
  W104: { name: "canonical-mismatch", severity: "warning" },
  W105: { name: "duplicate-entries", severity: "warning" },
};

export async function audit(options) {
  const opts = {
    mode: "crawl", startUrl: null, sitemapUrl: null, urlList: null,
    maxPages: 200, concurrency: 5, timeout: 10_000,
    userAgent: `hreflang-audit/${VERSION} (+https://github.com/madahzadeh/hreflang-audit)`,
    ...options,
  };
  const findings = [];
  const add = (code, page, detail, hint) =>
    findings.push({ code, check: CHECKS[code].name, severity: CHECKS[code].severity, page, detail, hint });

  /** Map normalized URL -> page record ({entries:[{lang,href,raw}], canonical, status, ...}) */
  const pages = new Map();

  if (opts.mode === "sitemap") {
    // Collect entries from sitemap(s); no page fetching in this mode.
    const seen = new Set();
    const queue = [opts.sitemapUrl];
    let scannedSitemaps = 0;
    while (queue.length > 0 && scannedSitemaps < 50) {
      const smUrl = queue.shift();
      if (seen.has(smUrl)) continue;
      seen.add(smUrl);
      scannedSitemaps += 1;
      let xml;
      try {
        const res = await fetch(smUrl, {
          signal: AbortSignal.timeout(opts.timeout),
          headers: { "user-agent": opts.userAgent },
        });
        if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
        xml = await res.text();
      } catch (e) {
        throw new Error(`failed to fetch sitemap ${smUrl}: ${e?.message ?? e}`);
      }
      const parsed = parseSitemapXml(xml);
      for (const s of parsed.sitemaps) queue.push(s);
      for (const u of parsed.urls) {
        const loc = normalizeUrl(u.loc);
        if (!loc) continue;
        pages.set(loc, { url: loc, status: 200, finalUrl: loc, entries: u.alternates, canonical: null, fromSitemap: true });
      }
    }
  } else {
    // crawl or urls mode: fetch pages over HTTP.
    let initial;
    if (opts.mode === "urls") {
      initial = opts.urlList.map((u) => normalizeUrl(u)).filter(Boolean);
    } else {
      initial = [normalizeUrl(opts.startUrl)].filter(Boolean);
    }
    if (initial.length === 0) throw new Error("no valid start URL");
    const origin = new URL(initial[0]).origin;
    const queued = new Set(initial);
    let queue = [...initial];
    while (queue.length > 0 && pages.size < opts.maxPages) {
      const batch = queue.splice(0, Math.max(opts.concurrency, 1)).filter((u) => !pages.has(u)).slice(0, opts.maxPages - pages.size);
      const results = await pool(batch, (u) => fetchPage(u, opts), opts.concurrency);
      for (const page of results) {
        pages.set(normalizeUrl(page.url) ?? page.url, page);
        if (opts.mode === "crawl" && !page.fetchError) {
          for (const link of page.links) {
            if (new URL(link).origin === origin && !queued.has(link) && queued.size < opts.maxPages * 4) {
              queued.add(link);
              queue.push(link);
            }
          }
        }
      }
    }
    // Fetch hreflang targets that were not crawled (any origin), for return-link checks.
    const targets = new Set();
    for (const page of pages.values()) {
      for (const e of page.entries ?? []) {
        if (!isAbsoluteHttp(e.href)) continue;
        const t = normalizeUrl(e.href);
        if (t && !pages.has(t)) targets.add(t);
      }
    }
    const fetched = await pool([...targets], (u) => fetchPage(u, opts), opts.concurrency);
    for (const page of fetched) pages.set(normalizeUrl(page.url) ?? page.url, page);
  }

  /* ---------------- validation ---------------- */

  const auditedPages = [...pages.values()].filter((p) => (p.entries ?? []).length > 0 && !p.fetchError);
  const lookup = (url) => pages.get(normalizeUrl(url));

  for (const page of auditedPages) {
    const pageUrl = normalizeUrl(page.finalUrl ?? page.url) ?? page.url;
    const entries = page.entries;

    // Per-entry syntax checks
    const byLang = new Map(); // lang(lower) -> Set(resolved hrefs)
    const exactPairs = new Set();
    const resolvedHrefs = [];
    for (const e of entries) {
      const langKey = e.lang.toLowerCase();
      const check = validateHreflangCode(e.lang);
      if (!check.ok) {
        add(check.code, pageUrl, `hreflang="${e.lang}": ${check.reason}`,
          check.code === "E002"
            ? `use "${e.lang.replace(/_/g, "-")}" instead of "${e.lang}"`
            : "use ISO 639-1 language + optional ISO 15924 script + optional ISO 3166-1 alpha-2 region");
      }
      let resolved = null;
      if (!isAbsoluteHttp(e.href)) {
        add("E003", pageUrl, `hreflang="${e.lang}" href="${e.href}" is not an absolute URL`,
          `use an absolute URL, e.g. ${normalizeUrl(e.href, page.base ?? pageUrl) ?? "https://example.com/…"}`);
      } else {
        resolved = normalizeUrl(e.href);
      }
      if (resolved) {
        resolvedHrefs.push(resolved);
        const pairKey = `${langKey} ${resolved}`;
        if (exactPairs.has(pairKey)) {
          add("W105", pageUrl, `duplicate entry hreflang="${e.lang}" href="${e.href}"`, "remove the duplicated <link> element");
        }
        exactPairs.add(pairKey);
        if (!byLang.has(langKey)) byLang.set(langKey, new Set());
        byLang.get(langKey).add(resolved);
      }
    }

    // Conflicts: same hreflang value pointing to different URLs
    for (const [langKey, urls] of byLang) {
      if (urls.size > 1) {
        add("E005", pageUrl, `hreflang="${langKey}" points to ${urls.size} different URLs: ${[...urls].join(" , ")}`,
          "each language/region may map to exactly one URL per page");
      }
    }

    // Self-reference
    if (!resolvedHrefs.includes(pageUrl)) {
      add("W101", pageUrl, "the page does not reference itself in its hreflang set",
        `add <link rel="alternate" hreflang="…" href="${pageUrl}">`);
    }

    // x-default
    if (![...byLang.keys()].includes("x-default")) {
      add("W102", pageUrl, "no x-default entry in the hreflang set",
        "add an x-default entry pointing to your language-selector or primary page");
    }

    // Target checks
    for (const [langKey, urls] of byLang) {
      for (const targetUrl of urls) {
        if (targetUrl === pageUrl) continue;
        const target = lookup(targetUrl);
        if (!target) continue; // not fetched (sitemap mode covers via entries below)
        if (page.fromSitemap && target.fromSitemap) {
          // return-link check within sitemap data
          const back = (target.entries ?? []).some((e) => normalizeUrl(e.href) === pageUrl);
          if (!back) {
            add("E004", pageUrl, `${targetUrl} (hreflang="${langKey}") does not declare a return link to this page in the sitemap`,
              `add an xhtml:link alternate for ${pageUrl} on the <url> entry of ${targetUrl}`);
          }
          continue;
        }
        if (target.fetchError || target.status >= 400) {
          add("E006", pageUrl, `hreflang="${langKey}" target ${targetUrl} is broken (${target.fetchError ?? `HTTP ${target.status}`})`,
            "fix or remove the broken alternate URL");
          continue;
        }
        if (target.redirected) {
          add("W103", pageUrl, `hreflang="${langKey}" target ${targetUrl} redirects to ${target.finalUrl}`,
            `point hreflang directly at the final URL ${target.finalUrl}`);
        }
        const back = (target.entries ?? []).some((e) => isAbsoluteHttp(e.href) && normalizeUrl(e.href) === pageUrl);
        if (!back) {
          add("E004", pageUrl, `${targetUrl} (hreflang="${langKey}") does not link back to this page`,
            `add <link rel="alternate" hreflang="…" href="${pageUrl}"> on ${targetUrl}`);
        }
        if (target.canonical && target.canonical !== normalizeUrl(target.finalUrl)) {
          add("W104", pageUrl, `hreflang="${langKey}" target ${targetUrl} canonicalizes to ${target.canonical}`,
            "hreflang must point at canonical URLs; align the alternate with the target's canonical");
        }
      }
    }
  }

  const summary = {
    version: VERSION,
    mode: opts.mode,
    pagesScanned: pages.size,
    pagesWithHreflang: auditedPages.length,
    errors: findings.filter((f) => f.severity === "error").length,
    warnings: findings.filter((f) => f.severity === "warning").length,
  };
  return { summary, findings };
}

/* ------------------------------------------------------------------ */
/* Report formatting                                                   */
/* ------------------------------------------------------------------ */

const useColor = () => process.stdout.isTTY && !process.argv.includes("--no-color") && !process.env.NO_COLOR;
const paint = (code, s) => (useColor() ? `\x1b[${code}m${s}\x1b[0m` : s);
const red = (s) => paint(31, s); const yellow = (s) => paint(33, s);
const green = (s) => paint(32, s); const bold = (s) => paint(1, s); const dim = (s) => paint(2, s);

export function formatReport({ summary, findings }) {
  const lines = [];
  lines.push(bold(`hreflang-audit v${summary.version}`));
  lines.push("");
  const grouped = new Map();
  for (const f of findings) {
    if (!grouped.has(f.code)) grouped.set(f.code, []);
    grouped.get(f.code).push(f);
  }
  for (const code of Object.keys(CHECKS)) {
    const list = grouped.get(code);
    if (!list) continue;
    const color = CHECKS[code].severity === "error" ? red : yellow;
    lines.push(color(bold(`${code} ${CHECKS[code].name} (${list.length})`)));
    for (const f of list) {
      lines.push(`  ${color("•")} ${f.page}`);
      lines.push(`    ${f.detail}`);
      lines.push(dim(`    fix: ${f.hint}`));
    }
    lines.push("");
  }
  if (findings.length === 0) {
    lines.push(green("✓ No hreflang issues found."));
    lines.push("");
  }
  lines.push(bold("Summary"));
  lines.push(`  pages scanned: ${summary.pagesScanned}   pages with hreflang: ${summary.pagesWithHreflang}`);
  lines.push(`  ${red(`errors: ${summary.errors}`)}   ${yellow(`warnings: ${summary.warnings}`)}`);
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* Built-in demo fixture                                               */
/* ------------------------------------------------------------------ */

export function startFixtureServer() {
  const p = (title, head, body = "") =>
    `<!doctype html><html><head><title>${title}</title>${head}</head><body>${body}</body></html>`;
  const routes = (base) => ({
    "/en/": p("EN", `
      <link rel="alternate" hreflang="en" href="${base}/en/">
      <link rel="alternate" hreflang="fr" href="${base}/fr/">
      <link rel="alternate" hreflang="x-default" href="${base}/en/">
      <link rel="canonical" href="${base}/en/">`,
      `<a href="/de/">de</a> <a href="/es/">es</a> <a href="/it/">it</a> <a href="/canon/">canon</a> <a href="/redir/">redir</a>`),
    "/fr/": p("FR", `
      <link rel="alternate" hreflang="en" href="${base}/en/">
      <link rel="alternate" hreflang="fr" href="${base}/fr/">
      <link rel="alternate" hreflang="x-default" href="${base}/en/">
      <link rel="canonical" href="${base}/fr/">`),
    "/de/": p("DE", `
      <link rel="alternate" hreflang="de" href="${base}/de/">
      <link rel="alternate" hreflang="en" href="${base}/en/">`),
    "/es/": p("ES", `
      <link rel='alternate' hreflang='es_ES' href='${base}/es/'>
      <link rel="alternate" hreflang="en" href="foo/bar">`),
    "/it/": p("IT", `
      <link rel="alternate" hreflang="it" href="${base}/it/">
      <link rel="alternate" hreflang="en" href="${base}/en/">
      <link rel="alternate" hreflang="en" href="${base}/fr/">
      <link rel="alternate" hreflang="pt" href="${base}/missing">`),
    "/canon/": p("CANON", `
      <link rel="alternate" hreflang="en" href="${base}/canon/">
      <link rel="alternate" hreflang="fr" href="${base}/canon-fr/">
      <link rel="canonical" href="${base}/canon/">`),
    "/canon-fr/": p("CANON-FR", `
      <link rel="alternate" hreflang="en" href="${base}/canon/">
      <link rel="alternate" hreflang="fr" href="${base}/canon-fr/">
      <link rel="canonical" href="${base}/canon-fr-v2/">`),
    "/canon-fr-v2/": p("CANON-FR-V2", ""),
    "/redir/": p("REDIR", `
      <link rel="alternate" hreflang="en" href="${base}/redir/">
      <link rel="alternate" hreflang="fr" href="${base}/redir-fr/">`),
  });
  const server = createServer((req, res) => {
    const base = `http://127.0.0.1:${server.address().port}`;
    const path = new URL(req.url, base).pathname;
    if (path === "/redir-fr/") {
      res.writeHead(302, { location: `${base}/fr/` });
      res.end();
      return;
    }
    const table = routes(base);
    if (table[path]) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(table[path]);
    } else {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

const USAGE = `hreflang-audit v${VERSION} — audit hreflang (international SEO) implementations

Usage:
  hreflang-audit <start-url> [options]        crawl a site and audit hreflang
  hreflang-audit --sitemap <sitemap-url>      audit hreflang declared in an XML sitemap
  hreflang-audit --urls <file> [options]      audit an explicit list of URLs (one per line)
  hreflang-audit --demo                       run the audit against a built-in offline demo site

Options:
  --max-pages <n>      max pages to crawl (default 200)
  --concurrency <n>    parallel requests (default 5)
  --timeout <ms>       per-request timeout (default 10000)
  --user-agent <ua>    custom User-Agent header
  --fail-on <level>    error | warning | none (default error) — controls the exit code
  --json               print a machine-readable JSON report
  --no-color           disable colored output

Exit codes:
  0  clean (no findings at/above the --fail-on level)
  1  findings at/above the --fail-on level
  2  usage or runtime error`;

function parseCliArgs(argv) {
  const opts = { positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => { i += 1; if (argv[i] === undefined) throw new Error(`missing value for ${a}`); return argv[i]; };
    switch (a) {
      case "--sitemap": opts.sitemapUrl = next(); break;
      case "--urls": opts.urlsFile = next(); break;
      case "--max-pages": opts.maxPages = Number(next()); break;
      case "--concurrency": opts.concurrency = Number(next()); break;
      case "--timeout": opts.timeout = Number(next()); break;
      case "--user-agent": opts.userAgent = next(); break;
      case "--fail-on": opts.failOn = next(); break;
      case "--json": opts.json = true; break;
      case "--no-color": break;
      case "--demo": opts.demo = true; break;
      case "--help": case "-h": opts.help = true; break;
      case "--version": case "-v": opts.showVersion = true; break;
      default:
        if (a.startsWith("-")) throw new Error(`unknown option ${a}`);
        opts.positional.push(a);
    }
  }
  return opts;
}

async function main() {
  let cli;
  try {
    cli = parseCliArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`error: ${e.message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (cli.help) { console.log(USAGE); process.exit(0); }
  if (cli.showVersion) { console.log(VERSION); process.exit(0); }

  const failOn = cli.failOn ?? "error";
  if (!["error", "warning", "none"].includes(failOn)) {
    console.error(`error: --fail-on must be error, warning, or none\n\n${USAGE}`);
    process.exit(2);
  }

  const printFooter = () => {
    if (!cli.json) console.error(`────────────────────────────────────────────────\nhreflang-audit v${VERSION} · github.com/madahzadeh`);
  };

  let options;
  let demoServer = null;
  if (cli.demo) {
    const { server, base } = await startFixtureServer();
    demoServer = server;
    console.error(dim(`demo: auditing built-in fixture site at ${base} (works offline)\n`));
    options = { mode: "crawl", startUrl: `${base}/en/` };
  } else if (cli.sitemapUrl) {
    options = { mode: "sitemap", sitemapUrl: cli.sitemapUrl };
  } else if (cli.urlsFile) {
    const list = readFileSync(cli.urlsFile, "utf8").split("\n").map((s) => s.trim()).filter(Boolean);
    options = { mode: "urls", urlList: list };
  } else if (cli.positional.length === 1) {
    options = { mode: "crawl", startUrl: cli.positional[0] };
  } else {
    console.error(USAGE);
    process.exit(2);
  }
  for (const k of ["maxPages", "concurrency", "timeout", "userAgent"]) {
    if (cli[k] !== undefined) options[k] = cli[k];
  }

  let report;
  try {
    report = await audit(options);
  } catch (e) {
    console.error(`error: ${e.message}`);
    if (demoServer) demoServer.close();
    printFooter();
    process.exit(2);
  }
  if (demoServer) demoServer.close();

  if (cli.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatReport(report));
  }

  printFooter();
  if (cli.demo || failOn === "none") process.exit(0);
  const { errors, warnings } = report.summary;
  const failing = failOn === "warning" ? errors + warnings : errors;
  process.exit(failing > 0 ? 1 : 0);
}

const isDirectRun = !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isDirectRun) {
  main();
}
