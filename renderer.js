const { ipcRenderer } = require('electron');
const path = require('path');

let config = null;
let images = [];
let currentIndex = 0;

// DOM elements
const imageEl = document.getElementById('image');
const imageCounterEl = document.getElementById('image-counter');
const filenameEl = document.getElementById('filename');
const configPanel = document.getElementById('config-panel');
const noImageMsg = document.getElementById('no-image-msg');
const shortcutKeysEl = document.getElementById('shortcut-keys');
const shortcutsPanel = document.getElementById('shortcuts');
const sortSelect = document.getElementById('sort-select');
const sortDirBtn = document.getElementById('sort-dir-btn');
const autoMoveCheckbox = document.getElementById('auto-move-skipped');

let sortBy = 'name';
let sortOrder = 'asc';

// Initialize
async function init() {
    config = await ipcRenderer.invoke('load-config');
    if (config) {
        if (config.sortBy) sortBy = config.sortBy;
        if (config.sortOrder) sortOrder = config.sortOrder;
        autoMoveCheckbox.checked = !!config.autoMoveSkipped;
        updateSortControls();
        await loadImages();
        updateShortcutDisplay();
    }
}

autoMoveCheckbox.addEventListener('change', async () => {
    autoMoveCheckbox.blur(); // return arrow keys to image navigation
    if (!config) return;
    config.autoMoveSkipped = autoMoveCheckbox.checked;
    await ipcRenderer.invoke('save-config', config);
});

// Settings menu
const settingsBtn = document.getElementById('settings-btn');
settingsBtn.addEventListener('click', () => {
    settingsBtn.blur();
    const rect = settingsBtn.getBoundingClientRect();
    ipcRenderer.invoke('show-settings-menu', {
        skippedFolder: config ? config.skippedFolder || '' : '',
        showFolderName: !!(config && config.showFolderName),
        x: rect.left,
        y: rect.bottom
    });
});

ipcRenderer.on('show-folder-name-changed', async (event, checked) => {
    if (!config) return;
    config.showFolderName = checked;
    if (images.length > 0) displayImage();
    await ipcRenderer.invoke('save-config', config);
});

ipcRenderer.on('skipped-folder-changed', async (event, folder) => {
    if (!config) return;
    if ((config.skippedFolder || '') === folder) return;
    config.skippedFolder = folder;
    await ipcRenderer.invoke('save-config', config);
    // The scan excludes the skipped folder, so refresh the list
    if (config.sourceFolder) await loadImages();
});

// Sorting
const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function compareImages(a, b) {
    let result;
    switch (sortBy) {
        case 'mtime':
        case 'birthtime':
        case 'size':
            result = a[sortBy] - b[sortBy];
            break;
        case 'ext':
            result = nameCollator.compare(a.ext, b.ext);
            break;
        case 'order':
            // Order the folder scan returned the files in
            result = a.order - b.order;
            break;
        case 'name':
        default:
            result = 0;
    }
    // Tie-break (and default) by relative path, so subfolders group together
    if (result === 0) result = nameCollator.compare(a.relPath || a.name, b.relPath || b.name);
    return sortOrder === 'desc' ? -result : result;
}

function shuffleImages() {
    // Fisher-Yates
    for (let i = images.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [images[i], images[j]] = [images[j], images[i]];
    }
}

function sortImages(keepCurrent) {
    const currentPath = keepCurrent && images[currentIndex] ? images[currentIndex].path : null;
    if (sortBy === 'random') {
        shuffleImages();
    } else {
        images.sort(compareImages);
    }
    if (currentPath) {
        const idx = images.findIndex(img => img.path === currentPath);
        currentIndex = idx >= 0 ? idx : 0;
    }
}

function updateSortControls() {
    sortSelect.value = sortBy;
    sortDirBtn.textContent = sortOrder === 'asc' ? '↑ Asc' : '↓ Desc';
    sortDirBtn.disabled = sortBy === 'random';
}

// "Processing…" in the filename spot while work runs; filename restored after.
let processingCount = 0;

// Short failure message in the filename spot ("Exists", "Move failed", ...).
// Full error in the tooltip. Clears after 2s or when another image is shown.
let statusTimer = null;

function clearStatus() {
    if (statusTimer) {
        clearTimeout(statusTimer);
        statusTimer = null;
    }
    filenameEl.classList.remove('status-error', 'status-ok');
    filenameEl.title = '';
}

