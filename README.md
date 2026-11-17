# 新聞中轉（GitHub Actions／本機排程）

每 3 小時抓取 RSS、去重與分類配額過濾，寫入約 200 則滾動清單 `data/feed.json`，供 NAS 站台讀取後再做繁中標題／摘要／封面。

## 本機已接好（預設）

Windows 工作排程 **`NewsRelayRefresh`** 會跑專案內 `scripts/refresh-relay-to-nas.ps1`，把 `data/feed.json` 複製到 `W:\news\relay\feed.json`。NAS 的 `.news-minimax-env` 使用：

```text
RELAY_FEED_URL=relay/feed.json
```

## 可選：獨立公開 GitHub 倉庫

把本目錄（`relay/`）內容推成**單獨**公開 repo（勿與含會員／金鑰的本站倉庫混在一起）：

```text
sources.json
package.json
src/refresh.mjs
data/feed.json
.github/workflows/refresh.yml
README.md
```

NAS 讀取位址（勿用 jsDelivr，以免 CDN 快取拖過 3 小時）：

```text
https://raw.githubusercontent.com/<owner>/<repo>/main/data/feed.json
```

若仍放在本專案子目錄，路徑則為 `.../main/relay/data/feed.json`，並把 workflow 移到倉庫根的 `.github/workflows/`。

## 本機手動更新

```bash
node src/refresh.mjs
```

需要 Node 18+。無額外 npm 依賴。

## 輸出格式

`data/feed.json` 僅含標題、連結、短摘要、來源、時間、圖片網址；不含全文與任何 API 金鑰。每次覆寫同一檔。

## NAS 設定

在站台根目錄 `.news-minimax-env`：

```text
RELAY_FEED_URL=https://raw.githubusercontent.com/<owner>/<repo>/main/data/feed.json
```

未設定時行為與舊版相同（NAS 自行抓 RSS）。`generatedAt` 超過 6 小時或下載失敗會自動退回本機抓源。

Synology 呼叫 `cron_sync.php` 建議比 Actions 整點晚約 20 分鐘（例如 `20 */3 * * *`）。
