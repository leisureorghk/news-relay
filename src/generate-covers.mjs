/**
 * 為 feed.json 中無圖項目產生 AI 封面，寫入 data/covers/{id}.jpg + covers.json，
 * 並把 raw.githubusercontent.com URL 寫回 feed item.imageUrl。
 *
 * 省額度策略：
 *   - 只打 image-01（不先打 H3）
 *   - 整份 feed 無圖項；七類輪流、類內由新到舊
 *   - 每輪 COVER_MAX、每日 COVER_DAILY_MAX
 *   - 撞 quota 立刻停；落選封面檔刪除
 *
 * 環境變數：
 *   MINIMAX_API_KEY（必填）
 *   MINIMAX_BASE_URL / MINIMAX_REGION
 *   COVER_MAX（每輪，預設 12）
 *   COVER_POOL（候選池上限，預設 700）
 *   COVER_DAILY_MAX（每日上限，預設 72）
 */
import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const FEED_PATH = join(ROOT, 'data', 'feed.json');
const COVERS_DIR = join(ROOT, 'data', 'covers');
const COVERS_JSON = join(ROOT, 'data', 'covers.json');

const MAX = Math.max(1, Math.min(48, Number(process.env.COVER_MAX || 12)));
const POOL = Math.max(MAX, Math.min(700, Number(process.env.COVER_POOL || 700)));
const DAILY_MAX = Math.max(1, Math.min(120, Number(process.env.COVER_DAILY_MAX || 72)));
const CAT_ORDER = ['hk', 'world', 'biz', 'tech', 'sport', 'edu', 'other'];
const TIMEOUT_MS = 180_000;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function todayKeyHK() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Hong_Kong' }).format(new Date());
}

function rawBase() {
  const repo = process.env.GITHUB_REPOSITORY || 'leisureorghk/news-relay';
  const branch = process.env.COVER_BRANCH || process.env.GITHUB_REF_NAME || 'main';
  return `https://raw.githubusercontent.com/${repo}/${branch}/data/covers`;
}

function minimaxBases() {
  const explicit = (process.env.MINIMAX_BASE_URL || '').trim().replace(/\/$/, '').replace(/\/v1$/, '');
  if (explicit) return [explicit];
  const region = (process.env.MINIMAX_REGION || 'auto').toLowerCase();
  if (region === 'global' || region === 'io') return ['https://api.minimax.io'];
  if (region === 'cn' || region === 'china') return ['https://api.minimaxi.com', 'https://api.minimax.cn'];
  return ['https://api.minimaxi.com', 'https://api.minimax.cn', 'https://api.minimax.io'];
}

function sanitizePrompt(prompt) {
  let p = String(prompt || '')
    .replace(/\s+/g, ' ')
    .trim();
  p = p.replace(/[\u4e00-\u9fff]+/g, ' ');
  p = p.replace(
    /李家超|習近平|金正恩|特朗普|拜登|普京|Trump|Biden|Putin|Xi Jinping|Kim Jong|New Yorker|Guardian-style|Peanuts|Schulz|Disney|Pixar|Ghibli/gi,
    ' ',
  );
  return p.replace(/\s+/g, ' ').trim();
}

function themeHint(title, summary) {
  const t = `${title} ${summary}`.toLowerCase();
  const rules = [
    [/市場|債券|利率|經濟|fed|銀行|loan|stock|finance|bond/, 'financial news sketch: city skyline with soft chart ribbons without numbers'],
    [/tech|ai|晶片|半導體|iphone|芯片|雲端/, 'tech news sketch: hand-inked devices and soft circuit doodles'],
    [/體育|足球|籃球|賽|sport/, 'sports news sketch: stadium lights and silhouette runners'],
    [/天氣|颱風|氣候|地震/, 'weather sketch: dramatic sky over calm sea in watercolor'],
    [/健康|醫療|醫院|疫苗/, 'health sketch: soft medical blue washes, calm studio mood'],
    [/文化|電影|音樂|娛樂/, 'culture sketch: playful stage props and colorful pencil shapes'],
    [/外交|峰會|會晤|國際|貿易/, 'diplomacy sketch: conference hall silhouette, soft flag-like color shapes only'],
    [/政府|施政|政策|香港|北京/, 'civic sketch: modern building silhouette at dusk, no people faces'],
  ];
  for (const [re, hint] of rules) if (re.test(t)) return hint;
  return 'general news sketch: hand-drawn editorial scene on paper, calm blue-grey washes';
}

function regionStyle(title, summary, sourceName = '') {
  const t = `${title} ${summary} ${sourceName}`.toLowerCase();
  const rules = [
    [/香港|hk\b|hong\s*kong|rthk|明報|scmp/, 'Hong Kong hand-drawn news sketch: ink and colored pencil urban journal'],
    [/日本|tokyo|japan/, 'Japanese travelogue illustration: colored pencil street diary, soft watercolor'],
    [/台灣|taiwan|taipei/, 'Taiwan watercolor map-and-street journal'],
    [/英國|london|bbc|\buk\b/, 'British editorial pen-and-wash: muted ink lines, rainy street atmosphere'],
    [/美國|new\s*york|washington|\busa\b/, 'American magazine editorial illustration: bold flat color blocks'],
  ];
  for (const [re, style] of rules) if (re.test(t)) return style;
  return 'International news travelogue: hand-drawn colored pencil and light watercolor on cream paper';
}

