# LIFF 婚禮問答（Kahoot 風格 / 400 人）

你會得到三個頁面：
- `/player.html` 玩家端（在 LINE LIFF 裡玩）
- `/host.html` 主持台（在 LINE LIFF 裡控場）
- `/display.html?code=XXXXXX` 投影頁（大螢幕）

即時同步用 Socket.IO；計分是「答對越快分數越高」。

## 1) 安裝
```bash
npm i
cp .env.example .env
# 編輯 .env
npm start
```

## 2) LINE / LIFF 設定要點
- LIFF 每次開頁都要先 `liff.init()` 初始化，初始化後才能用 SDK（例如 getProfile）。(官方文件強調每次開頁都要 init)
- 建議建立 2 個 LIFF app：
  - Player endpoint URL: `https://你的網域/player.html`
  - Host endpoint URL:   `https://你的網域/host.html`
- 取得兩個 LIFF ID 填入 `.env`

## 3) 婚禮當天流程（建議）
1. 主持人在 LINE 打開 Host LIFF → 建立房間 → 得到房間碼
2. 把 `玩家頁網址` 分享到群組（或做成 QR）
3. 投影開 `display.html?code=房間碼`
4. 主持按「開始（15s）」→ 自動揭曉 → 下一題

## 4) 自訂題庫
在主持台右側貼 JSON：
```json
[
  {"text":"題目","choices":["A","B","C","D"],"correctIndex":0}
]
```

## 400 人小提醒
- 一台伺服器通常足夠（婚禮場景）
- 不要水平擴充到多台（除非你懂 sticky session / Redis adapter）
