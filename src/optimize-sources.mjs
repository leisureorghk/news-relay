/**
 * 每月優化來源：探測 primary／fallback、評分、更新 sources.json 的 health／enabled／softBlock
 * 產出 data/optimize-report.json；不刪來源，只標記停用或建議備援。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SOURCES_PATH = join(ROOT, 'sources.json');
const REPORT_PATH = join(ROOT, 'data', 'optimize-report.json');
const HISTORY_PATH = join(ROOT, 'data', 'health-history.json');

const TIMEOUT_MS = 12_000;
const CONCURRENCY = 4;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function requestHeaders(url) {
  let referer = 'https://www.google.com/';
  try {
    const u = new URL(url);
    referer = `${u.protocol}//${u.host}/`;
  } catch {
    /* keep */
  }
  return {
    'User-Agent': UA,
    Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
    'Accept-Language': 'zh-HK,zh-TW;q=0.9,zh;q=0.8,en;q=0.7',
    Referer: referer,
  };
}

async function fetchText(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: requestHeaders(url),
    });
    const ms = Date.now() - t0;
    if (!res.ok) return { ok: false, status: res.status, ms, body: '', error: `HTTP ${res.status}` };
    const body = await res.text();
    return { ok: true, status: res.status, ms, body, error: null };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - t0, body: '', error: e?.message || String(e) };
  } finally {
    clearTimeout(timer);
  }
}

function countRssItems(xml) {
  if (!xml || typeof xml !== 'string') return 0;
  const m = xml.match(/<(?:item|entry)\b/gi);
  return m ? m.length : 0;
}

function unwrapableGoogleCount(xml) {
  if (!xml || !/news\.google\./i.test(xml.slice(0, 500)) && !/<item\b/i.test(xml)) {
    // still count items with non-google href in description
  }
  const chunks = xml.match(/<(?:item|entry)\b[\s\S]*?<\/(?:item|entry)>/gi) || [];
  let usable = 0;
  let raw = 0;
  for (const chunk of chunks) {
    raw++;
    const hrefs = [...chunk.matchAll(/href=["'](https?:\/\/[^"']+)["']/gi)].map((m) => m[1]);
    const good = hrefs.some((h) => {
      try {
        const host = new URL(h.replace(/&amp;/g, '&')).hostname.toLowerCase();
        return host && !host.includes('google.') && !host.includes('gstatic.');
      } catch {
        return false;
      }
    });
    if (good) usable++;
  }
  return { raw, usable };
}

function candidateUrls(source) {
  const urls = [];
  const primary = String(source.url || '').trim();
  if (primary) urls.push({ kind: 'primary', url: primary });
  const fb = [];
  if (source.fallbackUrl) fb.push(String(source.fallbackUrl).trim());
  if (Array.isArray(source.fallbackUrls)) {
    for (const u of source.fallbackUrls) fb.push(String(u || '').trim());
  }
  for (const u of fb) {
    if (u && !urls.some((x) => x.url === u)) urls.push({ kind: 'fallback', url: u });
  }
  return urls;
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
  await Promise.all(Array.from({ length: Math.min(limit, Math.max(1, items.length)) }, () => worker()));
  return out;
}

async function probeUrl(url) {
  const fetched = await fetchText(url);
  if (!fetched.ok) {
    return {
      ok: false,
      url,
      status: fetched.status,
      ms: fetched.ms,
      itemCount: 0,
      usableCount: 0,
      error: fetched.error,
      isGoogle: /news\.google\./i.test(url),
    };
  }
  const itemCount = countRssItems(fetched.body);
  const isGoogle = /news\.google\./i.test(url) || /news\.google\./i.test(fetched.body.slice(0, 800));
  let usableCount = itemCount;
  if (isGoogle) {
    const g = unwrapableGoogleCount(fetched.body);
    usableCount = g.usable;
  }
  return {
    ok: itemCount > 0,
    url,
    status: fetched.status,
    ms: fetched.ms,
    itemCount,
    usableCount,
    error: itemCount === 0 ? 'RSS 無 item' : null,
    isGoogle,
    emptyUnwrap: isGoogle && itemCount > 0 && usableCount === 0,
  };
}

