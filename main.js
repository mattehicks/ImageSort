const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const os = require('os');
const { execFile } = require('child_process');

let mainWindow;

// Config is stored in the registry under HKCU\Software\D20 Image Viewer:
//   SortBy, SortOrder, AutoMoveSkipped ("1"/"0") (REG_SZ)
//   SkippedFolder ("" = "skipped" in opened folder) (REG_SZ)
//   ShowFolderName ("1"/"0")                     (REG_SZ)
//   Destinations\<id>\Name, Path, Key            (REG_SZ)
// The source folder is NOT persisted; the app starts with no folder loaded.
// Reads use `reg export` and writes use `reg import` with UTF-16 .reg data,
// so paths with non-ASCII characters round-trip correctly.
const REG_KEY = 'HKEY_CURRENT_USER\\Software\\D20 Image Viewer';
const REG_DEST_KEY = REG_KEY + '\\Destinations';

// Seed sources for first run
const OLD_REG_KEY = 'HKEY_CURRENT_USER\\Software\\Image Viewer';
const BUNDLED_CONFIG_PATH = path.join(__dirname, 'config.json');
const LEGACY_CONFIG_PATH = path.join(app.getPath('appData'), 'D20 Image Viewer', 'config.json');

const DEFAULT_CONFIG = {
  sourceFolder: '',
  destinationFolders: {
    '1': { name: '', path: '', key: '1' },
    '2': { name: '', path: '', key: '2' },
    '3': { name: '', path: '', key: '3' }
  },
  sortBy: 'name',
  sortOrder: 'asc',
  autoMoveSkipped: false,
  skippedFolder: '', // '' = "skipped" inside the opened folder
  showFolderName: false
};

const SKIPPED_FOLDER_NAME = 'skipped';

// Set a file's modified date to now (used after every move/copy, so a folder
// sorted by date modified shows the order images were categorized in).
// A failure here never fails the move itself.
async function touchModified(filePath) {
  try {
    const stat = await fs.stat(filePath);
    await fs.utimes(filePath, stat.atime, new Date());
  } catch (err) {
    console.error('Could not update modified date:', filePath, err);
  }
}

// Windows system folders: never scanned and don't count as subfolders.
// "$..." anywhere; the named ones only at a drive root (e.g. E:\).
const ROOT_SYSTEM_FOLDERS = new Set(['system volume information', 'recovery', 'config.msi', 'msocache']);
function isSystemFolder(parentDir, name) {
  if (name.startsWith('$')) return true;
  const resolved = path.resolve(parentDir);
  const atDriveRoot = path.parse(resolved).root.toLowerCase() === resolved.toLowerCase(); // "E:\" === "E:\"
  return atDriveRoot && ROOT_SYSTEM_FOLDERS.has(name.toLowerCase());
}

async function readJson(filePath) {
  const data = await fs.readFile(filePath, 'utf8');
  return JSON.parse(data);
}

function runReg(args) {
  return new Promise((resolve, reject) => {
    execFile('reg.exe', args, { windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        err.message += (stderr ? ' ' + stderr.trim() : '');
        reject(err);
      } else {
        resolve(stdout);
      }
    });
  });
}

function tmpRegFile() {
  return path.join(os.tmpdir(), `imgv-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.reg`);
}

