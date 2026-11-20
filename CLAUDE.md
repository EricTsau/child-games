# 小朋友遊戲樂園：專案記憶

純靜態網站（GitHub Pages，沒有 build），上線網址 <https://erictsau.github.io/child-games/>。
介面一律用**繁體中文（台灣）**。每個遊戲都要有商業遊戲的完成度：標題畫面、暫停、結束畫面、最佳紀錄、手感（動畫、粒子、震動），
**而且一定要有原創背景音樂和完整音效**（見下方「音樂與音效」）。

## 檔案結構

- `index.html`：首頁。`GAMES` 陣列每列 `['slug', '名稱', '一句介紹', '分類', '年齡', '標籤']`
  - 分類：`動作` `運動` `益智` `棋牌` `學習` `創作`
  - 年齡：`k` 小小孩、`a` 大家、`o` 大朋友
  - 標籤：`''`、`'3D'`、`'雙人'`、`'3D,雙人'`
  - 最後 `NEW_COUNT`（20）個顯示「NEW」。
  - 首頁會在背景預先下載每個遊戲的 `games/<slug>/` 和縮圖；遊戲如果有**額外的檔案**（多個 .js 模組、第二個 html），要加進 `urls.push(...)` 那一行，才能離線玩。
- `games/<slug>/index.html`：一個遊戲一個資料夾，通常是單一檔案（CSS/JS 內嵌）。全部圖案用程式畫（Canvas / SVG / three.js），**不用 emoji 當角色圖、不用外部圖片字型、不用 CDN**。
- `assets/common.js` + `common.css`：共用的 `window.KG`（`KG.store`、`KG.best`、`KG.toast`、`KG.confetti`、`KG.say` 中文語音、`KG.vibrate`、`KG.lowEnd`、`KG.audio()` 共用 AudioContext）。
  它會自動加左上 🏠 和右上 🔊 按鈕（z-index 9300）。
- `assets/kg-music.js`：共用的**音樂與音效引擎**（要在 common.js 後面載入）。
- `assets/vendor/three/`：three.js r170 和少數 addons（3D 遊戲用 importmap 載入，參考 `games/neon-breaker/`）。
- `assets/thumbs/<slug>.jpg`：首頁縮圖（800×600 視窗、deviceScaleFactor 0.6 截標題畫面，存成 480×360 jpg）。
- `sw.js`：離線快取（stale-while-revalidate）。新增遊戲**不用改** sw.js。
- `README.md`、`manifest.webmanifest`：遊戲總數和列表。

## 新增遊戲時要改的地方（上架清單）

1. `games/<slug>/index.html`（和額外檔案）。
2. `assets/thumbs/<slug>.jpg` 縮圖。
3. `index.html`：`GAMES` 加一列；「N 個」出現 2 次（meta description、`.sub`）都要改；有額外檔案就加進預先下載清單。
4. `manifest.webmanifest`：description 裡的「N 個」。
5. `README.md`：開頭「N 個」、遊戲表加一列 `| N | emoji 名稱 | 分類 | 玩法 |`；3D 遊戲加進「…用 three.js」那一句。
6. 上線：推到工作分支 → 開 PR 到 `main` → squash merge → 等 GitHub Pages（約 1～2 分鐘）→ 確認線上「N 個」和每個新遊戲網址都是 200。

## 音樂與音效（一定要做）

用 `assets/kg-music.js`，不要再用舊的 `KG.note` / `KG.sound`：

```html
<script src="../../assets/common.js"></script>
<script src="../../assets/kg-music.js"></script>
```

- **背景音樂**：`KG.music.play(song)`，曲子是資料：`bpm`、`swing`、`chords`（每小節一個和弦）、`tracks`
  （鼓的 `pat` 節奏字串、跟和弦走的 `chord`（貝斯 `R..5.8.`、`'hold'` 長音）、`arp` 分解和弦、`seq` 旋律字串、`layer` 名稱）。
  樂器：lead pluck bell pad bass sub organ marimba flute chip strings brass kalimba；鼓：kick snare hat ohat clap shaker tom rim crash。
  - 每個遊戲至少兩首**原創**曲子：標題／選單一首、遊戲中一首（8 小節以上，要有真正的旋律、和弦、貝斯，風格適合的話加鼓）。
  - 每款遊戲的曲風、調性、速度要不一樣（看 README 或既有遊戲避免重複）。
  - 會隨遊戲變化：`KG.music.setLayer('名稱', true)` 緊張時加樂器、`KG.music.setTempo(1.05~1.1)` 最後衝刺加快。
  - 旋律主要放在第 4～5 八度（太高會刺耳）；用程式檢查每個音都在調內或和弦內。
  - 不要抄現成的歌（例如垃圾車的《少女的祈禱》《給愛麗絲》）。
