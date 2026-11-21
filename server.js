/**
 * PhotoPresenter 本機檔案直讀服務 (Local File Streaming Server)
 * -------------------------------------------------------------------------
 * 核心設計：
 * 1. 完全不需「上傳」照片或音樂！前端僅指定本機資料夾路徑（例如 D:\Photos\Trip），
 *    或呼叫 Windows 原生資料夾選擇視窗取得本機路徑。
 * 2. 播放時，直接透過本機檔案路徑 (GET /api/file?path=...) 即時從硬碟串流讀取該張照片，
 *    就算資料夾裡有 10 萬張高畫質照片也完全不佔記憶體、秒選秒播！
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const url = require('url');

const PORT = 3579;
const ROOT_DIR = __dirname;
const SETTINGS_FILE = path.join(ROOT_DIR, 'user_settings.json');

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif']);
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac', '.webm']);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.webm': 'audio/webm'
};

/**
 * 呼叫 Windows 原生資料夾選擇器 (可多選或單選本機目錄，完全不會有 Chrome 的「上傳檔案」提示)
 */
function pickNativeFolderDialog() {
  return new Promise((resolve) => {
    const psScript = `
      [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
      Add-Type -AssemblyName System.Windows.Forms
      $f = New-Object System.Windows.Forms.OpenFileDialog
      $f.ValidateNames = $false
      $f.CheckFileExists = $false
      $f.CheckPathExists = $true
      $f.Title = '請選擇照片目錄 (進入資料夾後直接點「開啟」)'
      $f.FileName = '選擇此照片目錄'
      $dummy = New-Object System.Windows.Forms.Form
      $dummy.TopMost = $true
      if ($f.ShowDialog($dummy) -eq [System.Windows.Forms.DialogResult]::OK) {
        $p = Split-Path $f.FileName -Parent
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($p)
        Write-Output ([Convert]::ToBase64String($bytes))
      }
    `;
    execFile(
      'powershell.exe',
      ['-NoProfile', '-STA', '-Command', psScript],
      { encoding: 'utf8', windowsHide: true },
      (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        const b64 = (stdout || '').trim();
        if (!b64) {
          resolve(null);
          return;
        }
        try {
          const decoded = Buffer.from(b64, 'base64').toString('utf8').trim();
          resolve(decoded || null);
        } catch (e) {
          resolve(null);
        }
      }
    );
  });
}

/**
 * 呼叫 Windows 原生音樂檔選擇器 (直接回傳本機音樂檔路徑，不需上傳，UTF-8 Base64 防中文亂碼)
 */
function pickNativeAudioDialog() {
  return new Promise((resolve) => {
    const psScript = `
      [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
      Add-Type -AssemblyName System.Windows.Forms
      $f = New-Object System.Windows.Forms.OpenFileDialog
      $f.Title = '請選擇背景音樂檔 (可多選)'
      $f.Filter = '音樂檔案 (*.mp3;*.wav;*.m4a;*.ogg;*.flac;*.aac)|*.mp3;*.wav;*.m4a;*.ogg;*.flac;*.aac|所有檔案 (*.*)|*.*'
      $f.Multiselect = $true
      $dummy = New-Object System.Windows.Forms.Form
      $dummy.TopMost = $true
      if ($f.ShowDialog($dummy) -eq [System.Windows.Forms.DialogResult]::OK) {
        $f.FileNames | ForEach-Object {
          $bytes = [System.Text.Encoding]::UTF8.GetBytes($_)
          Write-Output ([Convert]::ToBase64String($bytes))
        }
      }
    `;
    execFile(
      'powershell.exe',
      ['-NoProfile', '-STA', '-Command', psScript],
      { encoding: 'utf8', windowsHide: true },
      (err, stdout) => {
        if (err) {
          resolve([]);
          return;
        }
        const files = (stdout || '')
          .split(/\r?\n/)
          .map(s => s.trim())
          .filter(Boolean)
          .map(b64 => Buffer.from(b64, 'base64').toString('utf8').trim())
          .filter(Boolean);
        resolve(files);
      }
    );
  });
}

/**
 * 動態掃描指定本機目錄下的照片檔案路徑清單（僅回傳檔案路徑字串，不載入照片內容）
 */
function scanDirectoryForPhotos(dirPath, includeSubfolders = true) {
  const results = [];
  const rootName = path.basename(dirPath) || dirPath;

  function walk(currentDir, depth) {
    let entries;
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch (e) {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (IMAGE_EXTS.has(ext)) {
          results.push({
            fullPath,
            name: entry.name,
            folderName: rootName
          });
        }
      } else if (entry.isDirectory() && includeSubfolders) {
        walk(fullPath, depth + 1);
      }
    }
  }

  walk(dirPath, 0);

  // 依檔名自然排序
  results.sort((a, b) => a.fullPath.localeCompare(b.fullPath, undefined, { numeric: true }));
  return results;
}

/**
 * 處理 JSON API 回應
 */
function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

/**
 * 處理本機實體檔案串流 (支援 Range requests 供音樂循環播放與圖片直讀)
 */
