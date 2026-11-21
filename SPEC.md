# PhotoPresenter - 動態相簿音樂播放器 軟體規格書 (Spec v2.0 - Chromecast 電視投放強化版)

## 1. 專案概述 (Overview)
開發一款運行於 **Google Chrome 瀏覽器** 的本機動態相簿與音樂播放軟體 (**PhotoPresenter**)。
使用者可於本機選取**多個照片資料夾**與**背景音樂檔**，自訂每張照片停留秒數。播放時每張照片皆會自動套用**不同的動態進場動畫**，背景音樂則同步無限循環播放；並全面針對 **Google Chromecast 電視投放** 進行視覺、音訊與串流最佳化，讓全家或聚會時可在大電視上一起欣賞。

---

## 2. 系統架構與執行環境 (System Architecture)
- **目標執行環境**：Google Chrome 瀏覽器 + 本機輕量直讀服務 (`Node.js server.js`)。
- **核心設計（零上傳 ‧ 本機硬碟直讀 On-Demand Streaming）**：
  - **絕不把目錄裡的照片預先上傳到瀏覽器**！
  - 使用者在介面上選取目錄（透過 Windows 原生目錄選擇器或直接貼上本機路徑如 `D:\Photos\Trip`）時，系統**只會把「目錄路徑清單」記下來**。
  - 當按下「開始動態播放」時，系統才會即時進去這些目錄讀取檔案清單，且**輪到哪一張照片要播放時，才直接透過 `/api/file?path=...` 從本機硬碟讀取那一張照片出來 Show**（背景音樂亦直接從硬碟串流 Loop 播放），就算目錄內有上萬張照片也能秒選秒播、不佔記憶體。
- **音訊與串流引擎**：HTML5 Audio API + Canvas MediaStream API (`captureStream` + `RemotePlayback` / Google Cast 支援)。
- **部署與啟動方式**：
  - 雙擊 `啟動_PhotoPresenter.bat` 即可啟動本機直讀服務並自動用 Google Chrome 開啟 `http://localhost:3579`。

---

## 3. 核心功能規格 (Functional Specifications)

### 3.1 本機照片目錄多選管理 (Multi-Folder Selection)
1. **多資料夾累加選取**：
   - 提供「➕ 新增照片目錄」按鈕，支援**分批多次加入不同的本機資料夾**。
   - 支援**直接將多個資料夾從檔案總管拖曳 (Drag & Drop)** 至網頁視窗內。
   - 額外提供「🖼️ 加選個別照片檔」按鈕，方便臨時補入個別照片。
2. **已選目錄清單介面**：
   - 顯示每個已加入資料夾的「目錄名稱」、「預覽縮圖」、「有效照片數量」。
   - 支援「個別移除某個目錄」或「全部清空」。
   - 提供「包含子資料夾照片」開關（預設開啟）。
3. **支援圖片格式**：
   - 自動篩選 `.jpg`, `.jpeg`, `.png`, `.webp`, `.gif`, `.bmp`, `.avif`（自動忽略非圖片檔與系統隱藏檔）。

### 3.2 背景音樂與循環播放 (Background Music & Loop)
1. **音樂選取**：
   - 提供「🎵 選擇音樂檔」按鈕（亦支援拖曳音樂檔），支援 `.mp3`, `.wav`, `.ogg`, `.m4a`, `.aac`, `.flac`。
   - 顯示目前選取的音樂檔名、檔案大小，並可隨時更換或移除。
2. **無限循環與狀態同步**：
   - 當按下「開始動態播放」時，背景音樂自動啟動並設定為 **無限重覆播放 (`loop = true`)**（若選多首音樂則自動無限輪播）。
   - 照片播放暫停時，音樂同步暫停；照片繼續時，音樂同步繼續；結束播放時，音樂停止並歸零。
   - 支援音量大小滑桿 (`0% ~ 100%`) 與一鍵靜音切換 (`M` 鍵)。

### 3.3 播放控制與參數設定 (Playback Settings)
1. **每張照片停留秒數**：
   - 可設定範圍：`1` 秒 ～ `120` 秒（預設 `5` 秒），支援滑桿與數字直接輸入。
   - **即時生效**：即使在播放途中或投影到電視時，也能透過控制列 `-` / `+` 即時更改秒數。
2. **播放順序**：
   - **依序播放**：依照資料夾與檔名自然順序播放。
   - **隨機播放 (Shuffle)**：將所有已選目錄的照片打亂隨機播放。
3. **相簿循環**：
   - 預設開啟「播完最後一張自動重頭循環播放」。
4. **電視畫面比例模式**：
   - **完整照片 + 動態模糊背景模式 (預設推薦)**：完整顯示照片不裁切（無論直拍或橫拍照片），16:9 電視兩側空白處自動以「該張照片的動態高斯模糊 + 暗化背景」雙層柔光填滿。
   - **滿版填滿螢幕模式 (Cover)**：照片放大填滿整個 16:9 畫面。