/** Google News 有 item 即視為可用（refresh 會再解原文）；非 Google 以 itemCount 為準 */
function probeAvailable(p) {
  if (!p?.ok) return false;
  return (p.itemCount || 0) > 0;
}

function scoreProbe(primary, fallback) {
  // 0–100
  let score = 0;
  const notes = [];
  if (probeAvailable(primary)) {
    score += 55;
    if (primary.usableCount >= 5 || primary.itemCount >= 5) score += 15;
    if (primary.ms < 4000) score += 10;
    else if (primary.ms < 8000) score += 5;
    if (primary.emptyUnwrap) {
      score = Math.max(40, score - 10);
      notes.push('主源 Google 暫解不出原文連結');
    }
  } else if (primary && !primary.ok) {
    notes.push(`主源失敗：${primary.error || 'unknown'}`);
  }

  if (probeAvailable(fallback)) {
    score += probeAvailable(primary) ? 10 : 45;
    if (!probeAvailable(primary)) notes.push('僅備援可用');
    if (fallback.emptyUnwrap) notes.push('備援為 Google RSS（refresh 會解）');
  } else if (fallback && !fallback.ok) {
    notes.push(`備援失敗：${fallback.error || 'unknown'}`);
  }

  if (score > 100) score = 100;
  return { score, notes };
}

function optimizeSource(source, probes) {
  const primary = probes.find((p) => p.kind === 'primary')?.result || null;
  const fallback = probes.find((p) => p.kind === 'fallback')?.result || null;
  const { score, notes } = scoreProbe(primary, fallback);
  const next = { ...source };
  const prevEnabled = source.enabled !== false;
  const actions = [];

  next.health = {
    checkedAt: new Date().toISOString(),
    score,
    primaryOk: probeAvailable(primary),
    fallbackOk: probeAvailable(fallback),
    primaryMs: primary?.ms ?? null,
    primaryItems: primary?.itemCount ?? 0,
    primaryUsable: primary?.usableCount ?? 0,
    fallbackItems: fallback?.itemCount ?? 0,
    fallbackUsable: fallback?.usableCount ?? 0,
    notes: notes.slice(0, 5),
  };

  // 主源 403／失敗但備援可用 → softBlock
  if (!next.health.primaryOk && next.health.fallbackOk) {
    if (!next.softBlock) {
      next.softBlock = true;
      actions.push('標記 softBlock（主源不穩、備援可用）');
    }
  }

  // 主源與備援都不可用 → 停用（不刪）
  if (!next.health.primaryOk && !next.health.fallbackOk) {
    if (next.enabled !== false) {
      next.enabled = false;
      actions.push('停用來源（主／備皆不可用）');
    }
  } else if (next.enabled === false && (next.health.primaryOk || next.health.fallbackOk)) {
    next.enabled = true;
    actions.push('重新啟用來源（探測恢復）');
  }

  // 主源穩定且快（非 emptyUnwrap）→ 略增信任
  if (
    next.health.primaryOk &&
    !primary?.emptyUnwrap &&
    (primary?.ms ?? 99999) < 3000 &&
    (primary?.itemCount ?? 0) >= 8
  ) {
    const ts = Number(next.trustScore) || 0.7;
    if (ts < 0.92) {
      next.trustScore = Math.min(0.92, Math.round((ts + 0.01) * 100) / 100);
      if (next.trustScore !== ts) actions.push(`trustScore ${ts} → ${next.trustScore}（穩定）`);
    }
  } else if (primary?.emptyUnwrap && !next.health.fallbackOk) {
    // Google 主源解原文偏弱、又無備援 → 略降（不停用）
    const ts = Number(next.trustScore) || 0.7;
    if (ts > 0.55) {
      next.trustScore = Math.round((ts - 0.02) * 100) / 100;
      actions.push(`trustScore ${ts} → ${next.trustScore}（Google 解原文偏弱）`);
    }
  }

  return {
    source: next,
    report: {
      id: source.id,
      name: source.name,
      score,
      enabled: next.enabled !== false,
      wasEnabled: prevEnabled,
      softBlock: !!next.softBlock,
      actions,
      notes,
      primary: primary
        ? {
            ok: primary.ok,
            status: primary.status,
            ms: primary.ms,
            items: primary.itemCount,
            usable: primary.usableCount,
            error: primary.error,
          }
        : null,
      fallback: fallback
        ? {
            ok: fallback.ok,
            status: fallback.status,
            ms: fallback.ms,
            items: fallback.itemCount,
            usable: fallback.usableCount,
            error: fallback.error,
          }
        : null,
    },
  };
}