async function loadCovers() {
  try {
    const j = JSON.parse(await readFile(COVERS_JSON, 'utf8'));
    if (j && typeof j === 'object' && j.items && typeof j.items === 'object') return j;
  } catch {
    /* empty */
  }
  return { generatedAt: '', baseUrl: rawBase(), items: {}, dailyKey: '', dailyCount: 0 };
}

function ensureDailyBudget(covers) {
  const key = todayKeyHK();
  if (covers.dailyKey !== key) {
    covers.dailyKey = key;
    covers.dailyCount = 0;
  }
  covers.dailyCount = Number(covers.dailyCount) || 0;
  return key;
}

async function genImage(base, key, prompt, { optimizer = true } = {}) {
  const clean = sanitizePrompt(prompt).slice(0, 1400);
  if (!clean) return { error: 'empty_prompt' };

  const payload = {
    model: 'image-01',
    prompt: clean,
    aspect_ratio: '16:9',
    response_format: 'base64',
    n: 1,
    prompt_optimizer: Boolean(optimizer),
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/v1/image_generation`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'User-Agent': UA,
      },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    let j;
    try {
      j = JSON.parse(text);
    } catch {
      return { error: `http_${res.status}_bad_json` };
    }
    if (res.status === 402) return { error: 'quota_402', quota: true };
    const status = j?.base_resp?.status_code ?? 0;
    if (status !== 0) {
      const msg = j?.base_resp?.status_msg || `status_${status}`;
      const quota = /Token Plan|用量|quota|insufficient/i.test(msg);
      return { error: msg, quota };
    }
    let b64 = j?.data?.image_base64?.[0] || j?.data?.image_base64 || null;
    if (Array.isArray(b64)) b64 = b64[0];
    if (typeof b64 === 'string' && b64.includes('base64,')) b64 = b64.split('base64,').pop();
    if (typeof b64 === 'string' && b64.length > 200) {
      return { buf: Buffer.from(b64, 'base64'), model: 'image-01' };
    }
    const url = j?.data?.image_urls?.[0];
    if (url) {
      const img = await fetch(url, { signal: ctrl.signal });
      const ab = await img.arrayBuffer();
      if (ab.byteLength > 200) return { buf: Buffer.from(ab), model: 'image-01' };
    }
    return { error: 'empty_image' };
  } catch (e) {
    return { error: e?.message || String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/** 只走 image-01：主 prompt → 失敗再一層超短安全 prompt；quota 即停 */
async function genWithFallback(key, prompt) {
  const bases = minimaxBases();
  const safe =
    'Wide 16:9 hand-drawn watercolor news sketch on cream paper, soft grain. ' +
    'Calm abstract editorial still life on a desk: notebook, soft lamp, city window silhouette, no people faces, no text.';
  const attempts = [
    { prompt, optimizer: true },
    { prompt: safe, optimizer: true },
  ];
  let last = { error: 'no_attempt' };
  for (const att of attempts) {
    for (const base of bases) {
      const r = await genImage(base, key, att.prompt, att);
      if (r.buf) return r;
      last = r;
      if (r.quota) return r;
      if (/sensitive|nsfw|risk/i.test(String(r.error || ''))) break;
    }
  }
  return last;
}

async function main() {
  const key = (process.env.MINIMAX_API_KEY || '').trim().replace(/^Bearer\s+/i, '');
  if (!key) {
    console.error('缺少 MINIMAX_API_KEY，略過生圖');
    process.exit(0);
  }

  const feed = JSON.parse(await readFile(FEED_PATH, 'utf8'));
  const items = Array.isArray(feed.items) ? feed.items : [];
  const covers = await loadCovers();
  covers.baseUrl = rawBase();
  await mkdir(COVERS_DIR, { recursive: true });

  const day = ensureDailyBudget(covers);
  const dailyLeft = Math.max(0, DAILY_MAX - covers.dailyCount);
  if (dailyLeft <= 0) {
    console.log(`covers: daily cap reached (${covers.dailyCount}/${DAILY_MAX}) day=${day}`);
    covers.lastRun = {
      ok: 0,
      fail: 0,
      need: 0,
      tried: 0,
      quotaHit: false,
      dailySkipped: true,
      dailyCount: covers.dailyCount,
      dailyMax: DAILY_MAX,
    };
    covers.generatedAt = new Date().toISOString();
    await writeFile(COVERS_JSON, JSON.stringify(covers, null, 2) + '\n', 'utf8');
    process.exit(0);
  }

  // 回寫已有封面；只處理無圖項
  for (const it of items) {
    if (!it?.id) continue;
    if (!String(it.imageUrl || '').trim() && covers.items[it.id]?.url) {
      it.imageUrl = covers.items[it.id].url;
    }
  }

  const needAll = items.filter((it) => {
    if (!it?.id) return false;
    if (String(it.imageUrl || '').trim()) return false;
    if (covers.items[it.id]?.url) {
      it.imageUrl = covers.items[it.id].url;
      return false;
    }
    return true;
  });

  // 七類輪流、類內新到舊；再截到 POOL
  const byCat = Object.fromEntries(CAT_ORDER.map((c) => [c, []]));
  for (const it of needAll) {
    const c = CAT_ORDER.includes(it.category) ? it.category : 'other';
    byCat[c].push(it);
  }
  for (const c of CAT_ORDER) {
    byCat[c].sort((a, b) => {
      const ta = Date.parse(a.publishedAt || '') || 0;
      const tb = Date.parse(b.publishedAt || '') || 0;
      return tb - ta;
    });
  }
  const need = [];
  let depth = 0;
  let progressed = true;
  while (progressed && need.length < POOL) {
    progressed = false;
    for (const c of CAT_ORDER) {
      if (need.length >= POOL) break;
      if (depth < byCat[c].length) {
        need.push(byCat[c][depth]);
        progressed = true;
      }
    }
    depth++;
  }

  const roundMax = Math.min(MAX, dailyLeft);
  console.log(
    `covers: need=${need.length}/${needAll.length} pool=${POOL} max=${roundMax} daily=${covers.dailyCount}/${DAILY_MAX} base=${covers.baseUrl}`,
  );
  const batch = need.slice(0, roundMax);
  let ok = 0;
  let fail = 0;
  let quotaHit = false;

  for (const it of batch) {
    const title = String(it.title || '');
    const summary = String(it.summary || '');
    const style = regionStyle(title, summary, it.sourceName || '');
    const hint = themeHint(title, summary);
    const prefix =
      'Hand-drawn news SUMMARY illustration, wide 16:9 sketchbook, colored pencil and light watercolor on cream paper, soft grain. ' +
      'Not photoreal, not 3D CGI. ' +
      style +
      '. ' +
      'No watermark, no logo, no readable text, no letters, no real person faces, no national emblems. Scene: ';
    const visual = `${hint}. Story mood from headline context, clear storytelling objects.`;
    const result = await genWithFallback(key, prefix + visual);
    if (result.quota) {
      quotaHit = true;
      fail++;
      console.log(`QUOTA ${it.id} ${result.error}`);
      break;
    }
    if (!result.buf) {
      fail++;
      console.log(`FAIL ${it.id} ${result.error}`);
      await sleep(400);
      continue;
    }
    const file = `${it.id}.jpg`;
    await writeFile(join(COVERS_DIR, file), result.buf);
    const url = `${covers.baseUrl}/${file}`;
    covers.items[it.id] = {
      url,
      path: `data/covers/${file}`,
      sourceUrl: String(it.url || ''),
      title: title.slice(0, 120),
      createdAt: new Date().toISOString(),
      model: result.model || 'image-01',
      bytes: result.buf.length,
    };
    it.imageUrl = url;
    ok++;
    covers.dailyCount += 1;
    console.log(`OK ${it.id} ${result.buf.length}b model=${result.model || 'image-01'}`);
    if (covers.dailyCount >= DAILY_MAX) {
      console.log(`daily cap hit after OK (${covers.dailyCount}/${DAILY_MAX})`);
      break;
    }
    await sleep(500);
  }

  // 回寫已有封面到整份 feed
  for (const it of items) {
    if (!it?.id) continue;
    if (!String(it.imageUrl || '').trim() && covers.items[it.id]?.url) {
      it.imageUrl = covers.items[it.id].url;
    }
  }

  // 清掉不在目前 feed 的舊封面
  const live = new Set(items.map((it) => it?.id).filter(Boolean));
  const kept = {};
  for (const [id, row] of Object.entries(covers.items)) {
    if (live.has(id)) kept[id] = row;
  }
  covers.items = kept;
  try {
    const files = await readdir(COVERS_DIR);
    for (const f of files) {
      if (!f.endsWith('.jpg')) continue;
      const id = f.replace(/\.jpg$/i, '');
      if (!live.has(id)) await unlink(join(COVERS_DIR, f)).catch(() => {});
    }
  } catch {
    /* ignore */
  }

  covers.generatedAt = new Date().toISOString();
  covers.count = Object.keys(covers.items).length;
  covers.lastRun = {
    ok,
    fail,
    need: need.length,
    tried: batch.length,
    quotaHit,
    pool: POOL,
    dailyCount: covers.dailyCount,
    dailyMax: DAILY_MAX,
    dailyKey: covers.dailyKey,
  };

  await writeFile(COVERS_JSON, JSON.stringify(covers, null, 2) + '\n', 'utf8');
  await writeFile(FEED_PATH, JSON.stringify(feed, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify(covers.lastRun));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