function streamLocalFile(req, res, filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end('File not found');
    return;
  }

  let stat;
  try {
    stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      res.writeHead(404);
      res.end('Not a file');
      return;
    }
  } catch (e) {
    res.writeHead(500);
    res.end('Error reading file');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  // 支援音訊 Range Request
  const range = req.headers.range;
  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
    const chunkSize = end - start + 1;

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': contentType
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': stat.size,
      'Content-Type': contentType,
      'Cache-Control': 'no-cache'
    });
    fs.createReadStream(filePath).pipe(res);
  }
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // 1. API: 開啟 Windows 原生目錄選擇視窗（只取目錄路徑，不上傳任何檔案）
  if (pathname === '/api/pick-folder' && req.method === 'POST') {
    const folderPath = await pickNativeFolderDialog();
    if (!folderPath) {
      return sendJson(res, 200, { cancelled: true });
    }
    return sendJson(res, 200, {
      cancelled: false,
      folderPath,
      folderName: path.basename(folderPath) || folderPath
    });
  }

  // 2. API: 開啟 Windows 原生音樂檔選擇視窗（只取音樂本機路徑，不上傳）
  if (pathname === '/api/pick-music' && req.method === 'POST') {
    const files = await pickNativeAudioDialog();
    if (!files || files.length === 0) {
      return sendJson(res, 200, { cancelled: true });
    }
    const items = files.map(f => ({
      fullPath: f,
      name: path.basename(f)
    }));
    return sendJson(res, 200, { cancelled: false, files: items });
  }

  // 3. API: 驗證並快速檢查本機目錄資訊 (當使用者直接貼上目錄路徑或選取目錄後)
  if (pathname === '/api/check-folder' && req.method === 'GET') {
    const dirPath = (parsedUrl.query.path || '').trim().replace(/^"(.*)"$/, '$1');
    const includeSub = parsedUrl.query.sub !== 'false';

    if (!dirPath || !fs.existsSync(dirPath)) {
      return sendJson(res, 400, { error: '找不到此本機目錄路徑，請確認路徑是否正確。' });
    }
    try {
      const stat = fs.statSync(dirPath);
      if (!stat.isDirectory()) {
        return sendJson(res, 400, { error: '此路徑不是一個資料夾。' });
      }
      const photos = scanDirectoryForPhotos(dirPath, includeSub);
      return sendJson(res, 200, {
        folderPath: dirPath,
        folderName: path.basename(dirPath) || dirPath,
        photoCount: photos.length,
        firstPhotoPath: photos.length > 0 ? photos[0].fullPath : null
      });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  // 4. API: 開始播放時，即時從選定的目錄列表中取得最新照片清單 (動態直讀，採用 Buffer 確保中文 UTF-8 絕不截斷)
  if (pathname === '/api/list-photos' && req.method === 'POST') {
    const chunks = [];
    req.on('data', chunk => { chunks.push(chunk); });
    req.on('end', () => {
      try {
        const bodyStr = Buffer.concat(chunks).toString('utf8');
        const { folders = [], includeSubfolders = true } = JSON.parse(bodyStr || '{}');
        const allPhotos = [];
        for (const dirPath of folders) {
          if (fs.existsSync(dirPath)) {
            const list = scanDirectoryForPhotos(dirPath, includeSubfolders);
            allPhotos.push(...list);
          }
        }
        return sendJson(res, 200, { photos: allPhotos });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    });
    return;
  }

  // 5. API: 直接從本機硬碟讀取單張照片或音樂檔出來 Show (不預先上傳)
  if (pathname === '/api/file' && req.method === 'GET') {
    const filePath = parsedUrl.query.path;
    return streamLocalFile(req, res, filePath);
  }

  // 5.1 API: 讀取與儲存使用者上次選過的目錄、音樂與歷史紀錄 (持久化於 user_settings.json)
  if (pathname === '/api/settings' && req.method === 'GET') {
    if (fs.existsSync(SETTINGS_FILE)) {
      try {
        const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
        return sendJson(res, 200, JSON.parse(raw));
      } catch (e) {
        return sendJson(res, 200, {});
      }
    }
    return sendJson(res, 200, {});
  }

  if (pathname === '/api/settings' && req.method === 'POST') {
    const chunks = [];
    req.on('data', chunk => { chunks.push(chunk); });
    req.on('end', () => {
      try {
        const bodyStr = Buffer.concat(chunks).toString('utf8');
        const parsed = JSON.parse(bodyStr || '{}');
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(parsed, null, 2), 'utf8');
        return sendJson(res, 200, { ok: true });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    });
    return;
  }

  // 6. 靜態網頁檔案 (index.html, styles.css, app.js)
  let safePath = pathname === '/' ? '/index.html' : pathname;
  const fullStaticPath = path.join(ROOT_DIR, path.normalize(safePath));
  if (fullStaticPath.startsWith(ROOT_DIR) && fs.existsSync(fullStaticPath) && fs.statSync(fullStaticPath).isFile()) {
    return streamLocalFile(req, res, fullStaticPath);
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  const appUrl = `http://localhost:${PORT}`;
  console.log('==============================================================');
  console.log(`🎬 PhotoPresenter 本機直讀服務已啟動： ${appUrl}`);
  console.log('📂 直接讀取本機硬碟目錄照片與音樂，完全不需上傳檔案！');
  console.log('==============================================================');

  // 若帶入 --open 參數則自動用 Chrome 打開
  if (process.argv.includes('--open')) {
    execFile('cmd.exe', ['/c', 'start', 'chrome', appUrl], (err) => {
      if (err) {
        execFile('cmd.exe', ['/c', 'start', '', appUrl]);
      }
    });
  }
});