// kind: 'error' (red) or 'ok' (green)
function flashStatus(text, detail, kind = 'error') {
    clearStatus();
    filenameEl.textContent = text;
    filenameEl.title = detail || '';
    filenameEl.classList.add(kind === 'ok' ? 'status-ok' : 'status-error');
    statusTimer = setTimeout(() => {
        clearStatus();
        if (processingCount === 0) refreshFilename();
    }, 2000);
}

function reportFailure(action, result, img) {
    const error = (result && result.error) || 'Unknown error';
    const detail = img ? `${img.name}: ${error}` : error;
    if (result && result.alreadyExists) {
        flashStatus('Exists', detail);
    } else {
        flashStatus(`${action} failed`, detail);
    }
    console.error(`${action} failed:`, detail);
}

function nextPaint() {
    // Let the browser draw the text before synchronous work (sorting) starts
    return new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

function refreshFilename() {
    filenameEl.textContent = images.length > 0 && images[currentIndex]
        ? displayName(images[currentIndex])
        : 'No images';
}

async function withProcessing(fn) {
    processingCount++;
    clearStatus();
    filenameEl.textContent = 'Processing…';
    filenameEl.classList.add('processing');
    await nextPaint();
    try {
        return await fn();
    } finally {
        processingCount--;
        if (processingCount === 0) {
            filenameEl.classList.remove('processing');
            refreshFilename();
        }
    }
}

async function applySort() {
    updateSortControls();
    if (config) {
        config.sortBy = sortBy;
        config.sortOrder = sortOrder;
    }
    // Rescan the folder (like Reload) so the new order uses current file data,
    // then start at the first image
    if (config && config.sourceFolder) {
        await loadImages();
    }
    if (config) {
        await ipcRenderer.invoke('save-config', config);
    }
}

sortSelect.addEventListener('change', () => {
    sortBy = sortSelect.value;
    sortSelect.blur(); // return arrow keys to image navigation
    applySort();
});

sortDirBtn.addEventListener('click', () => {
    sortOrder = sortOrder === 'asc' ? 'desc' : 'asc';
    sortDirBtn.blur();
    applySort();
});

// Folders the scan never enters: destination folders and a custom skipped folder
function scanExcludeFolders() {
    if (!config) return [];
    const list = Object.values(config.destinationFolders || {})
        .filter(d => d.action !== 'delete')
        .map(d => d.path).filter(Boolean);
    if (config.skippedFolder) list.push(config.skippedFolder);
    return list;
}

async function loadImages() {
    if (!config || !config.sourceFolder) {
        showNoImages();
        return;
    }
    await withProcessing(loadImagesNow);
}

async function loadImagesNow() {
    loadGeneration++;
    images = await ipcRenderer.invoke('load-images', config.sourceFolder, !!config.includeSubfolders, scanExcludeFolders());
    images.forEach((img, i) => { img.order = i; }); // scan order, for "As given in selection"
    
    if (images.length > 0) {
        sortImages(false);
        currentIndex = 0;
        displayImage();
        hideNoImages();
    } else {
        showNoImages();
    }
}

function displayImage() {
    if (images.length === 0) {
        showNoImages();
        return;
    }

    const imagePath = images[currentIndex].path;
    clearStatus();
    imageEl.src = imagePath;
    imageCounterEl.textContent = `${currentIndex + 1} / ${images.length}`;
    filenameEl.textContent = displayName(images[currentIndex]);
    hideNoImages();
}

// "Show folder name" on: immediate parent folder + filename (folder/img.png).
// Off: filename only.
function displayName(img) {
    if (!(config && config.showFolderName)) return img.name;
    const parts = img.path.split(/[\\/]+/).filter(Boolean);
    const parent = parts.length >= 2 ? parts[parts.length - 2] : '';
    return parent ? `${parent}/${img.name}` : img.name;
}

function showNoImages() {
    imageEl.style.display = 'none';
    noImageMsg.style.display = 'block';
    imageCounterEl.textContent = '0 / 0';
    filenameEl.textContent = 'No images';
}

function hideNoImages() {
    imageEl.style.display = 'block';
    noImageMsg.style.display = 'none';
}

// Serializes delete so fast key presses can't act on the wrong image
let busy = false;

// Incremented on every folder load; a background failure from an older load
// doesn't put its image back into the new list (the rescan already has it).
let loadGeneration = 0;

// Take the current image out of the list. Returns what's needed to put it back.
function takeCurrent() {
    const idx = currentIndex;
    const img = images[idx];
    images.splice(idx, 1);
    return { img, idx, gen: loadGeneration };
}

// Put an image back after a background operation failed
function restoreImage(taken) {
    if (taken.gen !== loadGeneration || images.includes(taken.img)) return;
    const at = Math.min(taken.idx, images.length);
    images.splice(at, 0, taken.img);
    if (images.length === 1) {
        currentIndex = 0;
        displayImage();
        return;
    }
    if (at <= currentIndex) currentIndex++; // keep the image on screen the same
    imageCounterEl.textContent = `${currentIndex + 1} / ${images.length}`;
}

// After removing images[idx]: show the image that took its place (or wrap)
function showAfterRemoval(idx, step) {
    if (images.length === 0) {
        showNoImages();
        return;
    }
    if (step < 0) {
        currentIndex = (idx - 1 + images.length) % images.length;
    } else {
        currentIndex = idx >= images.length ? (step > 0 ? 0 : images.length - 1) : idx;
    }
    displayImage();
}

// Auto-move does nothing while browsing a skipped folder itself
function browsingSkippedFolder() {
    const src = (config.sourceFolder || '').replace(/[\\/]+$/, '');
    const name = src.split(/[\\/]/).pop().toLowerCase();
    if (name === 'skipped') return true;
    const custom = (config.skippedFolder || '').replace(/[\\/]+$/, '');
    return !!custom && custom.toLowerCase() === src.toLowerCase();
}

// Navigate by step (+1 / -1). With auto-move on, the image being left
// (viewed but not moved/deleted with a key) goes to the skipped folder
// (Settings > Skipped folder location; default <source>\skipped).
// The move runs in the background; the next image shows immediately.
async function navigate(step) {
    if (images.length === 0 || busy) return;

    // Images copied with Shift + folder key are categorized: leave them in place
    if (config && config.autoMoveSkipped && config.sourceFolder &&
        !images[currentIndex].copied && !browsingSkippedFolder()) {
        const taken = takeCurrent();
        showAfterRemoval(taken.idx, step);
        const pending = ipcRenderer.invoke('move-to-skipped', taken.img.path, config.sourceFolder, config.skippedFolder || '');
        recordUndo('move', 'skip', pending, taken);
        const result = await pending;
        if (!result.success) {
            restoreImage(taken);
            if (!result.noop) reportFailure('Skip', result, taken.img);
        }
        return;
    }

    currentIndex = (currentIndex + step + images.length) % images.length;
    displayImage();
}

function nextImage() {
    return navigate(1);
}

function previousImage() {
    return navigate(-1);
}

// Shift + folder key: copy the current image in the background; it stays in
// the list and on screen
async function copyToFolder(destKey) {
    if (images.length === 0 || busy) return;

    const destination = config.destinationFolders[destKey];
    if (!destination || !destination.path) return;

    const img = images[currentIndex];
    const wasCopied = !!img.copied;
    img.copied = true; // exempt from auto-move skipped
    const pending = ipcRenderer.invoke('copy-file', img.path, destination.path);
    recordUndo('copy', 'copy', pending, { img, wasCopied });
    const result = await pending;
    if (!result.success) {
        img.copied = wasCopied;
        reportFailure('Copy', result, img);
    }
}

// Folder key: move the current image in the background; the next image shows
// immediately, and the image comes back if the move fails
async function moveToFolder(destKey) {
    if (images.length === 0 || busy) return;
    
    const destination = config.destinationFolders[destKey];
    if (!destination || !destination.path) return;

    const taken = takeCurrent();
    showAfterRemoval(taken.idx, 0);
    const pending = ipcRenderer.invoke('move-file', taken.img.path, destination.path);
    recordUndo('move', 'move', pending, taken);
    const result = await pending;
    if (!result.success) {
        restoreImage(taken);
        reportFailure('Move', result, taken.img);
    }
}

async function deleteCurrentImage() {
    if (images.length === 0 || busy) return;
    
    busy = true;
    const img = images[currentIndex];
    const ctx = { img, idx: currentIndex, gen: loadGeneration };
    const pending = ipcRenderer.invoke('delete-file', img.path);
    recordUndo('delete', 'delete', pending, ctx);
    const result = await pending.finally(() => { busy = false; });
    
    if (result.success) {
        // Remove from current list (by identity; the list may have shifted)
        const idx = images.indexOf(img);
        if (idx < 0) return;
        images.splice(idx, 1);
        ctx.idx = idx;
        
        // Adjust index
        if (images.length === 0) {
            showNoImages();
        } else {
            if (currentIndex >= images.length) {
                currentIndex = images.length - 1;
            }
            displayImage();
        }
    } else {
        reportFailure('Delete', result, img);
    }
}

// ---- Undo (U) ---------------------------------------------------------------
// Each move / skip / copy / delete is recorded with the promise of its result,
// so U works even while the operation is still finishing in the background.
const UNDO_LIMIT = 50;
const undoStack = [];
let undoing = false;

function recordUndo(kind, label, resultPromise, ctx) {
    // Keep ctx itself (not a copy) so later corrections to ctx.idx apply
    undoStack.push(Object.assign(ctx, { kind, label, resultPromise }));
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
}

async function undoLast() {
    if (undoing) return;
    undoing = true;
    try {
        // Skip entries whose operation failed (those already put themselves back)
        let entry, result;
        while ((entry = undoStack.pop())) {
            result = await entry.resultPromise;
            if (result && result.success) break;
        }
        if (!entry) {
            flashStatus('Nothing to undo');
            return;
        }

        const r = await ipcRenderer.invoke('undo-op', { kind: entry.kind, result });
        if (!r.success) {
            reportFailure('Undo', r, entry.img);
            return;
        }

        if (entry.kind === 'copy') {
            entry.img.copied = entry.wasCopied;
        } else if (entry.gen === loadGeneration && !images.includes(entry.img)) {
            // Put the image back where it was and show it
            const at = Math.min(entry.idx, images.length);
            images.splice(at, 0, entry.img);
            currentIndex = at;
            displayImage();
        }
        flashStatus(`Undone: ${entry.label}`, entry.img.name, 'ok');
    } finally {
        undoing = false;
    }
}

function updateShortcutDisplay() {
    if (!config || !config.destinationFolders) return;
    
    shortcutKeysEl.innerHTML = '';
    
    Object.entries(config.destinationFolders).forEach(([key, folder]) => {
        const isDelete = folder.action === 'delete';
        const shortcutDiv = document.createElement('div');
        shortcutDiv.className = 'shortcut dest-row';
        shortcutDiv.innerHTML = `
            <span class="key"></span>
            <span class="label"></span>
            <button class="dest-btn dest-set">Set</button>
            <button class="dest-btn dest-delete">Delete</button>
        `;
        shortcutDiv.querySelector('.key').textContent = folder.key;
        const labelEl = shortcutDiv.querySelector('.label');
        labelEl.textContent = isDelete ? 'Delete' : (folder.name || 'Not set');
        if (!isDelete && folder.path) labelEl.title = folder.path;
        shortcutDiv.querySelectorAll('button').forEach(b => { b.dataset.key = key; });
        shortcutDiv.querySelector('.dest-delete').classList.toggle('active', isDelete);
        shortcutKeysEl.appendChild(shortcutDiv);
    });
}

// Keyboard handlers
document.addEventListener('keydown', (e) => {
    // Don't handle keys if config panel is open
    if (configPanel.classList.contains('active')) return;
    // Don't handle keys while a form control (e.g. sort dropdown) has focus
    if (['SELECT', 'INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;

    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        // With auto-move on, a held-down arrow key must not sweep images into skipped
        if (e.repeat && config && config.autoMoveSkipped) return;
        if (e.key === 'ArrowRight') nextImage(); else previousImage();
    } else if ((e.key === 'u' || e.key === 'U') && !e.ctrlKey && !e.altKey && !e.metaKey) {
        undoLast();
    } else if (config && config.destinationFolders) {
        // Folder keys move the image (or delete it, for a key set to Delete);
        // Shift + folder key copies it
        if (e.shiftKey) {
            const pressed = physicalKey(e);
            Object.entries(config.destinationFolders).forEach(([key, folder]) => {
                if (folder.key && pressed === folder.key.toLowerCase() && folder.action !== 'delete') {
                    copyToFolder(key);
                }
            });
            return;
        }
        Object.entries(config.destinationFolders).forEach(([key, folder]) => {
            if (e.key === folder.key) {
                if (folder.action === 'delete') deleteCurrentImage();
                else moveToFolder(key);
            }
        });
    }
});

// The unshifted character of the physical key pressed (Shift+1 -> "1",
// Shift+Numpad1 -> "1", Shift+A -> "a"), independent of keyboard layout symbols.
function physicalKey(e) {
    let m = /^Digit(\d)$/.exec(e.code) || /^Numpad(\d)$/.exec(e.code);
    if (m) return m[1];
    m = /^Key([A-Z])$/.exec(e.code);
    if (m) return m[1].toLowerCase();
    return (e.key || '').toLowerCase();
}

// Open folder handler
document.getElementById('open-folder-btn').addEventListener('click', async () => {
    const selection = await ipcRenderer.invoke('select-source-folder', scanExcludeFolders(), config ? config.sourceFolder : '');
    if (selection) {
        config.sourceFolder = selection.folder;
        config.includeSubfolders = selection.includeSubfolders;
        await ipcRenderer.invoke('save-config', config);
        await loadImages();
    }
});

document.getElementById('cancel-config').addEventListener('click', () => {
    configPanel.classList.remove('active');
});

document.getElementById('save-config').addEventListener('click', async () => {
    await saveConfig();
    configPanel.classList.remove('active');
    await loadImages();
    updateShortcutDisplay();
});

document.getElementById('reload-btn').addEventListener('click', async () => {
    await loadImages();
});

document.getElementById('shortcuts-close').addEventListener('click', () => {
    shortcutsPanel.classList.add('hidden');
});

document.getElementById('toggle-shortcuts-btn').addEventListener('click', () => {
    shortcutsPanel.classList.toggle('hidden');
});

// Set / Delete buttons on the folder rows of the Shortcuts panel
shortcutKeysEl.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-key]');
    if (!btn || !config) return;
    btn.blur();
    const dest = config.destinationFolders[btn.dataset.key];
    if (!dest) return;

    if (btn.classList.contains('dest-set')) {
        const folder = await ipcRenderer.invoke('select-folder');
        if (!folder) return;
        dest.path = folder;
        dest.name = folder.split(/[\\/]/).filter(Boolean).pop() || folder;
        dest.action = 'move'; // picking a folder makes it a move key again
    } else if (btn.classList.contains('dest-delete')) {
        // The key sends the image to the Recycle Bin instead of moving it
        dest.action = dest.action === 'delete' ? 'move' : 'delete';
    } else {
        return;
    }
    await ipcRenderer.invoke('save-config', config);
    updateShortcutDisplay();
});

