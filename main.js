const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const os = require('os');
const { execFile } = require('child_process');

let mainWindow;

// Config is stored in the registry under HKCU\Software\D20 Image Viewer:
//   SortBy, SortOrder                            (REG_SZ)
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
  sortOrder: 'asc'
};

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

ipcMain.handle('load-images', async (event, folderPath) => {
  try {
    const files = await fs.readdir(folderPath);
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'];
    
    const imageNames = files.filter(file => {
      const ext = path.extname(file).toLowerCase();
      return imageExtensions.includes(ext);
    });

    const imageFiles = await Promise.all(imageNames.map(async file => {
      const fullPath = path.join(folderPath, file);
      try {
        const stat = await fs.stat(fullPath);
        return {
          path: fullPath,
          name: file,
          ext: path.extname(file).toLowerCase(),
          mtime: stat.mtimeMs,
          birthtime: stat.birthtimeMs,
          size: stat.size
        };
      } catch (err) {
        return null;
      }
    }));

    return imageFiles.filter(Boolean);
  } catch (error) {
    console.error('Error loading images:', error);
    return [];
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
