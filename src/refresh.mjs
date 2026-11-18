/**
 * GitHub Actions 新聞中轉：抓 RSS → 去重／配額過濾 → data/feed.json + status.json
 * 僅輸出標題、連結、短摘要與來源；不含全文與金鑰。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SOURCES_PATH = join(ROOT, 'sources.json');
const OUT_PATH = join(ROOT, 'data', 'feed.json');
const STATUS_PATH = join(ROOT, 'data', 'status.json');

const CONCURRENCY = 8;
const SOFT_CONCURRENCY = 2;
const GNEWS_CONCURRENCY = 2;
const PER_SOURCE_TIMEOUT_MS = 12_000;
const PER_SOURCE_MAX = 12;
const HARD_AGE_HOURS = 48;
const TARGET_TOTAL = 200;
const SUMMARY_MAX = 280;
const QUOTAS = { hk: 70, world: 40, biz: 40, tech: 30, other: 20 };
const QUOTA_ORDER = ['hk', 'world', 'biz', 'tech', 'other'];

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function clip(text, max = SUMMARY_MAX) {
  const s = String(text || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return '';
  return s.length <= max ? s : s.slice(0, max);
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function httpsUrl(url) {
  let u = decodeEntities(String(url || '').trim());
  if (!u) return '';
  if (u.startsWith('//')) u = 'https:' + u;
  if (u.toLowerCase().startsWith('http://')) u = 'https://' + u.slice(7);
  return u;
}

function normalizeUrl(url) {
  let u = httpsUrl(url);
  if (!u) return '';
  u = u.replace(/#.*$/, '');
  try {
    const parsed = new URL(u);
    parsed.hash = '';
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_)/i.test(key)) parsed.searchParams.delete(key);
    }
    let out = parsed.toString();
    if (out.endsWith('/')) out = out.slice(0, -1);
    return out;
  } catch {
    return u.replace(/\/$/, '');
  }
}

function cleanTitle(title) {
  let t = String(title || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  t = t.replace(
    /\s+[-\u2013\u2014|｜]\s*(?:Yahoo(?:\s*(?:香港|財經|新聞|體育|科技))?|香港01|信報(?:網站)?|明報|經濟日報|端傳媒(?:Initium(?:\s*Media)?)?|中央社(?:\s*CNA)?|關鍵評論網|TNL(?:\s*The\s*News\s*Lens)?|eZone(?:\.hk)?|Hypebeast|SCMP|BBC(?:\s*News)?|TechCrunch|香港商报|體路(?:\s*Sportsroad)?)\s*$/iu,
    '',
  );
  const m = t.match(/^(.*)\s+[-\u2013\u2014]\s+([^\-\u2013\u2014]{2,28})$/u);
  if (m) {
    const tail = m[2].trim();
    if (
      /網站|新聞|Media|報|網|News|Daily|Times|Post/u.test(tail) ||
      (/^[\u4e00-\u9fffA-Za-z0-9 .·]{2,20}$/u.test(tail) && !/[：:？?]/.test(tail))
    ) {
      t = m[1].trim();
    }
  }
  return t.trim();
}

function unwrapGoogleNews(link, description = '') {
  const desc = String(description || '');
  const hrefRe = /href=["'](https?:\/\/[^"']+)["']/gi;
  let m;
  while ((m = hrefRe.exec(desc))) {
    const href = normalizeUrl(m[1].replace(/&amp;/g, '&'));
    if (!href) continue;
    try {
      const host = new URL(href).hostname.toLowerCase();
      if (!host || host.includes('google.') || host.includes('gstatic.')) continue;
      return href;
    } catch {
      continue;
    }
  }
  const n = normalizeUrl(link);
  if (n && !/news\.google\./i.test(n)) return n;
  return '';
}

function parseFeedDate(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const ts = Date.parse(s);
  if (!Number.isFinite(ts) || ts <= 0) return '';
  return new Date(ts).toISOString();
}

function tagText(xml, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = xml.match(re);
  if (!m) return '';
  return m[1]
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tagAttr(xml, tag, attr) {
  const re = new RegExp(`<${tag}[^>]*\\s${attr}=["']([^"']+)["'][^>]*/?>`, 'i');
  const m = xml.match(re);
  return m ? m[1].trim() : '';
}

function extractItems(xml) {
  const chunks = [];
  const itemRe = /<(?:item|entry)\b[\s\S]*?<\/(?:item|entry)>/gi;
  let m;
  while ((m = itemRe.exec(xml))) chunks.push(m[0]);
  return chunks;
}

function parseRssItem(chunk) {
  const title = cleanTitle(tagText(chunk, 'title'));
  let link = tagText(chunk, 'link') || tagAttr(chunk, 'link', 'href');
  if (!link) {
    const linkTag = chunk.match(/<link[^>]*>/i);
    if (linkTag) link = tagAttr(linkTag[0], 'link', 'href');
  }
  const descRaw =
    (chunk.match(/<description[\s\S]*?<\/description>/i) || [''])[0] ||
    (chunk.match(/<summary[\s\S]*?<\/summary>/i) || [''])[0] ||
    '';
  const summary = clip(tagText(chunk, 'description') || tagText(chunk, 'summary') || tagText(chunk, 'content'));
  let imageUrl = '';
  const enc = chunk.match(/<enclosure[^>]*>/i);
  if (enc) {
    const u = tagAttr(enc[0], 'enclosure', 'url');
    const type = tagAttr(enc[0], 'enclosure', 'type');
    if (u && (!type || /image/i.test(type) || /\.(jpe?g|png|gif|webp|avif)(\?|$)/i.test(u))) {
      imageUrl = httpsUrl(u);
    }
  }
  if (!imageUrl) {
    const media = chunk.match(/<(?:media:content|media:thumbnail)[^>]*>/i);
    if (media) {
      imageUrl = httpsUrl(
        tagAttr(media[0], 'media:content', 'url') || tagAttr(media[0], 'media:thumbnail', 'url'),
      );
    }
  }
  if (!imageUrl) {
    const img = descRaw.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (img && !/^data:/i.test(img[1])) imageUrl = httpsUrl(img[1]);
  }
  const publishedAt =
    parseFeedDate(tagText(chunk, 'pubDate')) ||
    parseFeedDate(tagText(chunk, 'updated')) ||
    parseFeedDate(tagText(chunk, 'published'));

  return { title, link: link.trim(), summary, imageUrl, publishedAt, descRaw };
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

function requestHeaders(url) {
  let referer = 'https://www.google.com/';
  try {
    const u = new URL(url);
    referer = `${u.protocol}//${u.host}/`;
  } catch {
    /* keep default */
  }
  return {
    'User-Agent': UA,
    Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.8, */*;q=0.5',
    'Accept-Language': 'zh-HK,zh-TW;q=0.9,zh;q=0.8,en-US;q=0.7,en;q=0.6',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    Referer: referer,
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'cross-site',
  };
}

async function fetchText(url, timeoutMs = PER_SOURCE_TIMEOUT_MS, retries = 2) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        redirect: 'follow',
        headers: requestHeaders(url),
      });
      if (res.status === 403 || res.status === 429 || res.status === 503) {
        lastErr = new Error(`HTTP ${res.status}`);
        await sleep(900 * (attempt + 1) + Math.floor(Math.random() * 500));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      lastErr = e;
      if (attempt < retries && /aborted|HTTP 403|HTTP 429|HTTP 503/i.test(String(e?.message || e))) {
        await sleep(700 * (attempt + 1));
        continue;
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error('fetch failed');
}

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length || 1) }, () => worker()));
  return out;
}

function categoryOf(source) {
  const c = String(source.category || '').toLowerCase();
  if (QUOTAS[c] != null) return c;
  const tags = Array.isArray(source.tags) ? source.tags : [];
  if (tags.includes('財經') || tags.includes('商業')) return 'biz';
  if (tags.includes('科技') || tags.includes('AI')) return 'tech';
  if (tags.includes('國際')) return 'world';
  if (tags.includes('香港') || tags.includes('本地')) return 'hk';
  return 'other';
}

function titleKey(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .slice(0, 80);
}

function makeId(sourceId, url) {
  const h = createHash('sha1').update(`${sourceId}|${url}`).digest('hex').slice(0, 16);
  return `r${h}`;
}

function candidateUrls(source) {
  const urls = [];
  const primary = String(source.url || '').trim();
  if (primary) urls.push(primary);
  const fallbacks = [];
  if (source.fallbackUrl) fallbacks.push(String(source.fallbackUrl).trim());
  if (Array.isArray(source.fallbackUrls)) {
    for (const u of source.fallbackUrls) fallbacks.push(String(u || '').trim());
  }
  for (const u of fallbacks) {
    if (u && !urls.includes(u)) urls.push(u);
  }
  return urls;
}

function parseItemsFromXml(source, xml) {
  const chunks = extractItems(xml);
  const items = [];
  const cutoff = Date.now() - HARD_AGE_HOURS * 3600 * 1000;
  let skippedGoogle = 0;
  for (const chunk of chunks) {
    if (items.length >= PER_SOURCE_MAX) break;
    const raw = parseRssItem(chunk);
    if (!raw.title) continue;
    let url = normalizeUrl(raw.link);
    if (/news\.google\./i.test(url || raw.link || '')) {
      url = unwrapGoogleNews(raw.link, raw.descRaw);
      if (!url) {
        skippedGoogle++;
        continue;
      }
    }
    if (!url || !/^https?:\/\//i.test(url)) continue;
    let publishedAt = raw.publishedAt;
    let ts = publishedAt ? Date.parse(publishedAt) : NaN;
    if (!Number.isFinite(ts)) {
      publishedAt = new Date().toISOString();
      ts = Date.now();
    }
    if (ts < cutoff) continue;
    items.push({
      id: makeId(source.id, url),
      sourceId: source.id,
      sourceName: source.name,
      title: raw.title,
      summary: raw.summary,
      url,
      imageUrl: raw.imageUrl || '',
      publishedAt,
      category: categoryOf(source),
      language: source.language || 'zh-Hant',
      trustScore: Number(source.trustScore) || 0.7,
      tags: Array.isArray(source.tags) ? source.tags : [],
      _ts: ts,
    });
  }
  return { items, skippedGoogle };
}

async function ingestSource(source) {
  const label = source.name || source.url;
  const urls = candidateUrls(source);
  const errors = [];
  let usedUrl = '';
  let usedFallback = false;

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    try {
      if (i > 0) await sleep(400 + Math.floor(Math.random() * 400));
      const xml = await fetchText(url);
      const { items, skippedGoogle } = parseItemsFromXml(source, xml);
      usedUrl = url;
      usedFallback = i > 0;
      if (items.length === 0 && /news\.google\./i.test(url)) {
        return {
          ok: true,
          label,
          items: [],
          error: null,
          warning: skippedGoogle > 0 ? `Google 新聞 0 則（解不出原文 ${skippedGoogle}）` : 'Google 新聞 0 則',
          usedUrl,
          usedFallback,
        };
      }
      return {
        ok: true,
        label,
        items,
        error: null,
        warning: usedFallback ? `改用備援源` : null,
        usedUrl,
        usedFallback,
      };
    } catch (e) {
      errors.push(`${url}: ${e?.message || String(e)}`);
    }
  }

  return {
    ok: false,
    label,
    items: [],
    error: errors.join(' | ') || '抓取失敗',
    warning: null,
    usedUrl: '',
    usedFallback: false,
  };
}

function filterToQuota(all) {
  all.sort((a, b) => b._ts - a._ts);
  const seenUrl = new Set();
  const seenTitle = new Set();
  const unique = [];
  for (const it of all) {
    const uk = it.url.toLowerCase();
    const tk = titleKey(it.title);
    if (seenUrl.has(uk)) continue;
    if (tk && seenTitle.has(tk)) continue;
    seenUrl.add(uk);
    if (tk) seenTitle.add(tk);
    unique.push(it);
  }

  const perSource = new Map();
  const capped = [];
  for (const it of unique) {
    const n = perSource.get(it.sourceId) || 0;
    if (n >= PER_SOURCE_MAX) continue;
    perSource.set(it.sourceId, n + 1);
    capped.push(it);
  }

  const byCat = { hk: [], world: [], biz: [], tech: [], other: [] };
  for (const it of capped) {
    const c = byCat[it.category] ? it.category : 'other';
    byCat[c].push(it);
  }

  const picked = [];
  const used = new Set();
  const takenByCat = { hk: 0, world: 0, biz: 0, tech: 0, other: 0 };

  for (const cat of QUOTA_ORDER) {
    const quota = QUOTAS[cat];
    for (const it of byCat[cat] || []) {
      if (takenByCat[cat] >= quota) break;
      if (used.has(it.id)) continue;
      picked.push(it);
      used.add(it.id);
      takenByCat[cat]++;
    }
  }

  // 名額不足：優先補「仍低於配額」的分類，避免 tech 長期超標
  while (picked.length < TARGET_TOTAL) {
    let added = false;
    const shortfall = QUOTA_ORDER
      .map((cat) => ({ cat, need: QUOTAS[cat] - takenByCat[cat] }))
      .filter((x) => x.need > 0)
      .sort((a, b) => b.need - a.need);

    for (const { cat } of shortfall) {
      for (const it of byCat[cat] || []) {
        if (picked.length >= TARGET_TOTAL) break;
        if (used.has(it.id)) continue;
        picked.push(it);
        used.add(it.id);
        takenByCat[cat]++;
        added = true;
        break;
      }
      if (added) break;
    }
    if (added) continue;

    // 各類已達配額或無稿：才用其餘較新稿補滿
    let filled = false;
    for (const it of capped) {
      if (picked.length >= TARGET_TOTAL) break;
      if (used.has(it.id)) continue;
      picked.push(it);
      used.add(it.id);
      takenByCat[it.category] = (takenByCat[it.category] || 0) + 1;
      filled = true;
      break;
    }
    if (!filled) break;
  }

  picked.sort((a, b) => b._ts - a._ts);
  return picked.slice(0, TARGET_TOTAL).map(({ _ts, trustScore, ...rest }) => rest);
}

function isGoogleSource(source) {
  // 只看主網址；fallbackUrl 常是 Google，不可把明報等算進 Google 佇列
  return /news\.google\./i.test(String(source.url || ''));
}

function isSoftBlocked(source) {
  if (source.softBlock) return true;
  return /mingpao\.com|hket\.com|hkej\.com/i.test(String(source.url || ''));
}

async function main() {
  const sources = JSON.parse(await readFile(SOURCES_PATH, 'utf8'));
  if (!Array.isArray(sources) || !sources.length) {
    throw new Error('sources.json 空白或格式錯誤');
  }

  const gSources = sources.filter((s) => isGoogleSource(s));
  const softSources = sources.filter((s) => !isGoogleSource(s) && isSoftBlocked(s));
  const otherSources = sources.filter((s) => !isGoogleSource(s) && !isSoftBlocked(s));

  console.log(`抓取 ${otherSources.length} 個一般來源（並發 ${CONCURRENCY}）…`);
  const otherResults = await mapPool(otherSources, CONCURRENCY, (src) => ingestSource(src));

  console.log(`抓取 ${softSources.length} 個易擋來源（並發 ${SOFT_CONCURRENCY}）…`);
  await sleep(400);
  const softResults = await mapPool(softSources, SOFT_CONCURRENCY, (src) => ingestSource(src));

  console.log(`抓取 ${gSources.length} 個 Google 新聞來源（並發 ${GNEWS_CONCURRENCY}）…`);
  await sleep(500);
  const gResults = await mapPool(gSources, GNEWS_CONCURRENCY, (src) => ingestSource(src));
  const results = [...otherResults, ...softResults, ...gResults];

  const errors = [];
  const warnings = [];
  const all = [];
  let okSources = 0;
  let failSources = 0;
  let fallbackUsed = 0;

  for (const r of results) {
    if (!r.ok) {
      failSources++;
      errors.push(`${r.label}: ${r.error}`);
      console.warn('FAIL', r.label, r.error);
      continue;
    }
    okSources++;
    if (r.usedFallback) fallbackUsed++;
    if (r.warning) {
      warnings.push(`${r.label}: ${r.warning}`);
      console.warn('WARN', r.label, r.warning);
    }
    console.log('OK', r.label, r.items.length, r.usedFallback ? '(fallback)' : '');
    all.push(...r.items);
  }

  const items = filterToQuota(all);
  const byCat = {};
  for (const it of items) byCat[it.category] = (byCat[it.category] || 0) + 1;
  const generatedAt = new Date().toISOString();

  const payload = {
    generatedAt,
    count: items.length,
    target: TARGET_TOTAL,
    categories: byCat,
    errors: errors.slice(0, 20),
    warnings: warnings.slice(0, 20),
    items,
  };

  const status = {
    generatedAt,
    count: items.length,
    target: TARGET_TOTAL,
    categories: byCat,
    sourcesTotal: sources.length,
    sourcesOk: okSources,
    sourcesFail: failSources,
    fallbackUsed,
    errors: errors.slice(0, 30),
    warnings: warnings.slice(0, 30),
  };

  await mkdir(dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  await writeFile(STATUS_PATH, JSON.stringify(status, null, 2) + '\n', 'utf8');
  console.log(`寫入 ${OUT_PATH}：${items.length} 則`, byCat);
  console.log(`寫入 ${STATUS_PATH}：ok=${okSources} fail=${failSources} fallback=${fallbackUsed}`);
  if (errors.length) console.warn(`來源失敗 ${errors.length} 個`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