function regEscape(value) {
  return String(value == null ? '' : value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function regUnescape(value) {
  return value.replace(/\\(.)/g, '$1');
}

async function readRegistryConfig(regKey = REG_KEY) {
  const file = tmpRegFile();
  try {
    try {
      await runReg(['export', regKey, file, '/y']);
    } catch (e) {
      return null; // key does not exist yet
    }
    const text = (await fs.readFile(file)).toString('utf16le').replace(/^\uFEFF/, '');

    const sections = {};
    let current = null;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      const sec = line.match(/^\[(.+)\]$/);
      if (sec) {
        current = sections[sec[1].toLowerCase()] = { name: sec[1], values: {} };
        continue;
      }
      const val = line.match(/^"((?:[^"\\]|\\.)*)"="((?:[^"\\]|\\.)*)"$/);
      if (val && current) current.values[regUnescape(val[1])] = regUnescape(val[2]);
    }

    const root = sections[regKey.toLowerCase()];
    if (!root) return null;

    const config = {
      sourceFolder: root.values.SourceFolder || '',
      sortBy: root.values.SortBy || DEFAULT_CONFIG.sortBy,
      sortOrder: root.values.SortOrder || DEFAULT_CONFIG.sortOrder,
      autoMoveSkipped: root.values.AutoMoveSkipped === '1',
      skippedFolder: root.values.SkippedFolder || '',
      showFolderName: root.values.ShowFolderName === '1',
      destinationFolders: {}
    };

    const destPrefix = (regKey + '\\Destinations').toLowerCase() + '\\';
    for (const [lowerName, section] of Object.entries(sections)) {
      if (!lowerName.startsWith(destPrefix)) continue;
      const id = section.name.slice(destPrefix.length);
      if (!id || id.includes('\\')) continue;
      config.destinationFolders[id] = {
        name: section.values.Name || '',
        path: section.values.Path || '',
        key: section.values.Key || id,
        action: section.values.Action === 'delete' ? 'delete' : 'move'
      };
    }
    if (Object.keys(config.destinationFolders).length === 0) {
      config.destinationFolders = JSON.parse(JSON.stringify(DEFAULT_CONFIG.destinationFolders));
    }
    return config;
  } finally {
    fs.unlink(file).catch(() => {});
  }
}

async function writeRegistryConfig(config) {
  const lines = [
    'Windows Registry Editor Version 5.00',
    '',
    `[-${REG_KEY}]`, // clear old values/destinations, then rewrite
    '',
    `[${REG_KEY}]`,
    `"SortBy"="${regEscape(config.sortBy || DEFAULT_CONFIG.sortBy)}"`,
    `"SortOrder"="${regEscape(config.sortOrder || DEFAULT_CONFIG.sortOrder)}"`,
    `"AutoMoveSkipped"="${config.autoMoveSkipped ? '1' : '0'}"`,
    `"SkippedFolder"="${regEscape(config.skippedFolder || '')}"`,
    `"ShowFolderName"="${config.showFolderName ? '1' : '0'}"`,
    ''
  ];
  for (const [id, dest] of Object.entries(config.destinationFolders || {})) {
    const safeId = String(id).replace(/[\\\[\]]/g, '_');
    lines.push(
      `[${REG_DEST_KEY}\\${safeId}]`,
      `"Name"="${regEscape(dest.name)}"`,
      `"Path"="${regEscape(dest.path)}"`,
      `"Key"="${regEscape(dest.key)}"`,
      `"Action"="${dest.action === 'delete' ? 'delete' : 'move'}"`,
      ''
    );
  }
  const file = tmpRegFile();
  try {
    await fs.writeFile(file, '\uFEFF' + lines.join('\r\n') + '\r\n', 'utf16le');
    await runReg(['import', file]);
  } finally {
    fs.unlink(file).catch(() => {});
  }
}

// Serialize writes so rapid saves can't interleave
let writeQueue = Promise.resolve();
function queueWrite(config) {
  const snapshot = JSON.parse(JSON.stringify(config));
  const p = writeQueue.then(() => writeRegistryConfig(snapshot));
  writeQueue = p.catch(() => {});
  return p;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    backgroundColor: '#1e1e1e'
  });

  mainWindow.loadFile('index.html');
  mainWindow.setMenuBarVisibility(false);
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});

// IPC Handlers
ipcMain.handle('load-config', async () => {
  // 1. Registry (persists between sessions)
  try {
    const config = await readRegistryConfig();
    if (config) return { ...config, sourceFolder: '' }; // source folder is never remembered
  } catch (error) {
    console.error('Error reading registry config:', error);
  }

  // 2. First run: migrate from the "Image Viewer" registry key, then the
  //    previous build's %APPDATA% file, then the bundled config.json, then defaults.
  let config = null;
  let fromOldKey = false;
  let fromLegacy = false;
  try {
    config = await readRegistryConfig(OLD_REG_KEY);
    if (config) fromOldKey = true;
  } catch (e) {
    config = null;
  }
  if (!config) {
    try {
      config = await readJson(LEGACY_CONFIG_PATH);
      fromLegacy = true;
    } catch (e) {
      try {
        config = await readJson(BUNDLED_CONFIG_PATH);
      } catch (e2) {
        config = null;
      }
    }
  }
  config = { ...JSON.parse(JSON.stringify(DEFAULT_CONFIG)), ...(config || {}), sourceFolder: '' };

  try {
    await queueWrite(config);
    if (fromOldKey) {
      await runReg(['delete', OLD_REG_KEY, '/f']).catch(() => {});
    }
    if (fromLegacy) {
      await fs.unlink(LEGACY_CONFIG_PATH).catch(() => {});
      await fs.unlink(LEGACY_CONFIG_PATH + '.tmp').catch(() => {});
    }
  } catch (error) {
    console.error('Error writing initial registry config:', error);
  }
  return config;
});

