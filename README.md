# PEYSON Laser Live Print

現場雷雕用的前後台系統，支援手寫簽名、打字、活動字體、取件流水號與飛鵝 Wi-Fi 出票機。

## 網頁

- 前台：`/`
- 後台：`/admin`
- 健康檢查：`/health`

## 第一版功能

### 前台
- 手寫簽名與簡單圖案
- Apple Pencil、一般觸控筆、手指、滑鼠
- Pointer Events 與合併事件取樣
- 輕度二次曲線平滑
- 三種筆畫粗細
- 復原、重做、清除
- 打字、字數限制與活動字體選擇
- 自動置中、依雷雕範圍縮放
- 高解析透明 PNG
- 手寫內容同步輸出 SVG
- 送出後三位數取號
- 依場次設定自動出票

### 後台
- 密碼登入
- 每 3 秒更新製作佇列
- 等待、製作中、完成、取消狀態
- PNG／SVG 下載，檔名直接使用取件號碼
- 補印票券
- 活動名稱、輸入模式、字數、輸出尺寸、雷雕比例設定
- 上傳 TTF、OTF、WOFF、WOFF2 活動字體
- 流水號重設
- 出票機狀態檢查

## 環境變數

```env
ADMIN_PASSWORD=請設定後台密碼
DATA_DIR=/var/data
FEIE_API_URL=https://api.jp.feieyun.com/Api/Open/
FEIE_USER=飛鵝開放平台USER
FEIE_UKEY=飛鵝開放平台UKEY
FEIE_SN=出票機SN
```

USER、UKEY、SN 只能設定在 Render 環境變數，不可放進前端或提交到 GitHub。

## Render 部署

1. 從此 repository 建立新的 Web Service。
2. Branch 選擇 `laser-liveprint-v1`。
3. Build Command：`npm install`
4. Start Command：`npm start`
5. 設定上述環境變數。
6. 正式活動需掛載 Persistent Disk，Mount Path 設為 `/var/data`，並將 `DATA_DIR` 設為 `/var/data`。

沒有 Persistent Disk 時，Render 重啟或重新部署可能清除流水號、訂單與上傳字體，不可直接用於正式活動。

## 本機測試

```bash
npm install
cp .env.example .env
npm start
```

開啟 `http://localhost:10000`，後台為 `http://localhost:10000/admin`。

## 飛鵝出票

使用 `Open_printMsg`，SHA1 簽章為 `USER + UKEY + UNIX timestamp`。客人送出成功後系統先建立取件號，再非同步送出票指令；即使出票暫時失敗，後台仍保留工作並可按「補印票券」重試。
