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
const quickFolderPanel = document.getElementById('quick-folder-panel');
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
    if (images.length > 0) {
        await withProcessing(() => {
            sortImages(true);
            displayImage();
        });
    }
    if (config) {
        config.sortBy = sortBy;
        config.sortOrder = sortOrder;
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
    const list = Object.values(config.destinationFolders || {}).map(d => d.path).filter(Boolean);
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

// Serializes file operations so fast key presses can't act on the wrong image
let busy = false;

// Navigate by step (+1 / -1). With auto-move on, the image being left
// (viewed but not moved/deleted with a key) goes to the skipped folder
// (Settings > Skipped folder location; default <source>\skipped).
async function navigate(step) {
    if (images.length === 0 || busy) return;

    // Images copied with Shift + folder key are categorized: leave them in place
    if (config && config.autoMoveSkipped && config.sourceFolder && !images[currentIndex].copied) {
        busy = true;
        try {
            const result = await ipcRenderer.invoke('move-to-skipped', images[currentIndex].path, config.sourceFolder, config.skippedFolder || '');
            if (result.success) {
                images.splice(currentIndex, 1);
                if (images.length === 0) {
                    showNoImages();
                    return;
                }
                if (step > 0) {
                    // next image has shifted into currentIndex
                    if (currentIndex >= images.length) currentIndex = 0;
                } else {
                    currentIndex = (currentIndex - 1 + images.length) % images.length;
                }
                displayImage();
                return;
            }
            if (!result.noop) console.error(result.error); // not moved: fall through to plain navigation
        } finally {
            busy = false;
        }
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

// Shift + folder key: copy the current image; it stays in the list and on screen
async function copyToFolder(destKey) {
    if (images.length === 0 || busy) return;

    const destination = config.destinationFolders[destKey];
    if (!destination || !destination.path) return;

    busy = true;
    const img = images[currentIndex];
    const result = await withProcessing(() => ipcRenderer.invoke('copy-file', img.path, destination.path)).finally(() => { busy = false; });
    if (result.success || result.alreadyExists) {
        img.copied = true; // exempt from auto-move skipped
    } else {
        console.error(result.error);
    }
}

async function moveToFolder(destKey) {
    if (images.length === 0 || busy) return;
    
    const destination = config.destinationFolders[destKey];
    if (!destination) return;

    busy = true;
    const currentImage = images[currentIndex].path;
    const result = await ipcRenderer.invoke('move-file', currentImage, destination.path).finally(() => { busy = false; });
    
    if (result.success) {
        // Remove from current list
        images.splice(currentIndex, 1);
        
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
        console.error(result.error);
    }
}

async function deleteCurrentImage() {
    if (images.length === 0 || busy) return;
    
    busy = true;
    const currentImage = images[currentIndex].path;
    const result = await ipcRenderer.invoke('delete-file', currentImage).finally(() => { busy = false; });
    
    if (result.success) {
        // Remove from current list
        images.splice(currentIndex, 1);
        
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
        console.error(result.error);
    }
}

function updateShortcutDisplay() {
    if (!config || !config.destinationFolders) return;
    
    shortcutKeysEl.innerHTML = '';
    
    Object.entries(config.destinationFolders).forEach(([key, folder]) => {
        const shortcutDiv = document.createElement('div');
        shortcutDiv.className = 'shortcut';
        shortcutDiv.innerHTML = `
            <span class="key">${folder.key}</span>
            <span class="label">→ ${folder.name}</span>
        `;
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
    } else if (e.key === 'x' || e.key === 'X') {
        deleteCurrentImage();
    } else if (config && config.destinationFolders) {
        // Folder keys move the image; Shift + folder key copies it
        if (e.shiftKey) {
            const pressed = physicalKey(e);
            Object.entries(config.destinationFolders).forEach(([key, folder]) => {
                if (folder.key && pressed === folder.key.toLowerCase()) {
                    copyToFolder(key);
                }
            });
            return;
        }
        Object.entries(config.destinationFolders).forEach(([key, folder]) => {
            if (e.key === folder.key) {
                moveToFolder(key);
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

document.getElementById('quick-folder-btn').addEventListener('click', () => {
    updateQuickFolderPanel();
    quickFolderPanel.classList.add('active');
});

document.getElementById('qf-close').addEventListener('click', () => {
    quickFolderPanel.classList.remove('active');
});

document.querySelectorAll('.qf-select').forEach(btn => {
    btn.addEventListener('click', async (e) => {
        const key = e.target.dataset.key;
        const folder = await ipcRenderer.invoke('select-folder');
        if (folder) {
            const folderName = folder.split('\\').pop() || folder.split('/').pop();
            config.destinationFolders[key].path = folder;
            config.destinationFolders[key].name = folderName;
            await ipcRenderer.invoke('save-config', config);
            updateQuickFolderPanel();
            updateShortcutDisplay();
        }
    });
});

function updateQuickFolderPanel() {
    if (!config || !config.destinationFolders) return;
    
    Object.entries(config.destinationFolders).forEach(([key, folder]) => {
        const nameEl = document.getElementById(`qf-name-${key}`);
        if (nameEl) {
            nameEl.textContent = folder.name || 'Not set';
        }
    });
}

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