ipcMain.handle('save-config', async (event, config) => {
  try {
    await queueWrite(config);
    return { success: true };
  } catch (error) {
    console.error('Error saving config:', error);
    return { success: false, error: error.message };
  }
});

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'];

function normPath(p) {
  return path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
}

// Collect image files in dir; when recursive, descend into subfolders,
// skipping symlinks/junctions and any folder listed in excludeSet.
async function collectImages(rootPath, dirPath, recursive, excludeSet, out) {
  let entries;
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch (err) {
    return; // unreadable folder: skip
  }

  const subdirs = [];
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    const isImage = IMAGE_EXTENSIONS.includes(path.extname(entry.name).toLowerCase());
    if (entry.isSymbolicLink()) {
      if (isImage) files.push(fullPath); // linked folders are never followed
      continue;
    }
    if (entry.isDirectory()) {
      // Any folder named "skipped" is left out of the scan. The opened folder
      // itself is never excluded, so picking a skipped folder directly loads it.
      if (entry.name.toLowerCase() === SKIPPED_FOLDER_NAME) continue;
      if (isSystemFolder(dirPath, entry.name)) continue;
      if (recursive && !excludeSet.has(normPath(fullPath))) subdirs.push(fullPath);
    } else if (entry.isFile() && isImage) {
      files.push(fullPath);
    }
  }

  const stats = await Promise.all(files.map(async fullPath => {
    try {
      const stat = await fs.stat(fullPath);
      const name = path.basename(fullPath);
      return {
        path: fullPath,
        name: name,
        relPath: path.relative(rootPath, fullPath),
        ext: path.extname(name).toLowerCase(),
        mtime: stat.mtimeMs,
        birthtime: stat.birthtimeMs,
        size: stat.size
      };
    } catch (err) {
      return null;
    }
  }));
  for (const s of stats) if (s) out.push(s);

  for (const sub of subdirs) {
    await collectImages(rootPath, sub, recursive, excludeSet, out);
  }
}

ipcMain.handle('load-images', async (event, folderPath, includeSubfolders, excludeFolders) => {
  try {
    // Let queued background moves/copies finish so the scan sees final state
    await fileOpQueue;
    const excludeSet = new Set((excludeFolders || []).filter(Boolean).map(normPath));
    const out = [];
    await collectImages(folderPath, folderPath, !!includeSubfolders, excludeSet, out);
    return out;
  } catch (error) {
    console.error('Error loading images:', error);
    return [];
  }
});

// ---- File operations: queued, collision-safe -----------------------------

// Run file operations one at a time, in order. The renderer doesn't wait on
// them (moves/copies/skips update the view immediately), so this keeps two
// operations from claiming the same "name (n)" or touching the same file.
let fileOpQueue = Promise.resolve();
function queueFileOp(fn) {
  const p = fileOpQueue.then(fn);
  fileOpQueue = p.catch(() => {});
  return p;
}

// Quick identical-content check: sizes first, then the start, middle and end
// (64 KB each) of both files; files up to 192 KB are compared in full.
const SAMPLE_CHUNK = 64 * 1024;
async function quickIdentical(a, b) {
  const [sa, sb] = await Promise.all([fs.stat(a), fs.stat(b)]);
  if (sa.size !== sb.size) return false;
  if (sa.size === 0) return true;

  const whole = sa.size <= 3 * SAMPLE_CHUNK;
  const len = whole ? sa.size : SAMPLE_CHUNK;
  const offsets = whole ? [0] : [0, Math.floor(sa.size / 2) - SAMPLE_CHUNK / 2, sa.size - SAMPLE_CHUNK];

  const [ha, hb] = await Promise.all([fs.open(a, 'r'), fs.open(b, 'r')]);
  try {
    const bufA = Buffer.alloc(len);
    const bufB = Buffer.alloc(len);
    for (const offset of offsets) {
      await Promise.all([ha.read(bufA, 0, len, offset), hb.read(bufB, 0, len, offset)]);
      if (!bufA.equals(bufB)) return false;
    }
    return true;
  } finally {
    await Promise.all([ha.close(), hb.close()]);
  }
}

