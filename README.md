# 新聞中轉（GitHub Actions／本機備援）

每 3 小時抓取 RSS、去重與分類配額過濾，寫入約 200 則滾動清單 `data/feed.json`，並寫 `data/status.json` 供排查。NAS 讀取後再做繁中標題／摘要／封面。

## 雙路徑

| 路徑 | 產出 | 角色 |
|------|------|------|
| GitHub Actions | `data/feed.json`（raw） | **主源** |
| Windows `NewsRelayRefresh` | `W:\news\relay\feed.json` | **備援**（港媒被擋時仍有稿） |

NAS `.news-minimax-env`：

```text
RELAY_FEED_URL=https://raw.githubusercontent.com/leisureorghk/news-relay/main/data/feed.json
# 可省略；預設 relay/feed.json
RELAY_FEED_FALLBACK=relay/feed.json
```

讀取順序：主源成功且未過期 → 用主源；否則試備源；再失敗才本機 RSS。

## 獨立公開倉庫

本目錄已推至 https://github.com/leisureorghk/news-relay （勿與含會員／金鑰的本站倉庫混在一起）。

NAS 讀取位址（勿用 jsDelivr，以免 CDN 快取拖過 3 小時）：

```text
https://raw.githubusercontent.com/leisureorghk/news-relay/main/data/feed.json
https://raw.githubusercontent.com/leisureorghk/news-relay/main/data/status.json
https://raw.githubusercontent.com/leisureorghk/news-relay/main/data/covers.json
```

## AI 封面（GitHub）

Actions：`Generate AI covers`（每 3 小時 :30，亦可手動）。  
**封面以 GitHub 為主**；NAS 應設 `MINIMAX_AUTO_COVERS=0`，只套用 raw URL／og 圖，避免雙重生圖燒額度。

省額度規則：

- 模型只打 **image-01**（不先打 H3）
- 只處理 feed **前 40 則**中的無圖項
- 每輪最多 **4** 張、每日最多 **16** 張
- 撞 Token Plan／quota 立刻停

產出：`data/covers/{id}.jpg` + `covers.json`，並把 raw URL 寫回 `imageUrl`。

GitHub repo **Secrets**（Settings → Secrets and variables → Actions）：

```text
MINIMAX_API_KEY=（必填，與 NAS 同一把即可）
MINIMAX_BASE_URL=https://api.minimaxi.com   # 可選
MINIMAX_REGION=cn                            # 可選
```

```bash
# 本機（需已設 MINIMAX_API_KEY）
npm run covers
# COVER_MAX=2 COVER_DAILY_MAX=16 npm run covers
```

NAS 同步：原文 og → GitHub `covers.json` →（本機 MiniMax 僅在 `AUTO_COVERS=1` 時備援）。

## 本機手動更新

```bash
node src/refresh.mjs
# 或
powershell -File ../scripts/refresh-relay-to-nas.ps1
```

需要 Node 18+（Actions 使用 22）。無額外 npm 依賴。

## 每月優化來源

Actions：`Monthly optimize sources`（每月 1 日 04:00 UTC，亦可手動）。

```bash
npm run optimize
# = node src/optimize-sources.mjs
```

會探測每個來源的主網址／備援，寫入：

- `sources.json`：`health`、必要時 `softBlock`／`enabled: false`／微調 `trustScore`（不刪來源）
- `data/optimize-report.json`：本次報告
- `data/health-history.json`：最近約 24 次紀錄

`refresh` 會自動略過 `enabled: false` 的來源。

## 輸出格式

- `data/feed.json`：標題、連結、短摘要、來源、時間、圖片網址；不含全文與金鑰。
- `data/status.json`：成功／失敗源數、分類則數、錯誤摘要。

明報等易 403 源設有 `fallbackUrl`（Google News site:…）；失敗會自動改備援。

## Synology

呼叫 `cron_sync.php` 建議比 Actions／本機中轉晚約 20 分鐘（例如 `40 */3 * * *`）。詳見 `nas-php/CRON.md`。
