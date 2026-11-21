# 🎬 PhotoPresenter - 本機目錄直讀動態相簿音樂播放器 (Chromecast 電視投放版)

一款運行於 **Google Chrome 瀏覽器 + Node.js 本機直讀服務** 的動態相簿與背景音樂播放軟體。
採用 **零上傳 (Zero-Upload)** 設計：選定一個或多個本機/NAS 照片資料夾後，只記錄目錄清單，等到播放該張照片時才直接從硬碟串流讀取並呈現，搭配 **12 種不重複劇院級慢速進場動畫**、**背景音樂無限循環 (Loop)**，並支援透過 **Google Chromecast 投放到大電視** 與家人朋友一起欣賞。

## ✨ 功能特色

- **📂 本機多目錄直讀（零上傳）**：可選取多個本機或 NAS 網路磁碟機資料夾（完整支援中文路徑），不預先上傳照片，播放到哪張才直接從硬碟讀取哪張。
- **🎵 背景音樂無限重覆播放**：選取本機音樂檔（MP3 / WAV / M4A / OGG / FLAC），照片播放時自動無限循環 (Loop)，並與暫停/繼續同步。
- **⏱️ 自訂每張停留秒數**：可設定每張照片停留秒數（播放中亦可隨時透過控制列 `-` / `+` 即時調整）。
- **🎭 12 種舒緩不重複進場動畫**：採用 Shuffle-Bag 輪抽演算法，確保每播一張都換不同的進場動畫（Ken Burns 電影推拉、3D 水平/垂直優雅翻轉、拍立得輕柔落下、柔焦光圈展開、菱形百葉等）。
- **📺 Google Chromecast 電視投放支援**：支援 Chrome 分頁投放（1080p/4K 60fps 完整 3D 特效 + 電視喇叭同步播放背景音樂）以及 Canvas MediaStream Remote Playback。

## 🚀 快速啟動

1. 確認電腦已安裝 [Node.js](https://nodejs.org/)。
2. 雙擊執行 **`啟動_PhotoPresenter.bat`**（或在終端機執行 `node server.js --open`）。
3. 系統會自動以 Google Chrome 開啟 `http://localhost:3579`。

詳細規格請參閱 [SPEC.md](./SPEC.md)。
