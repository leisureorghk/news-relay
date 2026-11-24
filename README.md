# 新聞中轉（GitHub Actions）

每 **4 小時**抓取 RSS，去重後依七類各保留最新最多 **100** 則（合計最多 700），寫入 `data/feed.json` 與 `data/status.json`。NAS 只讀此清單，不再本機抓新聞 RSS、也不再讀 Windows 備援檔。

## 七類配額

| 類別 | id | 上限 |
|------|-----|------|
| 香港 | `hk` | 100 |
| 國際 | `world` | 100 |
| 財經 | `biz` | 100 |
| 科技 | `tech` | 100 |
| 體育 | `sport` | 100 |
| 教育 | `edu` | 100 |
| 其他 | `other` | 100 |

每類先取 **48 小時**內稿；不足再用**同分類 7 天內**補滿。**不跨類借稿**；仍不足則該類少於 100，差額寫在 `status.json` 的 `shortfall`。

## 單一來源

| 路徑 | 產出 | 角色 |
|------|------|------|
| GitHub Actions | `data/feed.json`（raw） | **唯一新聞源** |

NAS `.news-minimax-env`：

```text
RELAY_FEED_URL=https://raw.githubusercontent.com/leisureorghk/news-relay/main/data/feed.json
MINIMAX_AUTO_COVERS=0
```

讀取失敗或過期（預設 8 小時）時，NAS **保留上一版已發布清單**，不會退回本機 RSS。

## 獨立公開倉庫

本目錄已推至 https://github.com/leisureorghk/news-relay （勿與含會員／金鑰的本站倉庫混在一起）。

NAS 讀取位址（勿用 jsDelivr，以免 CDN 快取拖過 4 小時）：

```text
https://raw.githubusercontent.com/leisureorghk/news-relay/main/data/feed.json
https://raw.githubusercontent.com/leisureorghk/news-relay/main/data/status.json
https://raw.githubusercontent.com/leisureorghk/news-relay/main/data/covers.json
```

## 排程

- **Refresh news relay**：`0 */4 * * *`（UTC；香港 8/12/16/20/0/4），亦可手動 `workflow_dispatch`
- **Generate AI covers**：`20 */4 * * *`（比 refresh 晚約 20 分鐘）
- **Monthly optimize sources**：每月 1 日 04:00 UTC

## AI 封面（GitHub）

Actions：`Generate AI covers`。封面以 GitHub 為主；NAS 設 `MINIMAX_AUTO_COVERS=0`。

省額度規則：

- 模型只打 **image-01**
- 整份 feed 無圖項；**七類輪流**、類內由新到舊
- 每輪最多 **12** 張、每日最多 **72** 張
- 撞 Token Plan／quota 立刻停
- 掉出清單的封面檔會刪除

產出：`data/covers/{id}.jpg` + `covers.json`，並把 raw URL 寫回 `imageUrl`。

GitHub repo **Secrets**：

```text
MINIMAX_API_KEY=（必填）
MINIMAX_BASE_URL=https://api.minimaxi.com   # 可選
MINIMAX_REGION=cn                            # 可選
```

```bash
# 本機（需已設 MINIMAX_API_KEY）
npm run covers
# COVER_MAX=12 COVER_DAILY_MAX=72 npm run covers
```

## 本機手動更新

```bash
node src/refresh.mjs
```

需要 Node 18+（Actions 使用 22）。無額外 npm 依賴。

## 每月優化來源

```bash
npm run optimize
```

會探測每個來源的主網址／備援，寫入 `sources.json` 的 `health`、必要時 `softBlock`／`enabled: false`。

## 輸出格式

- `data/feed.json`：標題、連結、短摘要、來源、時間、分類、圖片網址；不含全文與金鑰。
- `data/status.json`：成功／失敗源數、每類則數、`shortfall`、錯誤摘要。

明報等易 403 源設有 `fallbackUrl`（Google News site:…）；失敗會自動改備援。

## Synology

呼叫 `cron_sync.php` 建議比 Actions 晚約 40 分鐘（例如 `40 */4 * * *`）。詳見 `nas-php/CRON.md`。
