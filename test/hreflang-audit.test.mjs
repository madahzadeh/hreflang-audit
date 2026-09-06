import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateHreflangCode, parseAttrs, extractFromHtml, parseLinkHeader,
  parseSitemapXml, normalizeUrl, audit, startFixtureServer,
} from "../hreflang-audit.mjs";

/* ---------------- unit: hreflang code validation ---------------- */

test("valid hreflang codes", () => {
  for (const v of ["en", "en-GB", "zh-Hans", "zh-Hant-TW", "x-default", "X-DEFAULT", "pt-BR", "fr-ca"]) {
    assert.equal(validateHreflangCode(v).ok, true, v);
  }
});

test("invalid hreflang codes", () => {
  assert.equal(validateHreflangCode("en_US").code, "E002");
  assert.equal(validateHreflangCode("english").code, "E001");
  assert.equal(validateHreflangCode("xx").code, "E001");
  assert.equal(validateHreflangCode("en-XX").code, "E001");
  const uk = validateHreflangCode("en-UK");
  assert.equal(uk.code, "E001");
  assert.match(uk.reason, /GB/);
  assert.equal(validateHreflangCode("en-GB-oops").code, "E001");
  assert.equal(validateHreflangCode("").code, "E001");
});

/* ---------------- unit: HTML parsing ---------------- */

test("parseAttrs handles quote styles and attribute order", () => {
  assert.deepEqual(
    parseAttrs(`<link href='/a' hreflang=en rel="alternate">`),
    { href: "/a", hreflang: "en", rel: "alternate" },
  );
});

test("extractFromHtml finds hreflang, canonical, and respects base", () => {
  const html = `<html><head>
    <base href="https://example.com/sub/">
    <link rel="alternate" hreflang="en" href="https://example.com/en/">
    <link hreflang="fr" href="https://example.com/fr/" rel="alternate">
    <link rel="canonical" href="page.html">
  </head></html>`;
  const { entries, canonical } = extractFromHtml(html, "https://example.com/x/");
  assert.equal(entries.length, 2);
  assert.equal(entries[1].lang, "fr");
  assert.equal(canonical, "https://example.com/sub/page.html");
});

test("parseLinkHeader extracts hreflang alternates", () => {
  const h = `<https://example.com/en/>; rel="alternate"; hreflang="en", <https://example.com/de/>; rel="alternate"; hreflang="de"`;
  const entries = parseLinkHeader(h);
  assert.deepEqual(entries.map((e) => [e.lang, e.href]), [
    ["en", "https://example.com/en/"],
    ["de", "https://example.com/de/"],
  ]);
});

test("normalizeUrl strips fragments and default ports", () => {
  assert.equal(normalizeUrl("HTTPS://Example.com:443/a#frag"), "https://example.com/a");
  assert.equal(normalizeUrl("foo/bar", "https://example.com/base/"), "https://example.com/base/foo/bar");
  assert.equal(normalizeUrl("::::"), null);
});

/* ---------------- unit: sitemap parsing ---------------- */

test("parseSitemapXml parses urlset with xhtml:link alternates", () => {
  const xml = `<?xml version="1.0"?><urlset>
    <url><loc>https://example.com/en/</loc>
      <xhtml:link rel="alternate" hreflang="en" href="https://example.com/en/"/>
      <xhtml:link rel="alternate" hreflang="de" href="https://example.com/de/"/>
    </url>
    <url><loc>https://example.com/de/</loc></url>
  </urlset>`;
  const parsed = parseSitemapXml(xml);
  assert.equal(parsed.urls.length, 2);
  assert.equal(parsed.urls[0].alternates.length, 2);
  assert.equal(parsed.urls[0].alternates[1].lang, "de");
});

test("parseSitemapXml parses a sitemap index", () => {
  const xml = `<sitemapindex>
    <sitemap><loc>https://example.com/a.xml</loc></sitemap>
    <sitemap><loc>https://example.com/b.xml</loc></sitemap>
  </sitemapindex>`;
  assert.deepEqual(parseSitemapXml(xml).sitemaps, ["https://example.com/a.xml", "https://example.com/b.xml"]);
});

/* ---------------- integration: full crawl of the fixture site ---------------- */

