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

let sortBy = 'name';
let sortOrder = 'asc';

// Initialize
async function init() {
    config = await ipcRenderer.invoke('load-config');
    if (config) {
        if (config.sortBy) sortBy = config.sortBy;
        if (config.sortOrder) sortOrder = config.sortOrder;
        updateSortControls();
        await loadImages();
        updateShortcutDisplay();
    }
}

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

async function applySort() {
    updateSortControls();
    if (images.length > 0) {
        sortImages(true);
        displayImage();
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

async function loadImages() {
    if (!config || !config.sourceFolder) {
        showNoImages();
        return;
    }

    const excludeFolders = Object.values(config.destinationFolders || {}).map(d => d.path).filter(Boolean);
    images = await ipcRenderer.invoke('load-images', config.sourceFolder, !!config.includeSubfolders, excludeFolders);
    
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
    filenameEl.textContent = images[currentIndex].relPath || images[currentIndex].name;
    hideNoImages();
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

function nextImage() {
    if (images.length === 0) return;
    currentIndex = (currentIndex + 1) % images.length;
    displayImage();
}

function previousImage() {
    if (images.length === 0) return;
    currentIndex = (currentIndex - 1 + images.length) % images.length;
    displayImage();
}

async function moveToFolder(destKey) {
    if (images.length === 0) return;
    
    const destination = config.destinationFolders[destKey];
    if (!destination) return;

    const currentImage = images[currentIndex].path;
    const result = await ipcRenderer.invoke('move-file', currentImage, destination.path);
    
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
    if (images.length === 0) return;
    
    const currentImage = images[currentIndex].path;
    const result = await ipcRenderer.invoke('delete-file', currentImage);
    
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

    if (e.key === 'ArrowRight') {
        nextImage();
    } else if (e.key === 'ArrowLeft') {
        previousImage();
    } else if (e.key === 'x' || e.key === 'X') {
        deleteCurrentImage();
    } else if (config && config.destinationFolders) {
        // Check for destination folder keys
        Object.entries(config.destinationFolders).forEach(([key, folder]) => {
            if (e.key === folder.key) {
                moveToFolder(key);
            }
        });
    }
});

// Open folder handler
document.getElementById('open-folder-btn').addEventListener('click', async () => {
    const selection = await ipcRenderer.invoke('select-source-folder');
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