### 3.4 動態進場動畫引擎 (Dynamic Entrance Animation Engine)
- **核心規則**：每切換一張照片，系統必須從動畫庫中抽取與上一張**不同**的進場動畫（採用 Shuffle-Bag 不重複輪抽演算法，確保每輪 12 種動畫都播過一次才會進入下一輪，且交界處絕不連續重複）。
- **內建 12 種劇院級進場與展示動畫**：
  1. `anim-kenburns-in`：**電影慢速推進 (Ken Burns Zoom In)** — 柔和淡入並持續微幅放大平移
  2. `anim-kenburns-out`：**電影慢速拉遠 (Ken Burns Zoom Out)** — 從特寫淡入並緩慢拉遠至全景
  3. `anim-slide-left`：**左側彈性滑入 (Slide Left)** — 從畫面左側帶減速曲線滑入定位
  4. `anim-slide-right`：**右側彈性滑入 (Slide Right)** — 從畫面右側帶減速曲線滑入定位
  5. `anim-3d-flip-x`：**3D 水平立體翻轉 (3D Flip Horizontal)** — 立體透視 Y 軸翻轉進場
  6. `anim-3d-flip-y`：**3D 垂直立體翻頁 (3D Flip Vertical)** — 立體透視 X 軸立體翻頁進場
  7. `anim-polaroid-drop`：**拍立得微旋落下 (Polaroid Drop)** — 從上方帶著微傾角度優雅落下並回正
  8. `anim-float-up`：**底部浮現放大 (Float Up & Scale)** — 從下方微幅上浮同時由小放大清晰化
  9. `anim-swirl-zoom`：**漩渦旋轉聚焦 (Swirl & Zoom)** — 帶微幅旋轉角度由遠而近聚焦
  10. `anim-iris-reveal`：**柔焦光圈展開 (Iris Circle Reveal)** — 以圓形遮罩由中心向外展開並由模糊變清晰
  11. `anim-diamond-wipe`：**菱形百葉展開 (Diamond Wipe Reveal)** — 以幾何菱形遮罩動態擴展進場
  12. `anim-3d-swing`：**3D 畫框推門進場 (3D Swing Door)** — 如同推開畫框般帶景深擺動進場

### 3.5 Chromecast 電視投放功能 (Chromecast TV Casting)
提供雙重投放機制，讓使用者在 Google Chrome 上能最順暢地把「照片動畫 + 背景音樂」投放到電視：
1. **方式一：Google Chrome 原生「投放此分頁 (Cast Tab)」最佳化（首選推薦）**：
   - 使用標準 HTML5 Audio 輸出音軌與 GPU 硬體加速 CSS 3D 動畫，確保透過 Chrome 投放分頁時，**電視喇叭會直接同步播放背景音樂**，且完整呈現 1080p/4K 60fps 的 3D 進場動畫。
2. **方式二：內建 Canvas + Audio 媒體流合成投放 (`Remote Playback API`)**：
   - 內建 `<canvas>` + `captureStream(30)` 與 Web Audio API `createMediaStreamDestination()`，可將動態相簿與音樂即時合成為 `<video>` 媒體串流並呼叫 `video.remote.prompt()` 喚出 Chromecast 電視清單。
3. **電視純淨模式 (TV Clean HUD)**：
   - 播放時若滑鼠無動作滿 2.5 秒，底部控制列與滑鼠游標自動完全隱藏，讓電視上只有純粹的照片與特效。
   - 移動滑鼠或按鍵盤任意鍵，才會在底部浮現半透明毛玻璃控制列。

---

## 4. 鍵盤快捷鍵一覽 (Keyboard Shortcuts)
| 按鍵 | 功能說明 |
| :--- | :--- |
| `Space` (空白鍵) | 暫停 / 繼續播放（照片與背景音樂同步） |
| `➡️` (右方向鍵) | 立即切換下一張照片（套用新進場動畫） |
| `⬅️` (左方向鍵) | 立即切換上一張照片（套用新進場動畫） |
| `F` | 切換全螢幕模式 (`Fullscreen`) |
| `M` | 背景音樂靜音 / 解除靜音 |
| `I` | 顯示 / 隱藏左下角照片檔名與動畫資訊卡 |
| `Esc` | 退出播放，返回設定主畫面 |

---

## 5. 專案檔案清單 (Project Files)
```text
PhotoPresenter/
├── SPEC.md                  # 本軟體規格書 (Markdown)
├── index.html               # 主程式頁面（設定面板、動態播放劇院舞台、Chromecast 投放面板）
├── styles.css               # 深色劇院 UI 樣式、12 種 CSS3 3D/遮罩進場動畫定義、16:9 電視適配
├── app.js                   # 多目錄照片讀取器、不重複動畫輪抽引擎、音樂循環同步器、Chromecast 控制器
└── 啟動_PhotoPresenter.bat  # Windows 一鍵以 Google Chrome 開啟主程式的啟動腳本
```