// Where sourcePath should land in destFolder:
//   { destPath, identical: false } - free name ("name.jpg" or "name (n).jpg")
//   { destPath, identical: true }  - destFolder already has an identical "name.jpg"
async function resolveDestination(sourcePath, destFolder) {
  const ext = path.extname(sourcePath);
  const base = path.basename(sourcePath, ext);
  const first = path.join(destFolder, base + ext);
  if (!fsSync.existsSync(first)) return { destPath: first, identical: false };
  if (await quickIdentical(sourcePath, first)) return { destPath: first, identical: true };
  let destPath = first;
  for (let n = 1; fsSync.existsSync(destPath); n++) {
    destPath = path.join(destFolder, `${base} (${n})${ext}`);
  }
  return { destPath, identical: false };
}

// Rename, or copy (never overwriting) + delete when crossing drives
async function moveFileTo(sourcePath, destPath) {
  try {
    await fs.rename(sourcePath, destPath);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    await fs.copyFile(sourcePath, destPath, fsSync.constants.COPYFILE_EXCL);
    await fs.unlink(sourcePath);
  }
}

// Move into destFolder. Identical file already there: the source goes to the
// Recycle Bin and the move counts as done. Different file with the same name:
// saved as "name (n).ext".
async function moveIntoFolder(sourcePath, destFolder) {
  await fs.mkdir(destFolder, { recursive: true });
  const srcStat = await fs.stat(sourcePath);
  const sourceTimes = { atimeMs: srcStat.atimeMs, mtimeMs: srcStat.mtimeMs }; // for undo
  const { destPath, identical } = await resolveDestination(sourcePath, destFolder);
  if (identical) {
    const destStat = await fs.stat(destPath);
    const destTimes = { atimeMs: destStat.atimeMs, mtimeMs: destStat.mtimeMs };
    await shell.trashItem(sourcePath);
    await touchModified(destPath);
    return { success: true, duplicate: true, newPath: destPath, sourcePath, sourceTimes, destTimes };
  }
  await moveFileTo(sourcePath, destPath);
  await touchModified(destPath);
  return { success: true, newPath: destPath, sourcePath, sourceTimes, renamed: path.basename(destPath) !== path.basename(sourcePath) };
}

// Move a viewed-but-unsorted image to the skipped folder: skippedFolder when
// set, otherwise <rootFolder>\skipped.
ipcMain.handle('move-to-skipped', (event, sourcePath, rootFolder, skippedFolder) => queueFileOp(async () => {
  const destFolder = skippedFolder || path.join(rootFolder, SKIPPED_FOLDER_NAME);
  // Already browsing a skipped folder: leave images where they are
  if (path.basename(path.resolve(rootFolder)).toLowerCase() === SKIPPED_FOLDER_NAME ||
      normPath(rootFolder) === normPath(destFolder)) {
    return { success: false, noop: true };
  }
  try {
    return await moveIntoFolder(sourcePath, destFolder);
  } catch (error) {
    console.error('Error moving to skipped:', error);
    return { success: false, error: error.message };
  }
}));

// Settings menu (toolbar ⚙ button). Changes are sent back to the renderer,
// which owns the in-memory config and saves it.
ipcMain.handle('show-settings-menu', (event, opts) => {
  const current = (opts && opts.skippedFolder) || '';
  const menuLabel = s => s.replace(/&/g, '&&'); // '&' is a mnemonic marker on Windows
  const template = [
    {
      label: 'Show folder name',
      type: 'checkbox',
      checked: !!(opts && opts.showFolderName),
      click: (item) => event.sender.send('show-folder-name-changed', item.checked)
    },
    { type: 'separator' },
    {
      label: 'Skipped folder location',
      submenu: [
        {
          label: menuLabel('Current: ' + (current || '"skipped" inside the opened folder')),
          enabled: false
        },
        { type: 'separator' },
        {
          label: 'Choose folder…',
          type: 'radio',
          checked: !!current,
          click: async () => {
            const result = await dialog.showOpenDialog(mainWindow, {
              title: 'Skipped folder location',
              properties: ['openDirectory', 'createDirectory']
            });
            if (!result.canceled && result.filePaths.length > 0) {
              event.sender.send('skipped-folder-changed', result.filePaths[0]);
            }
          }
        },
        {
          label: 'Use "skipped" inside the opened folder',
          type: 'radio',
          checked: !current,
          click: () => event.sender.send('skipped-folder-changed', '')
        },
        ...(current ? [{
          label: 'Open current location',
          click: () => shell.openPath(current)
        }] : [])
      ]
    }
  ];
  Menu.buildFromTemplate(template).popup({
    window: mainWindow,
    x: Math.round((opts && opts.x) || 0),
    y: Math.round((opts && opts.y) || 0)
  });
});