- **短樂句**：`KG.music.jingle({bpm, inst, vol, notes:[['C5',1],['E5+G5',2]], bass:[['C3',長度,開始拍]], bassVol})`，過關、失敗、升級用，會自動壓低背景音樂。
- **音效**：`KG.sfx.play(名稱, {vol, pitch, pan})`，內建約 38 種（`KG.sfx.list()`）；`KG.sfx.define(名稱, fn)` 自己疊出新的；
  `KG.sfx.tone/noise` 做細節；`KG.sfx.loop('engine'|'hum'|'wind'|'water')` 做持續的聲音（`set(0~1, 音量)`、`stop()`）。
  - **每個動作、每個事件都要有聲音**。重複的聲音音高隨機 ±3～6%、連擊音高上升、同一種聲音最多每 40 ms 一次、依畫面左右 pan。
  - 混音：音效在前、音樂在後，不能有刺耳的聲音；短而清脆比長而糊好。
- **開關與暫停**：暫停選單（和標題／設定）要有「音樂 開/關」（`KG.music.setEnabled`，全站共用）和「音效 開/關」（自己的旗標存在 `KG.store`）。
  暫停時 `KG.music.pause()`、繼續時 `KG.music.resume()`；遊戲結束換音樂或停掉，播 jingle。
- 引擎已經處理：🔊 靜音、切到別的分頁（音樂和 loop 都會停）、使用者第一次點擊前不建立聲音（不會有瀏覽器警告）、手指放開才解鎖（第一下就有聲音）。
- 有語音（`KG.say`）的遊戲：講話時把音樂調小，講完再恢復。
- **驗證**：Chromium 加 `--autoplay-policy=no-user-gesture-required`，點一下解鎖、開始遊戲，確認 `KG.music.isPlaying()` 遊戲中 true、暫停 false。
  量混音：
  ```js
  const n = KG.music._nodes(); const an = n.ctx.createAnalyser(); an.fftSize = 2048; n.comp.connect(an);
  // 每 100 ms 讀 an.getFloatTimeDomainData，玩 6 秒左右（要有音效）
  ```
  峰值 < 0.95（不能爆音），RMS 大約 0.05～0.15。

## 版面與操作（以前出過的 bug）

- 版面用 canvas 的實際大小（`getBoundingClientRect()`）算，指標座標也要經過這個 rect 換算；聽 `visualViewport` 的 resize 和 `orientationchange`。手機網址列、安裝成 App 時 100dvh 不一定等於 innerHeight。
- 所有選單和遮罩的 z-index 要**小於 9300**，🏠／🔊 才按得到；遊戲 UI 避開左上、右上 60px，暫停鍵放在右上 🔊 下面（y ≈ 84）。
- 觸控要寬鬆：點擊吸附到附近最近的目標，不要求點得很準。手機觸控用 `touch-action:none`。
- 按鈕在直式、橫式、電腦三種尺寸都不能跑出畫面外；主要按鈕固定在底部，只有中間內容捲動。
- 效能：手機要順。物件池、限制粒子數、熱迴圈不用 `shadowBlur`（光暈先畫到離屏 canvas）、3D 遊戲要有自動降畫質（參考 neon-breaker）。
- 分頁隱藏時自動暫停。用 `requestAnimationFrame` + delta time。

## 測試

- 本機：`python3 -m http.server <port>`（在專案根目錄），用 Playwright + Chromium（已安裝，`require('playwright')`）。
  3D 要加 `--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader`，軟體繪圖很慢，用測試掛鉤（`window.__xx`）快轉。
- 一定要測 390×844（觸控）、844×390（觸控）、1280×800，用真的點擊／拖曳／按鍵，截圖**自己看過**，修掉重疊、太擠、跑出畫面。
- 不能有任何 console error / warning。
- 點擊畫面時不要點左上角（會按到 🏠 跳回首頁）。

## 原則

- 只做原創遊戲：可以是常見類型，但名稱、角色、畫面、音樂都要自己設計，不做某個現成遊戲的翻版。
- 遊戲內容要符合台灣（例如新台幣、台灣垃圾分類、注音、台灣口訣）。
