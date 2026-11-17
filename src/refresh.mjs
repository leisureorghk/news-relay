/**
 * GitHub Actions 新聞中轉：抓 RSS → 去重／配額過濾 → data/feed.json
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

const CONCURRENCY = 8;
const PER_SOURCE_TIMEOUT_MS = 12_000;
const PER_SOURCE_MAX = 12;
const HARD_AGE_HOURS = 48;
const TARGET_TOTAL = 200;
const SUMMARY_MAX = 280;
const QUOTAS = { hk: 70, world: 40, biz: 40, tech: 30, other: 20 };

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 NewsRelay/1.0';

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
    // 去掉常見追蹤參數
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
    if (media) imageUrl = httpsUrl(tagAttr(media[0], 'media:content', 'url') || tagAttr(media[0], 'media:thumbnail', 'url'));
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

async function fetchText(url, timeoutMs = PER_SOURCE_TIMEOUT_MS, retries = 2) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        redirect: 'follow',
        headers: {
          'User-Agent': UA,
          Accept: 'application/rss+xml, application/xml, text/xml, text/html, */*',
          'Accept-Language': 'zh-HK,zh-TW;q=0.9,zh;q=0.8,en;q=0.7',
        },
      });
      if (res.status === 429 || res.status === 503) {
        lastErr = new Error(`HTTP ${res.status}`);
        await sleep(800 * (attempt + 1) + Math.floor(Math.random() * 400));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      lastErr = e;
      if (attempt < retries && /aborted|HTTP 429|HTTP 503/i.test(String(e?.message || e))) {
        await sleep(600 * (attempt + 1));
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
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
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

async function ingestSource(source) {
  const label = source.name || source.url;
  try {
    const xml = await fetchText(source.url);
    const chunks = extractItems(xml);
    const items = [];
    const cutoff = Date.now() - HARD_AGE_HOURS * 3600 * 1000;
    for (const chunk of chunks) {
      if (items.length >= PER_SOURCE_MAX) break;
      const raw = parseRssItem(chunk);
      if (!raw.title) continue;
      let url = normalizeUrl(raw.link);
      if (/news\.google\./i.test(url || raw.link || '')) {
        url = unwrapGoogleNews(raw.link, raw.descRaw);
        if (!url) continue; // 解不出原文就捨棄
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
    return { ok: true, label, items, error: null };
  } catch (e) {
    return { ok: false, label, items: [], error: e?.message || String(e) };
  }
}

function filterToQuota(all) {
  // URL／標題去重（保留較新）
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

  // 每源最多 PER_SOURCE_MAX（已在抓取時限制，再保險一次）
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
  for (const [cat, quota] of Object.entries(QUOTAS)) {
    let take = 0;
    for (const it of byCat[cat] || []) {
      if (take >= quota) break;
      if (used.has(it.id)) continue;
      picked.push(it);
      used.add(it.id);
      take++;
    }
  }

  // 名額不足時用其餘較新稿補滿
  if (picked.length < TARGET_TOTAL) {
    for (const it of capped) {
      if (picked.length >= TARGET_TOTAL) break;
      if (used.has(it.id)) continue;
      picked.push(it);
      used.add(it.id);
    }
  }

  picked.sort((a, b) => b._ts - a._ts);
  return picked.slice(0, TARGET_TOTAL).map(({ _ts, trustScore, ...rest }) => rest);
}

async function main() {
  const sources = JSON.parse(await readFile(SOURCES_PATH, 'utf8'));
  if (!Array.isArray(sources) || !sources.length) {
    throw new Error('sources.json 空白或格式錯誤');
  }

  // Google 新聞易 429：其餘來源先並發，Google 源稍後以較低並發補抓
  const gSources = sources.filter((s) => /news\.google\./i.test(s.url || ''));
  const otherSources = sources.filter((s) => !/news\.google\./i.test(s.url || ''));
  console.log(`抓取 ${otherSources.length} 個一般來源（並發 ${CONCURRENCY}）…`);
  const otherResults = await mapPool(otherSources, CONCURRENCY, (src) => ingestSource(src));
  console.log(`抓取 ${gSources.length} 個 Google 新聞來源（並發 2）…`);
  await sleep(500);
  const gResults = await mapPool(gSources, 2, (src) => ingestSource(src));
  const results = [...otherResults, ...gResults];

  const errors = [];
  const all = [];
  for (const r of results) {
    if (!r.ok) {
      errors.push(`${r.label}: ${r.error}`);
      console.warn('FAIL', r.label, r.error);
    } else {
      console.log('OK', r.label, r.items.length);
      all.push(...r.items);
    }
  }

  const items = filterToQuota(all);
  const byCat = {};
  for (const it of items) byCat[it.category] = (byCat[it.category] || 0) + 1;

  const payload = {
    generatedAt: new Date().toISOString(),
    count: items.length,
    target: TARGET_TOTAL,
    categories: byCat,
    errors: errors.slice(0, 20),
    items,
  };

  await mkdir(dirname(OUT_PATH), { recursive: true });
  const text = JSON.stringify(payload, null, 2) + '\n';
  await writeFile(OUT_PATH, text, 'utf8');
  console.log(`寫入 ${OUT_PATH}：${items.length} 則`, byCat);
  if (errors.length) console.warn(`來源失敗 ${errors.length} 個`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
