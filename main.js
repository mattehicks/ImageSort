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
        key: section.values.Key || id
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
    const excludeSet = new Set((excludeFolders || []).filter(Boolean).map(normPath));
    const out = [];
    await collectImages(folderPath, folderPath, !!includeSubfolders, excludeSet, out);
    return out;
  } catch (error) {
    console.error('Error loading images:', error);
    return [];
  }
});

// Move a viewed-but-unsorted image to the skipped folder: skippedFolder when
// set, otherwise <rootFolder>\skipped.
// Never overwrites: a name clash gets " (1)", " (2)", ... appended.
ipcMain.handle('move-to-skipped', async (event, sourcePath, rootFolder, skippedFolder) => {
  const destFolder = skippedFolder || path.join(rootFolder, SKIPPED_FOLDER_NAME);
  // Already browsing a skipped folder: leave images where they are
  if (path.basename(path.resolve(rootFolder)).toLowerCase() === SKIPPED_FOLDER_NAME ||
      normPath(rootFolder) === normPath(destFolder)) {
    return { success: false, noop: true };
  }
  try {
    await fs.mkdir(destFolder, { recursive: true });

    const ext = path.extname(sourcePath);
    const base = path.basename(sourcePath, ext);
    let destPath = path.join(destFolder, base + ext);
    for (let n = 1; fsSync.existsSync(destPath); n++) {
      destPath = path.join(destFolder, `${base} (${n})${ext}`);
    }

    try {
      await fs.rename(sourcePath, destPath);
    } catch (err) {
      if (err.code !== 'EXDEV') throw err;
      // Different drive: copy (never overwriting), then remove the original
      await fs.copyFile(sourcePath, destPath, fsSync.constants.COPYFILE_EXCL);
      await fs.unlink(sourcePath);
    }
    return { success: true, newPath: destPath };
  } catch (error) {
    console.error('Error moving to skipped:', error);
    return { success: false, error: error.message };
  }
});

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

// Copy (not move) an image into a destination folder. Never overwrites.
ipcMain.handle('copy-file', async (event, sourcePath, destFolder) => {
  try {
    await fs.mkdir(destFolder, { recursive: true });
    const destPath = path.join(destFolder, path.basename(sourcePath));
    if (fsSync.existsSync(destPath)) {
      return { success: false, alreadyExists: true, error: 'File already exists in destination' };
    }
    await fs.copyFile(sourcePath, destPath, fsSync.constants.COPYFILE_EXCL);
    return { success: true, newPath: destPath };
  } catch (error) {
    console.error('Error copying file:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('move-file', async (event, sourcePath, destFolder) => {
  try {
    // Create destination folder if it doesn't exist
    if (!fsSync.existsSync(destFolder)) {
      await fs.mkdir(destFolder, { recursive: true });
    }

    const fileName = path.basename(sourcePath);
    const destPath = path.join(destFolder, fileName);

    // Check if file already exists
    if (fsSync.existsSync(destPath)) {
      return { 
        success: false, 
        error: 'File already exists in destination folder' 
      };
    }

    await fs.rename(sourcePath, destPath);
    return { success: true, newPath: destPath };
  } catch (error) {
    console.error('Error moving file:', error);
    return { success: false, error: error.message };
  }
});

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

ipcMain.handle('select-source-folder', async (event, excludeFolders) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  });
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

ipcMain.handle('delete-file', async (event, filePath) => {
  try {
    await shell.trashItem(filePath);
    return { success: true };
  } catch (error) {
    console.error('Error deleting file:', error);
    return { success: false, error: error.message };
  }
});