// Trim mode: write cropped sections next to the original as
// "<name>_trim<N><ext>", N continuing after any existing _trim files.
// sections: [{ data: Uint8Array, ext: '.png' | '.jpg' | ... }]
ipcMain.handle('save-trim-sections', (event, sourcePath, sections) => queueFileOp(async () => {
  try {
    const dir = path.dirname(sourcePath);
    const base = path.basename(sourcePath, path.extname(sourcePath));
    const prefix = (base + '_trim').toLowerCase();

    // Highest existing _trimN for this image, any extension
    let n = 0;
    for (const entry of await fs.readdir(dir)) {
      const stem = path.basename(entry, path.extname(entry)).toLowerCase();
      if (stem.startsWith(prefix)) {
        const num = Number(stem.slice(prefix.length));
        if (Number.isInteger(num) && num > n) n = num;
      }
    }

    const saved = [];
    for (const section of sections) {
      let target;
      do {
        n++;
        target = path.join(dir, `${base}_trim${n}${section.ext}`);
      } while (fsSync.existsSync(target));
      await fs.writeFile(target, Buffer.from(section.data), { flag: 'wx' }); // never overwrite
      saved.push(target);
    }
    return { success: true, saved };
  } catch (error) {
    console.error('Error saving trim sections:', error);
    return { success: false, error: error.message };
  }
}));

// Copy into destFolder. Identical file already there: nothing written, counts
// as done. Different file with the same name: saved as "name (n).ext".
ipcMain.handle('copy-file', (event, sourcePath, destFolder) => queueFileOp(async () => {
  try {
    await fs.mkdir(destFolder, { recursive: true });
    const { destPath, identical } = await resolveDestination(sourcePath, destFolder);
    if (identical) {
      return { success: true, duplicate: true, newPath: destPath };
    }
    await fs.copyFile(sourcePath, destPath, fsSync.constants.COPYFILE_EXCL);
    await touchModified(destPath);
    return { success: true, newPath: destPath, renamed: path.basename(destPath) !== path.basename(sourcePath) };
  } catch (error) {
    console.error('Error copying file:', error);
    return { success: false, error: error.message };
  }
}));

ipcMain.handle('move-file', (event, sourcePath, destFolder) => queueFileOp(async () => {
  try {
    return await moveIntoFolder(sourcePath, destFolder);
  } catch (error) {
    console.error('Error moving file:', error);
    return { success: false, error: error.message };
  }
}));

// True if dirPath has at least one subfolder the recursive scan would enter
// (not a symlink/junction, not named "skipped", not in excludeFolders).
async function hasScannableSubfolder(dirPath, excludeFolders) {
  const excludeSet = new Set((excludeFolders || []).filter(Boolean).map(normPath));
  let entries;
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch (err) {
    return false;
  }
  return entries.some(entry =>
    entry.isDirectory() &&
    !entry.isSymbolicLink() &&
    entry.name.toLowerCase() !== SKIPPED_FOLDER_NAME &&
    !isSystemFolder(dirPath, entry.name) &&
    !excludeSet.has(normPath(path.join(dirPath, entry.name)))
  );
}

ipcMain.handle('select-source-folder', async (event, excludeFolders, currentFolder) => {
  const options = { properties: ['openDirectory'] };
  // Start the picker at the folder currently open (this session only)
  if (currentFolder && fsSync.existsSync(currentFolder)) options.defaultPath = currentFolder;
  const result = await dialog.showOpenDialog(mainWindow, options);
  if (result.canceled || result.filePaths.length === 0) return null;

  const folder = result.filePaths[0];
  // Nothing to include: open it directly without asking
  if (!(await hasScannableSubfolder(folder, excludeFolders))) {
    return { folder, includeSubfolders: false };
  }

  const answer = await dialog.showMessageBox(mainWindow, {
    type: 'none',
    title: 'Open Folder',
    message: folder,
    checkboxLabel: 'Include subfolders',
    checkboxChecked: false,
    buttons: ['OK', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  });
  if (answer.response !== 0) return null;
  return { folder, includeSubfolders: answer.checkboxChecked };
});

ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  });
  
  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0];
  }
  return null;
});