test("crawl audit produces the expected findings and no false positives", async () => {
  const { server, base } = await startFixtureServer();
  try {
    const { summary, findings } = await audit({ mode: "crawl", startUrl: `${base}/en/`, concurrency: 4 });

    const codesFor = (path) =>
      new Set(findings.filter((f) => f.page === `${base}${path}`).map((f) => f.code));

    // Correct cluster: zero findings
    assert.deepEqual(codesFor("/en/"), new Set(), "en must be clean");
    assert.deepEqual(codesFor("/fr/"), new Set(), "fr must be clean");

    // /de/ lists /en/, but /en/ does not link back; no x-default
    assert.deepEqual(codesFor("/de/"), new Set(["E004", "W102"]));

    // /es/ has underscore locale + relative href (+ no x-default)
    assert.deepEqual(codesFor("/es/"), new Set(["E002", "E003", "W102"]));

    // /it/ has conflicting en entries, a 404 target, missing return links, no x-default
    assert.deepEqual(codesFor("/it/"), new Set(["E005", "E006", "E004", "W102"]));

    // /canon/ points at a target whose canonical differs
    assert.deepEqual(codesFor("/canon/"), new Set(["W104", "W102"]));
    assert.deepEqual(codesFor("/canon-fr/"), new Set(["W102"]));

    // /redir/ points at a redirecting target whose final page lacks a return link
    assert.deepEqual(codesFor("/redir/"), new Set(["W103", "E004", "W102"]));

    assert.ok(summary.errors > 0 && summary.warnings > 0);
    assert.ok(summary.pagesScanned >= 8);
  } finally {
    server.close();
  }
});

/* ---------------- integration: sitemap mode ---------------- */

test("sitemap audit detects missing return links inside the sitemap", async () => {
  const { createServer } = await import("node:http");
  const xmlFor = (base) => `<?xml version="1.0"?><urlset>
    <url><loc>${base}/en/</loc>
      <xhtml:link rel="alternate" hreflang="en" href="${base}/en/"/>
      <xhtml:link rel="alternate" hreflang="de" href="${base}/de/"/>
      <xhtml:link rel="alternate" hreflang="x-default" href="${base}/en/"/>
    </url>
    <url><loc>${base}/de/</loc>
      <xhtml:link rel="alternate" hreflang="de" href="${base}/de/"/>
      <xhtml:link rel="alternate" hreflang="x-default" href="${base}/en/"/>
    </url>
  </urlset>`;
  const server = createServer((req, res) => {
    const base = `http://127.0.0.1:${server.address().port}`;
    res.writeHead(200, { "content-type": "application/xml" });
    res.end(xmlFor(base));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { findings } = await audit({ mode: "sitemap", sitemapUrl: `${base}/sitemap.xml` });
    const en = findings.filter((f) => f.page === `${base}/en/`).map((f) => f.code);
    // /en/ lists /de/, but /de/'s sitemap entry does not declare /en/... it declares x-default -> /en/ though.
    // x-default back-reference counts as a return link, so /en/ must be clean.
    assert.deepEqual(en, []);
    // /de/ misses its own self-reference? It has de -> /de/ (self ok). It lists x-default -> /en/,
    // and /en/ does declare /de/ back, so /de/ must be clean too.
    const de = findings.filter((f) => f.page === `${base}/de/`).map((f) => f.code);
    assert.deepEqual(de, []);
  } finally {
    server.close();
  }
});

test("CLI footer uses stderr for success and failure, stays plain, and is absent in JSON and usage output", async () => {
  const { createServer } = await import("node:http");
  const { spawn } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const { VERSION } = await import("../hreflang-audit.mjs");
  const entry = fileURLToPath(new URL("../hreflang-audit.mjs", import.meta.url));
  const good = "<html><head><title>Example</title></head><body>Hello</body></html>";
  const bad = "<link rel=\"alternate\" hreflang=\"en_US\" href=\"https://example.com/\">";
  const server = createServer((req, res) => {
    res.writeHead(req.url === "/missing" ? 404 : 200, { "content-type": "text/html; charset=utf-8" });
    res.end(req.url === "/good" ? good : bad);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const env = { ...process.env, FORCE_COLOR: "1" };
  delete env.NO_COLOR;
  const run = (args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], {
      env,
    });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  const footer = `────────────────────────────────────────────────\nhreflang-audit v${VERSION} · github.com/madahzadeh\n`;
  const argsFor = (path) => [`${base}/${path}`, "--max-pages", "1"];
  try {
    for (const [path, expectedCode] of [["good", 0], ["bad", 1]]) {
      for (const flags of [[], ["--no-color"], ["--fail-on", "none"]]) {
        const result = await run([...argsFor(path), ...flags]);
        assert.equal(result.code, flags.includes("none") ? 0 : expectedCode);
        assert.equal(result.stderr, footer);
        assert.ok(!result.stdout.includes(footer));
        assert.ok(!result.stderr.includes("\u001b"));
      }
      const json = await run([...argsFor(path), "--json"]);
      assert.equal(json.code, expectedCode);
      assert.equal(json.stderr, "");
      assert.ok(!json.stdout.includes("· github.com/madahzadeh"));
      assert.ok(JSON.parse(json.stdout).summary);
    }
    for (const args of [[], ["--unknown"], ["--fail-on", "invalid"]]) {
      const usage = await run(args);
      assert.equal(usage.code, 2);
      assert.ok(!(usage.stdout + usage.stderr).includes("· github.com/madahzadeh"));
    }

  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