function openConfigPanel() {
    if (!config) return;
    
    // Populate source folder
    document.getElementById('source-folder').value = config.sourceFolder || '';
    
    // Populate destination folders
    const destContainer = document.getElementById('destination-folders');
    destContainer.innerHTML = '';
    
    Object.entries(config.destinationFolders).forEach(([key, folder]) => {
        const folderDiv = document.createElement('div');
        folderDiv.className = 'folder-config';
        folderDiv.innerHTML = `
            <div class="config-group">
                <label>Keyboard Shortcut:</label>
                <input type="text" class="dest-key" data-key="${key}" value="${folder.key}" maxlength="1">
            </div>
            <div class="config-group">
                <label>Folder Name:</label>
                <input type="text" class="dest-name" data-key="${key}" value="${folder.name}">
            </div>
            <div class="config-group">
                <label>Folder Path:</label>
                <input type="text" class="dest-path" data-key="${key}" value="${folder.path}" readonly>
                <button class="select-folder-btn select-dest" data-key="${key}">Browse...</button>
            </div>
        `;
        destContainer.appendChild(folderDiv);
    });
    
    // Add event listeners for folder selection
    document.getElementById('select-source').addEventListener('click', async () => {
        const folder = await ipcRenderer.invoke('select-folder');
        if (folder) {
            document.getElementById('source-folder').value = folder;
        }
    });
    
    document.querySelectorAll('.select-dest').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const key = e.target.dataset.key;
            const folder = await ipcRenderer.invoke('select-folder');
            if (folder) {
                document.querySelector(`.dest-path[data-key="${key}"]`).value = folder;
            }
        });
    });
    
    configPanel.classList.add('active');
}

async function saveConfig() {
    const newConfig = {
        sourceFolder: document.getElementById('source-folder').value,
        includeSubfolders: !!(config && config.includeSubfolders),
        autoMoveSkipped: !!(config && config.autoMoveSkipped),
        skippedFolder: (config && config.skippedFolder) || '',
        showFolderName: !!(config && config.showFolderName),
        destinationFolders: {},
        sortBy: sortBy,
        sortOrder: sortOrder
    };
    
    document.querySelectorAll('.dest-key').forEach(input => {
        const key = input.dataset.key;
        const keyValue = input.value;
        const name = document.querySelector(`.dest-name[data-key="${key}"]`).value;
        const pathValue = document.querySelector(`.dest-path[data-key="${key}"]`).value;
        
        newConfig.destinationFolders[key] = {
            name: name,
            path: pathValue,
            action: (config && config.destinationFolders[key] && config.destinationFolders[key].action) || 'move',
            key: keyValue
        };
    });
    
    const result = await ipcRenderer.invoke('save-config', newConfig);
    if (result.success) {
        config = newConfig;
    } else {
        console.error('Error saving settings:', result.error);
    }
}

// Initialize app
init();