// Esc: close right away. The window hides immediately; queued background
// moves/copies finish before the process exits so no file is left half-done.
ipcMain.handle('quit-app', async () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
  try {
    await fileOpQueue;
  } catch (e) { /* ignore */ }
  app.quit();
});

// ---- Delete + undo ----------------------------------------------------------

// Deleted images are kept here so U can restore them (the Recycle Bin can't be
// restored from reliably). Cleared at startup and on quit.
const UNDO_CACHE_DIR = path.join(os.tmpdir(), 'd20-image-viewer-undo');
function clearUndoCache() {
  try { fsSync.rmSync(UNDO_CACHE_DIR, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}
clearUndoCache();
app.on('will-quit', clearUndoCache);

ipcMain.handle('delete-file', (event, filePath) => queueFileOp(async () => {
  try {
    const stat = await fs.stat(filePath);
    await fs.mkdir(UNDO_CACHE_DIR, { recursive: true });
    const cachePath = path.join(UNDO_CACHE_DIR,
      `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${path.basename(filePath)}`);
    await fs.copyFile(filePath, cachePath);
    await shell.trashItem(filePath);
    return { success: true, sourcePath: filePath, cachePath, sourceTimes: { atimeMs: stat.atimeMs, mtimeMs: stat.mtimeMs } };
  } catch (error) {
    console.error('Error deleting file:', error);
    return { success: false, error: error.message };
  }
}));

async function restoreTimes(filePath, times) {
  if (!times) return;
  try {
    await fs.utimes(filePath, new Date(times.atimeMs), new Date(times.mtimeMs));
  } catch (err) {
    console.error('Could not restore dates:', filePath, err);
  }
}

// Undo one recorded operation. op = { kind: 'move'|'copy'|'delete', result }
// where result is what the original operation returned.
ipcMain.handle('undo-op', (event, op) => queueFileOp(async () => {
  const r = op && op.result;
  if (!r || !r.success) return { success: false, error: 'Nothing to undo' };
  try {
    if (op.kind === 'move') {
      // Folder-key move or auto-move to skipped: put the file back
      if (fsSync.existsSync(r.sourcePath)) {
        return { success: false, alreadyExists: true, error: 'A file is already at the original location' };
      }
      await fs.mkdir(path.dirname(r.sourcePath), { recursive: true });
      if (r.duplicate) {
        // The source went to the Recycle Bin because an identical file was
        // already in the folder: recreate it from that file, leave that file
        await fs.copyFile(r.newPath, r.sourcePath, fsSync.constants.COPYFILE_EXCL);
        await restoreTimes(r.newPath, r.destTimes);
      } else {
        await moveFileTo(r.newPath, r.sourcePath);
      }
      await restoreTimes(r.sourcePath, r.sourceTimes);
      return { success: true, restoredPath: r.sourcePath };
    }
    if (op.kind === 'copy') {
      // Remove the copy (to the Recycle Bin); an identical file that was
      // already there is left alone
      if (!r.duplicate && fsSync.existsSync(r.newPath)) await shell.trashItem(r.newPath);
      return { success: true };
    }
    if (op.kind === 'delete') {
      if (fsSync.existsSync(r.sourcePath)) {
        return { success: false, alreadyExists: true, error: 'A file is already at the original location' };
      }
      await fs.mkdir(path.dirname(r.sourcePath), { recursive: true });
      await fs.copyFile(r.cachePath, r.sourcePath, fsSync.constants.COPYFILE_EXCL);
      await restoreTimes(r.sourcePath, r.sourceTimes);
      await fs.unlink(r.cachePath).catch(() => {});
      return { success: true, restoredPath: r.sourcePath };
    }
    return { success: false, error: 'Unknown operation' };
  } catch (error) {
    console.error('Error undoing:', error);
    return { success: false, error: error.message };
  }
}));
