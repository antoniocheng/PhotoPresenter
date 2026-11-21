/**
 * PhotoPresenter - 本機目錄直讀動態相簿音樂播放器 (Chromecast 電視投放版)
 * -------------------------------------------------------------------------
 * 核心架構：零上傳 (Zero-Upload)、選定目錄列表後於播放時直接讀取本機照片呈現！
 *
 * 支援兩種直讀模式：
 * 1. 本機直讀服務模式 (透過 server.js 啟動 http://localhost:3579)：
 *    - 點擊「瀏覽並加入本機照片目錄」或直接貼上本機目錄路徑 (如 D:\Photos\Trip)。
 *    - 清單只儲存目錄路徑字串。按下「開始播放」時，直接透過 `/api/file?path=...`
 *      從硬碟即時串流讀取當前要 Show 的那一張照片！
 * 2. Chrome File System Access API 模式 (`window.showDirectoryPicker`)：
 *    - 若使用者未啟動 server.js 而直接開啟網頁，則使用 DirectoryHandle，
 *      選目錄時只記錄 DirectoryHandle，按下播放時才進目錄讀取檔案，輪到哪張才讀哪張！
 */

(() => {
  'use strict';

  const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif']);
  const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac', '.webm']);

  // 12 種不重複進場動畫池
  const ENTRANCE_ANIMATIONS = [
    { id: 'anim-kenburns-in',   name: '🎬 電影慢速推進 (Ken Burns In)' },
    { id: 'anim-kenburns-out',  name: '🎥 電影慢速拉遠 (Ken Burns Out)' },
    { id: 'anim-slide-left',    name: '⬅️ 左側彈性滑入 (Slide Left)' },
    { id: 'anim-slide-right',   name: '➡️ 右側彈性滑入 (Slide Right)' },
    { id: 'anim-3d-flip-x',     name: '🔄 3D 水平立體翻轉 (3D Flip H)' },
    { id: 'anim-3d-flip-y',     name: '🔃 3D 垂直立體翻頁 (3D Flip V)' },
    { id: 'anim-polaroid-drop', name: '📸 拍立得微旋落下 (Polaroid Drop)' },
    { id: 'anim-float-up',      name: '🎈 底部浮現放大 (Float Up)' },
    { id: 'anim-swirl-zoom',    name: '🌀 漩渦旋轉聚焦 (Swirl Zoom)' },
    { id: 'anim-iris-reveal',   name: '🔮 柔焦光圈展開 (Iris Reveal)' },
    { id: 'anim-diamond-wipe',  name: '💎 菱形百葉展開 (Diamond Wipe)' },
    { id: 'anim-3d-swing',      name: '🚪 3D 畫框推門進場 (3D Swing)' }
  ];

  // 檢查是否運行於本機直讀伺服器 (server.js)
  const isLocalServerMode = window.location.protocol.startsWith('http');
  const STORAGE_KEY = 'PhotoPresenter_SavedState_v1';

  const state = {
    /**
     * 已選定的照片目錄列表 (只記目錄本身，不上傳照片!)
     * Map<id, {
     *   id: string,
     *   name: string,
     *   type: 'server-path' | 'fs-handle',
     *   folderPath?: string,          // server-path 模式下的本機完整路徑 (如 D:\Photos)
     *   dirHandle?: FileSystemDirectoryHandle // fs-handle 模式下的目錄控柄
     * }>
     */
    folders: new Map(),
    includeSubfolders: true,

    // 歷史曾經選過的照片目錄與音樂清單 (方便隨時一鍵點選重用)
    // Array<{ name: string, folderPath: string }>
    recentFolders: [],
    // Array<{ name: string, fullPath: string }>
    recentMusic: [],

    // 背景音樂 (支援本機路徑直讀或 File 參照)
    // Array<{ name: string, type: 'server-path' | 'file', fullPath?: string, file?: File }>
    musicTracks: [],
    currentMusicIndex: 0,
    musicObjectUrl: null,
    volume: 0.8,
    isMuted: false,

    // 播放參數設定
    durationSec: 5,
    playOrder: 'sequential',
    fitMode: 'contain',
    loopPhotos: true,
    showCaption: true,

    // 播放期照片索引清單 (只存路徑或 FileHandle 指標，不載入照片內容)
    // Array<{ name: string, folderName: string, type: 'server-path' | 'fs-handle', fullPath?: string, fileHandle?: FileSystemFileHandle }>
    playlist: [],
    currentIndex: -1,
    currentPhotoBlobUrl: null,
    prevPhotoBlobUrl: null,
    isPlaying: false,
    isPaused: false,

    // 計時器
    slideTimer: null,
    slideStartTime: 0,
    remainingMs: 0,

    // 不重複動畫輪抽袋
    animBag: [],
    lastAnimId: null,

    // 背景雙圖層旗標
    activeBgLayer: 'A',
    hudHideTimer: null,

    // 鍵盤直接按數字選台跳頁緩衝
    typedNumberBuffer: '',
    typedNumberTimer: null,

    // Chromecast Canvas Stream
    isCanvasCasting: false,
    castAnimFrameId: null,
    audioCtx: null,
    audioSourceNode: null,
    audioDestNode: null
  };

  // DOM 參照
  const dom = {
    setupView: document.getElementById('setup-view'),
    playerView: document.getElementById('player-view'),

    btnAddFolder: document.getElementById('btn-add-folder'),
    manualPathRow: document.getElementById('manual-path-row'),
    inputFolderPath: document.getElementById('input-folder-path'),
    btnAddPath: document.getElementById('btn-add-path'),
    chkSubfolders: document.getElementById('chk-subfolders'),
    btnClearFolders: document.getElementById('btn-clear-folders'),
    folderList: document.getElementById('folder-list'),
    folderSummaryBadge: document.getElementById('folder-summary-badge'),
    recentFoldersBox: document.getElementById('recent-folders-box'),
    recentFoldersTags: document.getElementById('recent-folders-tags'),
    btnClearRecentFolders: document.getElementById('btn-clear-recent-folders'),

    musicInput: document.getElementById('music-input'),
    musicDropZone: document.getElementById('music-drop-zone'),
    btnSelectMusic: document.getElementById('btn-select-music'),
    btnClearMusic: document.getElementById('btn-clear-music'),
    musicFilename: document.getElementById('music-filename'),
    musicMeta: document.getElementById('music-meta'),
    musicStatusBadge: document.getElementById('music-status-badge'),
    manualMusicRow: document.getElementById('manual-music-row'),
    inputMusicPath: document.getElementById('input-music-path'),
    btnAddMusicPath: document.getElementById('btn-add-music-path'),
    recentMusicBox: document.getElementById('recent-music-box'),
    recentMusicTags: document.getElementById('recent-music-tags'),
    btnClearRecentMusic: document.getElementById('btn-clear-recent-music'),
    setupVolume: document.getElementById('setup-volume'),
    setupVolumeLabel: document.getElementById('setup-volume-label'),
    bgAudio: document.getElementById('bg-audio'),

    durationSlider: document.getElementById('duration-slider'),
    durationNumber: document.getElementById('duration-number'),
    chkLoopPhotos: document.getElementById('chk-loop-photos'),
    chkShowCaption: document.getElementById('chk-show-caption'),
    animationTags: document.getElementById('animation-tags'),
    btnStartTop: document.getElementById('btn-start-top'),
    btnStartMain: document.getElementById('btn-start-main'),

    bgLayerA: document.getElementById('bg-layer-a'),
    bgLayerB: document.getElementById('bg-layer-b'),
    slidePrev: document.getElementById('slide-prev'),
    slideCurrent: document.getElementById('slide-current'),
    imgPrev: document.getElementById('img-prev'),
    imgCurrent: document.getElementById('img-current'),

    photoCaption: document.getElementById('photo-caption'),
    captionFolder: document.getElementById('caption-folder'),
    captionFilename: document.getElementById('caption-filename'),
    captionIndex: document.getElementById('caption-index'),
    captionAnim: document.getElementById('caption-anim'),
    playerHud: document.getElementById('player-hud'),
    btnExitPlayer: document.getElementById('btn-exit-player'),
    hudMusicName: document.getElementById('hud-music-name'),
    btnPrevSlide: document.getElementById('btn-prev-slide'),
    btnTogglePlay: document.getElementById('btn-toggle-play'),
    btnNextSlide: document.getElementById('btn-next-slide'),
    hudJumpInput: document.getElementById('hud-jump-input'),
    hudTotalPages: document.getElementById('hud-total-pages'),
    btnHudJump: document.getElementById('btn-hud-jump'),
    directJumpOverlay: document.getElementById('direct-jump-overlay'),
    directJumpNumber: document.getElementById('direct-jump-number'),
    btnSecMinus: document.getElementById('btn-sec-minus'),
    btnSecPlus: document.getElementById('btn-sec-plus'),
    hudSecValue: document.getElementById('hud-sec-value'),
    btnMuteToggle: document.getElementById('btn-mute-toggle'),
    hudVolume: document.getElementById('hud-volume'),
    btnToggleCaption: document.getElementById('btn-toggle-caption'),
    btnCastTv: document.getElementById('btn-cast-tv'),
    btnFullscreen: document.getElementById('btn-fullscreen'),

    btnTopCastGuide: document.getElementById('btn-top-cast-guide'),
    castModal: document.getElementById('cast-modal'),
    btnCloseCastModal: document.getElementById('btn-close-cast-modal'),
    btnCastFullscreenNow: document.getElementById('btn-cast-fullscreen-now'),
    btnStartCanvasCast: document.getElementById('btn-start-canvas-cast'),
    btnStopCanvasCast: document.getElementById('btn-stop-canvas-cast'),
    canvasCastStatus: document.getElementById('canvas-cast-status'),
    castActiveIndicator: document.getElementById('cast-active-indicator'),
    castCanvas: document.getElementById('cast-canvas'),
    castVideo: document.getElementById('cast-video')
  };

  async function init() {
    renderAnimationPoolTags();
    bindSetupEvents();
    bindPlayerEvents();
    bindCastEvents();
    updateDurationUI(state.durationSec);

    // 若非透過 server.js 開啟，隱藏手動貼路徑列並使用 Chrome FileSystem Access API
    if (!isLocalServerMode) {
      dom.manualPathRow.hidden = true;
      dom.manualMusicRow.hidden = true;
    }

    // 載入上次儲存的照片目錄、背景音樂、歷史清單與播放設定
    await loadPersistedSettings();
  }

  // ================= 持久化暫存與重用 (LocalStorage + Server JSON) =================
  function savePersistedSettings() {
    const activeFolders = [];
    state.folders.forEach((f) => {
      if (f.type === 'server-path' && f.folderPath) {
        activeFolders.push({ name: f.name, folderPath: f.folderPath });
      }
    });

    const activeMusic = state.musicTracks
      .filter(t => t.type === 'server-path' && t.fullPath)
      .map(t => ({ name: t.name, fullPath: t.fullPath }));

    const payload = {
      activeFolders,
      activeMusic,
      recentFolders: state.recentFolders.slice(0, 15),
      recentMusic: state.recentMusic.slice(0, 15),
      includeSubfolders: state.includeSubfolders,
      durationSec: state.durationSec,
      playOrder: state.playOrder,
      fitMode: state.fitMode,
      loopPhotos: state.loopPhotos,
      showCaption: state.showCaption,
      volume: state.volume
    };

    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch (e) {}

    if (isLocalServerMode) {
      fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }).catch(() => {});
    }
  }

  async function loadPersistedSettings() {
    let data = null;

    if (isLocalServerMode) {
      try {
        const res = await fetch('/api/settings');
        if (res.ok) {
          const json = await res.json();
          if (json && (json.activeFolders || json.recentFolders || json.activeMusic)) {
            data = json;
          }
        }
      } catch (e) {}
    }

    if (!data) {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) data = JSON.parse(raw);
      } catch (e) {}
    }

    if (!data) return;

    // 還原歷史紀錄
    if (Array.isArray(data.recentFolders)) {
      state.recentFolders = data.recentFolders;
    }
    if (Array.isArray(data.recentMusic)) {
      state.recentMusic = data.recentMusic;
    }

    // 還原播放參數
    if (typeof data.includeSubfolders === 'boolean') {
      state.includeSubfolders = data.includeSubfolders;
      dom.chkSubfolders.checked = data.includeSubfolders;
    }
    if (typeof data.durationSec === 'number') {
      updateDurationUI(data.durationSec);
    }
    if (data.playOrder) {
      state.playOrder = data.playOrder;
      const radio = document.querySelector(`input[name="play-order"][value="${data.playOrder}"]`);
      if (radio) radio.checked = true;
    }
    if (data.fitMode) {
      state.fitMode = data.fitMode;
      const radio = document.querySelector(`input[name="fit-mode"][value="${data.fitMode}"]`);
      if (radio) radio.checked = true;
    }
    if (typeof data.loopPhotos === 'boolean') {
      state.loopPhotos = data.loopPhotos;
      dom.chkLoopPhotos.checked = data.loopPhotos;
    }
    if (typeof data.showCaption === 'boolean') {
      state.showCaption = data.showCaption;
      dom.chkShowCaption.checked = data.showCaption;
    }
    if (typeof data.volume === 'number') {
      setVolume(data.volume);
    }

    // 還原上次選定的照片目錄列表
    if (Array.isArray(data.activeFolders)) {
      for (const f of data.activeFolders) {
        if (f && f.folderPath) {
          addServerFolderPath(f.folderPath, f.name, false);
        }
      }
    }

    // 還原上次選定的背景音樂
    if (Array.isArray(data.activeMusic) && data.activeMusic.length > 0) {
      const tracks = data.activeMusic.map(m => ({
        name: m.name,
        type: 'server-path',
        fullPath: m.fullPath
      }));
      setMusicTracks(tracks, false);
    }

    renderFolderList();
    renderRecentHistoryUI();
  }

  function addRecentFolderRecord(folderPath, name) {
    const clean = folderPath.trim();
    state.recentFolders = state.recentFolders.filter(
      x => x.folderPath.toLowerCase() !== clean.toLowerCase()
    );
    state.recentFolders.unshift({ name, folderPath: clean });
    if (state.recentFolders.length > 15) state.recentFolders.length = 15;
    renderRecentHistoryUI();
  }

  function addRecentMusicRecord(fullPath, name) {
    const clean = fullPath.trim();
    state.recentMusic = state.recentMusic.filter(
      x => x.fullPath.toLowerCase() !== clean.toLowerCase()
    );
    state.recentMusic.unshift({ name, fullPath: clean });
    if (state.recentMusic.length > 15) state.recentMusic.length = 15;
    renderRecentHistoryUI();
  }

  function renderRecentHistoryUI() {
    // 1. 渲染歷史選過的照片目錄標籤
    if (state.recentFolders.length === 0) {
      dom.recentFoldersBox.hidden = true;
    } else {
      dom.recentFoldersBox.hidden = false;
      dom.recentFoldersTags.innerHTML = state.recentFolders
        .map((item, idx) => `
          <div class="recent-chip" data-idx="${idx}" title="點擊加入此目錄：${escapeHtml(item.folderPath)}">
            <span>📁</span>
            <span class="recent-chip-text">${escapeHtml(item.name)}</span>
            <span class="recent-chip-del" data-del-folder="${idx}" title="從歷史紀錄移除">✕</span>
          </div>
        `)
        .join('');

      dom.recentFoldersTags.querySelectorAll('.recent-chip').forEach(chip => {
        chip.addEventListener('click', (e) => {
          const delIdx = e.target.getAttribute('data-del-folder');
          if (delIdx !== null) {
            e.stopPropagation();
            state.recentFolders.splice(parseInt(delIdx, 10), 1);
            renderRecentHistoryUI();
            savePersistedSettings();
            return;
          }
          const idx = parseInt(chip.getAttribute('data-idx'), 10);
          const item = state.recentFolders[idx];
          if (item) {
            addServerFolderPath(item.folderPath, item.name, true);
          }
        });
      });
    }

    // 2. 渲染歷史選過的背景音樂標籤
    if (state.recentMusic.length === 0) {
      dom.recentMusicBox.hidden = true;
    } else {
      dom.recentMusicBox.hidden = false;
      dom.recentMusicTags.innerHTML = state.recentMusic
        .map((item, idx) => `
          <div class="recent-chip music-chip" data-idx="${idx}" title="點擊套用此音樂：${escapeHtml(item.fullPath)}">
            <span>🎵</span>
            <span class="recent-chip-text">${escapeHtml(item.name)}</span>
            <span class="recent-chip-del" data-del-music="${idx}" title="從歷史紀錄移除">✕</span>
          </div>
        `)
        .join('');

      dom.recentMusicTags.querySelectorAll('.recent-chip').forEach(chip => {
        chip.addEventListener('click', (e) => {
          const delIdx = e.target.getAttribute('data-del-music');
          if (delIdx !== null) {
            e.stopPropagation();
            state.recentMusic.splice(parseInt(delIdx, 10), 1);
            renderRecentHistoryUI();
            savePersistedSettings();
            return;
          }
          const idx = parseInt(chip.getAttribute('data-idx'), 10);
          const item = state.recentMusic[idx];
          if (item) {
            setMusicTracks([{ name: item.name, type: 'server-path', fullPath: item.fullPath }], true);
          }
        });
      });
    }
  }

  function renderAnimationPoolTags() {
    dom.animationTags.innerHTML = ENTRANCE_ANIMATIONS
      .map(a => `<span class="anim-tag">${a.name}</span>`)
      .join('');
  }

  function isImageFilename(name) {
    if (!name || name.startsWith('.')) return false;
    const idx = name.lastIndexOf('.');
    return idx !== -1 && IMAGE_EXTENSIONS.has(name.slice(idx).toLowerCase());
  }

  // ================= 1. 照片目錄列表管理（只記錄目錄，不上傳照片） =================
  function bindSetupEvents() {
    // 點擊「瀏覽並加入本機照片目錄」
    dom.btnAddFolder.addEventListener('click', async () => {
      if (isLocalServerMode) {
        // 呼叫本機 server.js 開啟 Windows 原生目錄選擇視窗（只取路徑字串，0 上傳）
        try {
          dom.btnAddFolder.disabled = true;
          dom.btnAddFolder.textContent = '📂 請在跳出的視窗選擇照片目錄...';
          const res = await fetch('/api/pick-folder', { method: 'POST' });
          const data = await res.json();
          if (!data.cancelled && data.folderPath) {
            addServerFolderPath(data.folderPath, data.folderName);
          }
        } catch (err) {
          // Fallback 至 Chrome 原生 showDirectoryPicker
          await pickDirectoryWithBrowserHandle();
        } finally {
          dom.btnAddFolder.disabled = false;
          dom.btnAddFolder.textContent = '📂 瀏覽並加入本機照片目錄（可重複點選加入多個）';
        }
      } else {
        await pickDirectoryWithBrowserHandle();
      }
    });

    // 直接輸入或貼上本機目錄路徑 (如 D:\Photos\Trip)
    dom.btnAddPath.addEventListener('click', () => {
      const rawPath = dom.inputFolderPath.value.trim().replace(/^"(.*)"$/, '$1');
      if (!rawPath) return;
      addServerFolderPath(rawPath);
      dom.inputFolderPath.value = '';
    });

    dom.inputFolderPath.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        dom.btnAddPath.click();
      }
    });

    // 子資料夾開關
    dom.chkSubfolders.addEventListener('change', (e) => {
      state.includeSubfolders = e.target.checked;
      renderFolderList();
      savePersistedSettings();
    });

    // 清空目錄列表
    dom.btnClearFolders.addEventListener('click', () => {
      state.folders.clear();
      renderFolderList();
      savePersistedSettings();
    });

    // 清除歷史照片目錄紀錄
    dom.btnClearRecentFolders.addEventListener('click', () => {
      state.recentFolders = [];
      renderRecentHistoryUI();
      savePersistedSettings();
    });

    // 清除歷史音樂紀錄
    dom.btnClearRecentMusic.addEventListener('click', () => {
      state.recentMusic = [];
      renderRecentHistoryUI();
      savePersistedSettings();
    });

    // 選擇本機背景音樂
    dom.btnSelectMusic.addEventListener('click', async () => {
      if (isLocalServerMode) {
        try {
          const res = await fetch('/api/pick-music', { method: 'POST' });
          const data = await res.json();
          if (!data.cancelled && data.files && data.files.length > 0) {
            const tracks = data.files.map(f => ({
              name: f.name,
              type: 'server-path',
              fullPath: f.fullPath
            }));
            setMusicTracks(tracks);
          }
          return;
        } catch (e) {
          // fallback
        }
      }
      dom.musicInput.value = '';
      dom.musicInput.click();
    });

    // 直接貼上本機音樂檔路徑
    dom.btnAddMusicPath.addEventListener('click', () => {
      const rawPath = dom.inputMusicPath.value.trim().replace(/^"(.*)"$/, '$1');
      if (!rawPath) return;
      const parts = rawPath.split(/[\\/]/);
      const name = parts[parts.length - 1] || rawPath;
      setMusicTracks([{ name, type: 'server-path', fullPath: rawPath }]);
      dom.inputMusicPath.value = '';
    });

    dom.inputMusicPath.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        dom.btnAddMusicPath.click();
      }
    });

    dom.musicInput.addEventListener('change', (e) => {
      const files = Array.from(e.target.files || []);
      if (files.length > 0) {
        setMusicTracks(files.map(f => ({ name: f.name, type: 'file', file: f })));
      }
    });

    dom.btnClearMusic.addEventListener('click', clearMusic);

    // 音量滑桿
    dom.setupVolume.addEventListener('input', (e) => {
      setVolume(parseFloat(e.target.value));
      savePersistedSettings();
    });

    // 秒數設定
    dom.durationSlider.addEventListener('input', (e) => {
      updateDurationUI(parseInt(e.target.value, 10));
      savePersistedSettings();
    });

    dom.durationNumber.addEventListener('change', (e) => {
      let val = parseInt(e.target.value, 10);
      if (isNaN(val) || val < 1) val = 1;
      if (val > 120) val = 120;
      updateDurationUI(val);
      savePersistedSettings();
    });

    document.querySelectorAll('input[name="play-order"]').forEach(radio => {
      radio.addEventListener('change', (e) => {
        state.playOrder = e.target.value;
        savePersistedSettings();
      });
    });

    document.querySelectorAll('input[name="fit-mode"]').forEach(radio => {
      radio.addEventListener('change', (e) => {
        state.fitMode = e.target.value;
        dom.playerView.classList.toggle('fit-cover', state.fitMode === 'cover');
        savePersistedSettings();
      });
    });

    dom.chkLoopPhotos.addEventListener('change', (e) => {
      state.loopPhotos = e.target.checked;
      savePersistedSettings();
    });

    dom.chkShowCaption.addEventListener('change', (e) => {
      state.showCaption = e.target.checked;
      dom.photoCaption.hidden = !state.showCaption;
      savePersistedSettings();
    });

    // 開始播放
    dom.btnStartTop.addEventListener('click', startPresentation);
    dom.btnStartMain.addEventListener('click', startPresentation);
  }

  // 加入本機目錄路徑 (只記錄目錄路徑字串，完全不上傳檔案，並自動記憶至暫存與歷史清單)
  function addServerFolderPath(folderPath, folderName, shouldPersist = true) {
    const cleanPath = folderPath.trim();
    const parts = cleanPath.split(/[\\/]/).filter(Boolean);
    const name = folderName || parts[parts.length - 1] || cleanPath;

    // 記錄至歷史曾選過的目錄清單
    addRecentFolderRecord(cleanPath, name);

    for (const existing of state.folders.values()) {
      if (existing.type === 'server-path' && existing.folderPath.toLowerCase() === cleanPath.toLowerCase()) {
        if (shouldPersist) savePersistedSettings();
        return; // 已在清單中
      }
    }

    const id = `dir_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    state.folders.set(id, {
      id,
      name,
      type: 'server-path',
      folderPath: cleanPath
    });
    renderFolderList();
    if (shouldPersist) {
      savePersistedSettings();
    }
  }

  // 使用 Chrome File System Access API 取得 DirectoryHandle（同樣不會跳出「上傳檔案」，只記目錄控柄）
  async function pickDirectoryWithBrowserHandle() {
    if (typeof window.showDirectoryPicker === 'function') {
      try {
        const dirHandle = await window.showDirectoryPicker({ mode: 'read' });
        for (const existing of state.folders.values()) {
          if (existing.type === 'fs-handle' && existing.name === dirHandle.name) {
            const isSame = await existing.dirHandle.isSameEntry(dirHandle);
            if (isSame) return;
          }
        }
        const id = `handle_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        state.folders.set(id, {
          id,
          name: dirHandle.name,
          type: 'fs-handle',
          dirHandle
        });
        renderFolderList();
      } catch (err) {
        // 使用者取消選擇
      }
    } else {
      alert('請雙擊專案目錄下的「啟動_PhotoPresenter.bat」來開啟本機直讀服務！');
    }
  }

  // 渲染已選定的照片目錄列表
  function renderFolderList() {
    const itemsHtml = [];

    state.folders.forEach((folder) => {
      const pathText = folder.type === 'server-path'
        ? folder.folderPath
        : `本機目錄授權直讀 (${folder.name})`;

      itemsHtml.push(`
        <li class="folder-item" data-id="${folder.id}">
          <div class="folder-item-left">
            <div class="folder-icon-box">📁</div>
            <div class="folder-meta">
              <div class="folder-name">${escapeHtml(folder.name)}</div>
              <div class="folder-path-sub">${escapeHtml(pathText)}</div>
            </div>
          </div>
          <div class="folder-item-right">
            <span class="folder-count-badge">播放時自動直讀</span>
            <button class="btn-icon-danger btn-remove-folder" data-id="${folder.id}" title="從列表移除此目錄">✕</button>
          </div>
        </li>
      `);
    });

    if (itemsHtml.length === 0) {
      dom.folderList.innerHTML = `<li class="empty-state">尚未加入任何照片目錄，請點擊上方「📂 瀏覽並加入本機照片目錄」或貼上資料夾路徑</li>`;
    } else {
      dom.folderList.innerHTML = itemsHtml.join('');
    }

    dom.folderList.querySelectorAll('.btn-remove-folder').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-id');
        state.folders.delete(id);
        renderFolderList();
        savePersistedSettings();
      });
    });

    const count = state.folders.size;
    dom.folderSummaryBadge.textContent = `已選定 ${count} 個照片目錄`;
    dom.btnClearFolders.disabled = count === 0;
    dom.btnStartTop.disabled = count === 0;
    dom.btnStartMain.disabled = count === 0;
  }

  // ================= 2. 背景音樂直讀與無限循環播放 =================
  function setMusicTracks(tracks, shouldPersist = true) {
    state.musicTracks = tracks;
    state.currentMusicIndex = 0;

    // 記錄至歷史曾選過的音樂清單
    for (const t of tracks) {
      if (t.type === 'server-path' && t.fullPath) {
        addRecentMusicRecord(t.fullPath, t.name);
      }
    }

    const first = tracks[0];
    const extra = tracks.length > 1 ? ` 等 ${tracks.length} 首循環` : ' (無限重覆播放 Loop)';

    dom.musicFilename.textContent = `${first.name}${extra}`;
    dom.musicMeta.textContent = first.type === 'server-path'
      ? `本機直讀路徑：${first.fullPath}`
      : '本機音訊直讀 ‧ 照片播放時自動重覆播放';
    dom.musicDropZone.classList.add('has-music');
    dom.btnClearMusic.hidden = false;

    dom.musicStatusBadge.textContent = `🎵 已設定音樂 (${tracks.length} 首)`;
    dom.musicStatusBadge.className = 'pill-badge badge-success';

    if (shouldPersist) {
      savePersistedSettings();
    }
  }

  function startMusicPlayback() {
    if (state.musicTracks.length === 0) {
      dom.hudMusicName.textContent = '未選取背景音樂';
      return;
    }
    loadAndPlayMusicTrack(0);
  }

  function loadAndPlayMusicTrack(index) {
    if (state.musicTracks.length === 0) return;
    state.currentMusicIndex = index % state.musicTracks.length;
    const track = state.musicTracks[state.currentMusicIndex];

    if (state.musicObjectUrl) {
      URL.revokeObjectURL(state.musicObjectUrl);
      state.musicObjectUrl = null;
    }

    if (track.type === 'server-path') {
      // 直接從本機硬碟串流音樂檔，不需上傳
      dom.bgAudio.src = `/api/file?path=${encodeURIComponent(track.fullPath)}`;
    } else if (track.file) {
      state.musicObjectUrl = URL.createObjectURL(track.file);
      dom.bgAudio.src = state.musicObjectUrl;
    }

    dom.bgAudio.loop = state.musicTracks.length === 1;
    dom.bgAudio.volume = state.isMuted ? 0 : state.volume;
    dom.hudMusicName.textContent = `${track.name} (重覆播放中)`;
    dom.bgAudio.play().catch(() => {});
  }

  dom.bgAudio.addEventListener('ended', () => {
    if (state.musicTracks.length > 1 && state.isPlaying) {
      loadAndPlayMusicTrack(state.currentMusicIndex + 1);
    }
  });

  function clearMusic() {
    dom.bgAudio.pause();
    dom.bgAudio.removeAttribute('src');
    if (state.musicObjectUrl) {
      URL.revokeObjectURL(state.musicObjectUrl);
      state.musicObjectUrl = null;
    }
    state.musicTracks = [];
    dom.musicFilename.textContent = '尚未選擇音樂檔案（可選填）';
    dom.musicMeta.textContent = '支援 MP3, WAV, M4A, OGG, FLAC';
    dom.musicDropZone.classList.remove('has-music');
    dom.btnClearMusic.hidden = true;
    dom.musicStatusBadge.textContent = '未選擇音樂';
    dom.musicStatusBadge.className = 'pill-badge badge-muted';
    dom.hudMusicName.textContent = '無背景音樂';
    savePersistedSettings();
  }

  function setVolume(val) {
    state.volume = Math.max(0, Math.min(1, val));
    if (state.volume > 0) state.isMuted = false;
    dom.setupVolume.value = state.volume;
    dom.hudVolume.value = state.volume;
    dom.setupVolumeLabel.textContent = `${Math.round(state.volume * 100)}%`;
    dom.bgAudio.volume = state.isMuted ? 0 : state.volume;
    updateMuteIcon();
  }

  function toggleMute() {
    state.isMuted = !state.isMuted;
    dom.bgAudio.volume = state.isMuted ? 0 : state.volume;
    updateMuteIcon();
  }

  function updateMuteIcon() {
    if (state.isMuted || state.volume === 0) {
      dom.btnMuteToggle.textContent = '🔇';
    } else if (state.volume < 0.5) {
      dom.btnMuteToggle.textContent = '🔉';
    } else {
      dom.btnMuteToggle.textContent = '🔊';
    }
  }

  // ================= 3. 秒數與不重複進場動畫輪抽引擎 =================
  function updateDurationUI(sec) {
    state.durationSec = sec;
    dom.durationSlider.value = Math.min(30, Math.max(2, sec));
    dom.durationNumber.value = sec;
    dom.hudSecValue.textContent = `${sec}s`;
    document.documentElement.style.setProperty('--slide-duration', `${sec}s`);
  }

  function pickNextDistinctAnimation() {
    if (state.animBag.length === 0) {
      const shuffled = [...ENTRANCE_ANIMATIONS];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      if (shuffled[0].id === state.lastAnimId && shuffled.length > 1) {
        [shuffled[0], shuffled[shuffled.length - 1]] = [shuffled[shuffled.length - 1], shuffled[0]];
      }
      state.animBag = shuffled;
    }

    const chosen = state.animBag.shift();
    state.lastAnimId = chosen.id;
    return chosen;
  }

  // ================= 4. 播放時動態進入選定目錄讀取照片並呈現 =================
  async function buildPlaylistOnDemand() {
    const list = [];
    const serverPaths = [];
    const handleFolders = [];

    state.folders.forEach((folder) => {
      if (folder.type === 'server-path') {
        serverPaths.push(folder.folderPath);
      } else if (folder.type === 'fs-handle') {
        handleFolders.push(folder);
      }
    });

    // A. 從本機直讀伺服器取得選定目錄下的照片檔案路徑清單（不載入照片內容）
    if (serverPaths.length > 0 && isLocalServerMode) {
      const res = await fetch('/api/list-photos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          folders: serverPaths,
          includeSubfolders: state.includeSubfolders
        })
      });
      const data = await res.json();
      if (data.photos && Array.isArray(data.photos)) {
        for (const p of data.photos) {
          list.push({
            type: 'server-path',
            fullPath: p.fullPath,
            name: p.name,
            folderName: p.folderName
          });
        }
      }
    }

    // B. 若有透過 FileSystemDirectoryHandle 加入的目錄，動態列舉 FileHandle
    for (const folder of handleFolders) {
      await collectFileHandlesFromDir(folder.dirHandle, folder.name, list);
    }

    if (state.playOrder === 'shuffle') {
      for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [list[i], list[j]] = [list[j], list[i]];
      }
    }

    return list;
  }

  async function collectFileHandlesFromDir(dirHandle, rootFolderName, outList) {
    const entries = [];
    for await (const entry of dirHandle.values()) {
      entries.push(entry);
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

    for (const entry of entries) {
      if (entry.kind === 'file' && isImageFilename(entry.name)) {
        outList.push({
          type: 'fs-handle',
          fileHandle: entry,
          name: entry.name,
          folderName: rootFolderName
        });
      } else if (entry.kind === 'directory' && state.includeSubfolders) {
        await collectFileHandlesFromDir(entry, rootFolderName, outList);
      }
    }
  }

  async function startPresentation() {
    if (state.folders.size === 0) {
      alert('請先選定至少一個照片目錄！');
      return;
    }

    dom.btnStartMain.disabled = true;
    dom.btnStartMain.textContent = '⏳ 正在進入選定目錄讀取照片...';

    try {
      const playlist = await buildPlaylistOnDemand();
      if (playlist.length === 0) {
        alert('在您選定的目錄列表中沒有找到任何照片檔案（JPG, PNG, WEBP, GIF, BMP）！請確認目錄路徑是否正確。');
        return;
      }

      state.playlist = playlist;
      state.currentIndex = -1;
      state.isPlaying = true;
      state.isPaused = false;

      // 切換至劇院播放器視圖
      dom.setupView.hidden = true;
      dom.playerView.hidden = false;
      dom.playerView.classList.remove('is-paused');
      dom.playerView.classList.toggle('fit-cover', state.fitMode === 'cover');
      dom.photoCaption.hidden = !state.showCaption;
      dom.btnTogglePlay.textContent = '⏸';

      // 啟動背景音樂循環播放
      startMusicPlayback();

      // 直接讀取並顯示第一張照片
      await showSlide(0);
      resetHudIdleTimer();
    } finally {
      dom.btnStartMain.disabled = false;
      dom.btnStartMain.textContent = '▶ 立即從選定目錄讀取照片並開始播放';
    }
  }

  function stopPresentation() {
    state.isPlaying = false;
    state.isPaused = false;
    clearTimeout(state.slideTimer);
    clearTimeout(state.hudHideTimer);

    dom.bgAudio.pause();
    dom.bgAudio.currentTime = 0;

    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }

    if (state.currentPhotoBlobUrl) {
      URL.revokeObjectURL(state.currentPhotoBlobUrl);
      state.currentPhotoBlobUrl = null;
    }
    if (state.prevPhotoBlobUrl) {
      URL.revokeObjectURL(state.prevPhotoBlobUrl);
      state.prevPhotoBlobUrl = null;
    }

    dom.playerView.hidden = true;
    dom.setupView.hidden = false;
  }

  /**
   * 輪到該張照片時，才即時從本機硬碟讀取這張照片出來 Show！
   */
  async function resolvePhotoDisplayUrl(item) {
    if (item.type === 'server-path') {
      // 直接指向本機直讀串流 URL，完全不佔用記憶體也不用預先上傳
      return {
        url: `/api/file?path=${encodeURIComponent(item.fullPath)}`,
        isBlob: false
      };
    } else {
      // FileSystemFileHandle 模式：輪到這張才從磁碟讀取單一檔案
      const file = await item.fileHandle.getFile();
      return {
        url: URL.createObjectURL(file),
        isBlob: true
      };
    }
  }

  async function showSlide(targetIndex) {
    if (!state.isPlaying || state.playlist.length === 0) return;

    clearTimeout(state.slideTimer);

    if (targetIndex >= state.playlist.length) {
      if (state.loopPhotos) {
        targetIndex = 0;
      } else {
        pausePresentation();
        return;
      }
    } else if (targetIndex < 0) {
      targetIndex = state.playlist.length - 1;
    }

    state.currentIndex = targetIndex;
    const item = state.playlist[targetIndex];

    // 1. 讓上一張照片執行平滑退場
    if (dom.imgCurrent.getAttribute('src')) {
      if (state.prevPhotoBlobUrl) {
        URL.revokeObjectURL(state.prevPhotoBlobUrl);
      }
      state.prevPhotoBlobUrl = state.currentPhotoBlobUrl;
      dom.imgPrev.src = dom.imgCurrent.src;
      dom.slidePrev.className = 'slide-wrapper';
      void dom.slidePrev.offsetWidth;
      dom.slidePrev.classList.add('slide-exit');
    }

    // 2. 直接從本機目錄讀取當前這張照片出來呈現
    const resolved = await resolvePhotoDisplayUrl(item);
    state.currentPhotoBlobUrl = resolved.isBlob ? resolved.url : null;

    // 3. 抽取與上一張不同的進場動畫
    const anim = pickNextDistinctAnimation();

    // 4. 更新高斯模糊背景
    updateBlurredBackground(resolved.url);

    // 5. 套用照片與進場動畫
    dom.slideCurrent.className = 'slide-wrapper';
    dom.imgCurrent.src = resolved.url;
    void dom.slideCurrent.offsetWidth;
    dom.slideCurrent.classList.add(anim.id);

    // 6. 更新左下角資訊與底部控制列頁碼框
    dom.captionFolder.textContent = `📁 ${item.folderName}`;
    dom.captionFilename.textContent = item.name;
    dom.captionIndex.textContent = `${targetIndex + 1} / ${state.playlist.length}`;
    dom.captionAnim.textContent = anim.name;

    if (dom.hudJumpInput) {
      dom.hudJumpInput.max = state.playlist.length;
      if (document.activeElement !== dom.hudJumpInput) {
        dom.hudJumpInput.value = targetIndex + 1;
      }
    }
    if (dom.hudTotalPages) {
      dom.hudTotalPages.textContent = `/ ${state.playlist.length} 張`;
    }

    // 7. 啟動倒數計時器
    restartSlideProgressAndTimer(state.durationSec * 1000);
  }

  function updateBlurredBackground(imageUrl) {
    if (state.activeBgLayer === 'A') {
      dom.bgLayerB.style.backgroundImage = `url("${imageUrl}")`;
      dom.bgLayerB.classList.add('active');
      dom.bgLayerA.classList.remove('active');
      state.activeBgLayer = 'B';
    } else {
      dom.bgLayerA.style.backgroundImage = `url("${imageUrl}")`;
      dom.bgLayerA.classList.add('active');
      dom.bgLayerB.classList.remove('active');
      state.activeBgLayer = 'A';
    }
  }

  function restartSlideProgressAndTimer(durationMs) {
    clearTimeout(state.slideTimer);
    state.remainingMs = durationMs;
    state.slideStartTime = performance.now();

    if (!state.isPaused) {
      state.slideTimer = setTimeout(() => {
        showSlide(state.currentIndex + 1);
      }, durationMs);
    }
  }

  function togglePlayPause() {
    if (!state.isPlaying) return;
    if (state.isPaused) {
      resumePresentation();
    } else {
      pausePresentation();
    }
  }

  function pausePresentation() {
    if (state.isPaused) return;
    state.isPaused = true;
    clearTimeout(state.slideTimer);

    const elapsed = performance.now() - state.slideStartTime;
    state.remainingMs = Math.max(300, state.remainingMs - elapsed);

    dom.playerView.classList.add('is-paused');
    dom.btnTogglePlay.textContent = '▶';
    dom.bgAudio.pause();
  }

  function resumePresentation() {
    if (!state.isPaused) return;
    state.isPaused = false;
    state.slideStartTime = performance.now();

    dom.playerView.classList.remove('is-paused');
    dom.btnTogglePlay.textContent = '⏸';

    if (state.musicTracks.length > 0) {
      dom.bgAudio.play().catch(() => {});
    }

    state.slideTimer = setTimeout(() => {
      showSlide(state.currentIndex + 1);
    }, state.remainingMs);
  }

  // ================= 5. 播放器控制列與快捷鍵 =================
  function jumpToPageNumber(pageNum) {
    if (!state.isPlaying || state.playlist.length === 0) return;
    let target = parseInt(pageNum, 10);
    if (isNaN(target)) return;
    target = Math.max(1, Math.min(state.playlist.length, target));
    showSlide(target - 1);
  }

  function handleDirectDigitKeyPress(digit) {
    clearTimeout(state.typedNumberTimer);
    state.typedNumberBuffer += digit;

    dom.directJumpNumber.textContent = `${state.typedNumberBuffer} / ${state.playlist.length}`;
    dom.directJumpOverlay.hidden = false;

    state.typedNumberTimer = setTimeout(() => {
      commitDirectNumberJump();
    }, 1100);
  }

  function commitDirectNumberJump() {
    clearTimeout(state.typedNumberTimer);
    if (!state.typedNumberBuffer) return;
    const targetPage = parseInt(state.typedNumberBuffer, 10);
    state.typedNumberBuffer = '';
    dom.directJumpOverlay.hidden = true;
    jumpToPageNumber(targetPage);
  }

  function bindPlayerEvents() {
    dom.btnExitPlayer.addEventListener('click', stopPresentation);
    dom.btnTogglePlay.addEventListener('click', togglePlayPause);
    dom.btnPrevSlide.addEventListener('click', () => showSlide(state.currentIndex - 1));
    dom.btnNextSlide.addEventListener('click', () => showSlide(state.currentIndex + 1));

    // 底部控制列：直接輸入頁碼跳頁
    dom.btnHudJump.addEventListener('click', () => {
      jumpToPageNumber(dom.hudJumpInput.value);
      dom.hudJumpInput.blur();
    });

    dom.hudJumpInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        jumpToPageNumber(dom.hudJumpInput.value);
        dom.hudJumpInput.blur();
      }
    });

    dom.btnSecMinus.addEventListener('click', () => {
      const nextSec = Math.max(1, state.durationSec - 1);
      updateDurationUI(nextSec);
      if (state.isPlaying && !state.isPaused) {
        restartSlideProgressAndTimer(nextSec * 1000);
      }
    });

    dom.btnSecPlus.addEventListener('click', () => {
      const nextSec = Math.min(120, state.durationSec + 1);
      updateDurationUI(nextSec);
      if (state.isPlaying && !state.isPaused) {
        restartSlideProgressAndTimer(nextSec * 1000);
      }
    });

    dom.btnMuteToggle.addEventListener('click', toggleMute);
    dom.hudVolume.addEventListener('input', (e) => {
      setVolume(parseFloat(e.target.value));
    });

    dom.btnToggleCaption.addEventListener('click', () => {
      state.showCaption = !state.showCaption;
      dom.chkShowCaption.checked = state.showCaption;
      dom.photoCaption.hidden = !state.showCaption;
    });

    dom.btnFullscreen.addEventListener('click', toggleFullscreen);

    dom.playerView.addEventListener('mousemove', resetHudIdleTimer);

    window.addEventListener('keydown', (e) => {
      if (!state.isPlaying) return;
      if (!dom.castModal.hidden && e.key === 'Escape') {
        dom.castModal.hidden = true;
        return;
      }

      resetHudIdleTimer();

      // 若正在播放中且焦點不在輸入框，直接按鍵盤數字 0~9 即可像電視選台一樣跳到該張照片！
      if (/^[0-9]$/.test(e.key) && document.activeElement !== dom.hudJumpInput) {
        e.preventDefault();
        // 避免第一個字按 0
        if (state.typedNumberBuffer === '' && e.key === '0') return;
        handleDirectDigitKeyPress(e.key);
        return;
      }

      if (e.key === 'Enter' && state.typedNumberBuffer !== '') {
        e.preventDefault();
        commitDirectNumberJump();
        return;
      }

      if (e.key === 'Backspace' && state.typedNumberBuffer !== '') {
        e.preventDefault();
        state.typedNumberBuffer = state.typedNumberBuffer.slice(0, -1);
        if (state.typedNumberBuffer === '') {
          clearTimeout(state.typedNumberTimer);
          dom.directJumpOverlay.hidden = true;
        } else {
          handleDirectDigitKeyPress('');
        }
        return;
      }

      switch (e.key) {
        case ' ':
          e.preventDefault();
          togglePlayPause();
          break;
        case 'ArrowRight':
          e.preventDefault();
          showSlide(state.currentIndex + 1);
          break;
        case 'ArrowLeft':
          e.preventDefault();
          showSlide(state.currentIndex - 1);
          break;
        case 'f':
        case 'F':
          e.preventDefault();
          toggleFullscreen();
          break;
        case 'm':
        case 'M':
          e.preventDefault();
          toggleMute();
          break;
        case 'i':
        case 'I':
          e.preventDefault();
          dom.btnToggleCaption.click();
          break;
        case 'Escape':
          e.preventDefault();
          stopPresentation();
          break;
      }
    });
  }

  function resetHudIdleTimer() {
    dom.playerView.classList.remove('cursor-hidden');
    clearTimeout(state.hudHideTimer);
    if (state.isPlaying && !state.isPaused) {
      state.hudHideTimer = setTimeout(() => {
        dom.playerView.classList.add('cursor-hidden');
      }, 2500);
    }
  }

  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  }

  // ================= 6. Chromecast 電視投放 =================
  function bindCastEvents() {
    const openCastModal = () => {
      dom.castModal.hidden = false;
      dom.canvasCastStatus.textContent = '';
    };

    dom.btnTopCastGuide.addEventListener('click', openCastModal);
    dom.btnCastTv.addEventListener('click', openCastModal);
    dom.btnCloseCastModal.addEventListener('click', () => {
      dom.castModal.hidden = true;
    });

    dom.castModal.addEventListener('click', (e) => {
      if (e.target === dom.castModal) {
        dom.castModal.hidden = true;
      }
    });

    dom.btnCastFullscreenNow.addEventListener('click', async () => {
      dom.castModal.hidden = true;
      if (!state.isPlaying && state.folders.size > 0) {
        await startPresentation();
      }
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(() => {});
      }
    });

    dom.btnStartCanvasCast.addEventListener('click', startCanvasRemotePlayback);
    dom.btnStopCanvasCast.addEventListener('click', stopCanvasRemotePlayback);
  }

  async function startCanvasRemotePlayback() {
    try {
      if (!state.isPlaying) {
        if (state.folders.size === 0) {
          dom.canvasCastStatus.textContent = '⚠️ 請先在主畫面選定照片目錄後再啟動媒體串流投放。';
          return;
        }
        await startPresentation();
      }

      dom.canvasCastStatus.textContent = '正在建立即時相簿與音軌合成串流...';
      startCanvasRenderLoop();

      const canvasStream = dom.castCanvas.captureStream(30);

      if (state.musicTracks.length > 0) {
        try {
          if (!state.audioCtx) {
            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            state.audioCtx = new AudioContextClass();
            state.audioSourceNode = state.audioCtx.createMediaElementSource(dom.bgAudio);
            state.audioDestNode = state.audioCtx.createMediaStreamDestination();
            state.audioSourceNode.connect(state.audioDestNode);
            state.audioSourceNode.connect(state.audioCtx.destination);
          }
          if (state.audioCtx.state === 'suspended') {
            await state.audioCtx.resume();
          }
          state.audioDestNode.stream.getAudioTracks().forEach(track => canvasStream.addTrack(track));
        } catch (audioErr) {
          console.warn(audioErr);
        }
      }

      dom.castVideo.srcObject = canvasStream;
      dom.castVideo.muted = true;
      await dom.castVideo.play();

      dom.btnStartCanvasCast.hidden = true;
      dom.btnStopCanvasCast.hidden = false;
      dom.castActiveIndicator.hidden = false;

      if (dom.castVideo.remote && typeof dom.castVideo.remote.prompt === 'function') {
        await dom.castVideo.remote.prompt();
        dom.canvasCastStatus.textContent = '✅ 已成功連接 Chromecast 媒體投放！';
      } else {
        dom.canvasCastStatus.textContent = '✅ 媒體串流已啟動！請直接在網頁按右鍵選「投放... (Cast...)」選擇您的電視。';
      }
    } catch (err) {
      dom.canvasCastStatus.textContent = `💡 提示：請直接使用上方「方式一：按右鍵 ➔ 投放 (Cast)」即可完美投放此分頁！`;
    }
  }

  function startCanvasRenderLoop() {
    state.isCanvasCasting = true;
    const ctx = dom.castCanvas.getContext('2d');
    const W = dom.castCanvas.width;
    const H = dom.castCanvas.height;

    const renderFrame = () => {
      if (!state.isCanvasCasting) return;

      ctx.fillStyle = '#080a10';
      ctx.fillRect(0, 0, W, H);

      const img = dom.imgCurrent;
      if (img && img.complete && img.naturalWidth > 0) {
        ctx.save();
        ctx.filter = 'blur(28px) brightness(0.4)';
        ctx.drawImage(img, -40, -40, W + 80, H + 80);
        ctx.restore();

        const scale = Math.min((W * 0.94) / img.naturalWidth, (H * 0.92) / img.naturalHeight);
        const drawW = img.naturalWidth * scale;
        const drawH = img.naturalHeight * scale;
        const drawX = (W - drawW) / 2;
        const drawY = (H - drawH) / 2;

        ctx.save();
        ctx.shadowColor = 'rgba(0,0,0,0.7)';
        ctx.shadowBlur = 30;
        ctx.drawImage(img, drawX, drawY, drawW, drawH);
        ctx.restore();
      }

      state.castAnimFrameId = requestAnimationFrame(renderFrame);
    };

    renderFrame();
  }

  function stopCanvasRemotePlayback() {
    state.isCanvasCasting = false;
    if (state.castAnimFrameId) {
      cancelAnimationFrame(state.castAnimFrameId);
    }
    if (dom.castVideo.srcObject) {
      dom.castVideo.srcObject.getTracks().forEach(t => t.stop());
      dom.castVideo.srcObject = null;
    }
    dom.btnStartCanvasCast.hidden = false;
    dom.btnStopCanvasCast.hidden = true;
    dom.castActiveIndicator.hidden = true;
    dom.canvasCastStatus.textContent = '已停止媒體流合成。';
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  init();
})();