async function loadHistory() {
  try {
    const raw = await readFile(HISTORY_PATH, 'utf8');
    const j = JSON.parse(raw);
    return Array.isArray(j.runs) ? j : { runs: [] };
  } catch {
    return { runs: [] };
  }
}

async function main() {
  const sources = JSON.parse(await readFile(SOURCES_PATH, 'utf8'));
  if (!Array.isArray(sources) || !sources.length) throw new Error('sources.json 空白');

  console.log(`每月優化：探測 ${sources.length} 個來源…`);

  const results = await mapPool(sources, CONCURRENCY, async (source) => {
    const cands = candidateUrls(source);
    const probes = [];
    for (const c of cands) {
      if (probes.length) await sleep(300);
      console.log('PROBE', source.name, c.kind, c.url.slice(0, 70));
      const result = await probeUrl(c.url);
      probes.push({ kind: c.kind, result });
      console.log(
        ' ',
        result.ok ? 'OK' : 'FAIL',
        `items=${result.itemCount} usable=${result.usableCount} ${result.ms}ms`,
        result.error || '',
      );
    }
    return optimizeSource(source, probes);
  });

  const nextSources = results.map((r) => r.source);
  const reports = results.map((r) => r.report);
  const disabled = reports.filter((r) => !r.enabled).map((r) => r.id);
  const reenabled = reports.filter((r) => r.enabled && !r.wasEnabled).map((r) => r.id);
  const actions = reports.flatMap((r) => r.actions.map((a) => `${r.id}: ${a}`));

  const report = {
    generatedAt: new Date().toISOString(),
    sourcesTotal: sources.length,
    enabledCount: reports.filter((r) => r.enabled).length,
    disabledCount: disabled.length,
    disabledIds: disabled,
    reenabledIds: reenabled,
    actions,
    averageScore: Math.round(reports.reduce((s, r) => s + r.score, 0) / Math.max(1, reports.length)),
    sources: reports,
  };

  const history = await loadHistory();
  history.runs = [
    ...history.runs.slice(-23),
    {
      at: report.generatedAt,
      averageScore: report.averageScore,
      enabledCount: report.enabledCount,
      disabledCount: report.disabledCount,
      actions: actions.slice(0, 40),
    },
  ];
  history.updatedAt = report.generatedAt;

  await mkdir(dirname(REPORT_PATH), { recursive: true });
  await writeFile(SOURCES_PATH, JSON.stringify(nextSources, null, 2) + '\n', 'utf8');
  await writeFile(REPORT_PATH, JSON.stringify(report, null, 2) + '\n', 'utf8');
  await writeFile(HISTORY_PATH, JSON.stringify(history, null, 2) + '\n', 'utf8');

  console.log(
    `完成：enabled=${report.enabledCount} disabled=${report.disabledCount} avgScore=${report.averageScore}`,
  );
  if (actions.length) {
    console.log('變更：');
    for (const a of actions) console.log(' -', a);
  } else {
    console.log('來源無結構性變更（僅更新 health）');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
