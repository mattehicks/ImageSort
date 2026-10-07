// Trim mode: split the current image with horizontal/vertical lines and save
// highlighted sections next to the original as <name>_trim<N><ext>.
//
//   Drag on the image ........ add a line (mostly sideways = horizontal,
//                              mostly up/down = vertical); keep dragging to place it
//   Drag a line .............. move it; drag it off the image to remove it
//   Right-click a line ....... remove it
//   Click a section .......... highlight / unhighlight it
//   Enter or Save button ..... save highlighted sections, or all sections when
//                              none are highlighted (original is unchanged);
//                              a successful save exits trim mode
//   Esc, T or Trim button .... exit trim mode (T or Trim button also enters)
//
// Uses globals from renderer.js: images, currentIndex, imageEl, filenameEl,
// flashStatus, reportFailure, ipcRenderer.

(() => {
    const fsTrim = require('fs');
    const pathTrim = require('path');

    const container = document.getElementById('viewer-container');
    const trimBtn = document.getElementById('trim-btn');
    const saveBtn = document.getElementById('trim-save-btn');
    const hintEl = document.getElementById('trim-hint');

    const canvas = document.createElement('canvas');
    canvas.id = 'trim-canvas';
    container.appendChild(canvas);
    const ctx = canvas.getContext('2d');

    const GRAB_PX = 6;      // how close (screen px) the pointer must be to grab a line
    const START_PX = 6;     // drag distance before a new line is created
    const EDGE_REMOVE = 0.005;

    let active = false;
    let imagePath = null;   // image the lines belong to
    let vLines = [];        // vertical lines: x as a fraction of image width (0..1)
    let hLines = [];        // horizontal lines: y as a fraction of image height
    let picks = [];         // selected points {x, y} (fractions); a section is
                            // highlighted when it contains a picked point
    let drag = null;        // { kind: 'v'|'h', index } while moving a line
    let pending = null;     // { x, y } mousedown on empty area, not yet a drag
    let saving = false;

    // ---- geometry -------------------------------------------------------

    function imageRect() {
        const r = imageEl.getBoundingClientRect();
        const c = container.getBoundingClientRect();
        return { left: r.left - c.left, top: r.top - c.top, width: r.width, height: r.height };
    }

    function toFraction(e) {
        const r = canvas.getBoundingClientRect();
        return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
    }

    // Boundaries along one axis, including the image edges, sorted
    function bounds(lines) {
        return [0, ...[...lines].sort((a, b) => a - b), 1];
    }

    // All sections as fraction rects, in reading order (top-left first)
    function sections() {
        const xs = bounds(vLines);
        const ys = bounds(hLines);
        const out = [];
        for (let j = 0; j < ys.length - 1; j++) {
            for (let i = 0; i < xs.length - 1; i++) {
                out.push({ x0: xs[i], x1: xs[i + 1], y0: ys[j], y1: ys[j + 1] });
            }
        }
        return out;
    }

    function contains(s, p) {
        return p.x >= s.x0 && p.x < s.x1 && p.y >= s.y0 && p.y < s.y1;
    }

    function selectedSections() {
        return sections().filter(s => picks.some(p => contains(s, p)));
    }

    // What Save writes: the highlighted sections, or all of them when none are
    // highlighted. With no lines there's only the whole image: nothing to save.
    function sectionsToSave() {
        const chosen = selectedSections();
        if (chosen.length > 0) return { list: chosen, all: false };
        if (vLines.length === 0 && hLines.length === 0) return { list: [], all: false };
        return { list: sections(), all: true };
    }

    // Line near a screen point, or null
    function lineAt(p) {
        const r = canvas.getBoundingClientRect();
        let best = null;
        vLines.forEach((x, index) => {
            const d = Math.abs(x - p.x) * r.width;
            if (d <= GRAB_PX && (!best || d < best.d)) best = { kind: 'v', index, d };
        });
        hLines.forEach((y, index) => {
            const d = Math.abs(y - p.y) * r.height;
            if (d <= GRAB_PX && (!best || d < best.d)) best = { kind: 'h', index, d };
        });
        return best;
    }

    // ---- drawing --------------------------------------------------------

    function layout() {
        if (!active) return;
        const r = imageRect();
        const dpr = window.devicePixelRatio || 1;
        canvas.style.left = r.left + 'px';
        canvas.style.top = r.top + 'px';
        canvas.style.width = r.width + 'px';
        canvas.style.height = r.height + 'px';
        canvas.width = Math.max(1, Math.round(r.width * dpr));
        canvas.height = Math.max(1, Math.round(r.height * dpr));
        draw();
    }

    function draw() {
        const w = canvas.width, h = canvas.height;
        const dpr = window.devicePixelRatio || 1;
        ctx.clearRect(0, 0, w, h);

        const chosen = selectedSections();
        if (chosen.length > 0) {
            // Dim everything, then clear + tint the highlighted sections
            ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
            ctx.fillRect(0, 0, w, h);
            for (const s of chosen) {
                const x = s.x0 * w, y = s.y0 * h, sw = (s.x1 - s.x0) * w, sh = (s.y1 - s.y0) * h;
                ctx.clearRect(x, y, sw, sh);
                ctx.fillStyle = 'rgba(80, 160, 255, 0.18)';
                ctx.fillRect(x, y, sw, sh);
                ctx.strokeStyle = 'rgba(80, 160, 255, 0.95)';
                ctx.lineWidth = 2 * dpr;
                ctx.strokeRect(x + dpr, y + dpr, sw - 2 * dpr, sh - 2 * dpr);
            }
        }

        // Lines: dark outline + bright core so they show on any image
        const line = (x0, y0, x1, y1) => {
            ctx.beginPath();
            ctx.moveTo(x0, y0);
            ctx.lineTo(x1, y1);
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
            ctx.lineWidth = 4 * dpr;
            ctx.stroke();
            ctx.strokeStyle = '#ffd24a';
            ctx.lineWidth = 2 * dpr;
            ctx.stroke();
        };
        for (const x of vLines) line(x * w, 0, x * w, h);
        for (const y of hLines) line(0, y * h, w, y * h);

        updateControls();
    }

    function updateControls() {
        const { list, all } = sectionsToSave();
        const n = list.length;
        const noun = `section${n === 1 ? '' : 's'}`;
        saveBtn.textContent = n === 0 ? '💾 Save' : all ? `💾 Save all ${n} ${noun}` : `💾 Save ${n} ${noun}`;
        saveBtn.disabled = n === 0 || saving;
    }

    // ---- mode on/off ----------------------------------------------------

    function enter() {
        if (active || images.length === 0 || !images[currentIndex] || imageEl.style.display === 'none') return;
        active = true;
        imagePath = images[currentIndex].path;
        vLines = [];
        hLines = [];
        picks = [];
        drag = null;
        pending = null;
        document.body.classList.add('trim-active');
        trimBtn.textContent = '✂ Exit trim';
        canvas.style.display = 'block';
        saveBtn.style.display = '';
        hintEl.style.display = '';
        layout();
    }

    function exit() {
        if (!active) return;
        active = false;
        imagePath = null;
        drag = null;
        pending = null;
        document.body.classList.remove('trim-active');
        trimBtn.textContent = '✂ Trim';
        canvas.style.display = 'none';
        saveBtn.style.display = 'none';
        hintEl.style.display = 'none';
    }

    function toggle() {
        if (active) exit(); else enter();
    }

    // ---- pointer --------------------------------------------------------

    function clamp(v) {
        return Math.min(1, Math.max(0, v));
    }

    canvas.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const p = toFraction(e);
        const hit = lineAt(p);
        if (hit) {
            drag = { kind: hit.kind, index: hit.index };
        } else {
            pending = { x: p.x, y: p.y, cx: e.clientX, cy: e.clientY };
        }
    });

    window.addEventListener('mousemove', (e) => {
        if (!active) return;
        const p = toFraction(e);

        if (pending) {
            const dx = Math.abs(e.clientX - pending.cx);
            const dy = Math.abs(e.clientY - pending.cy);
            if (Math.max(dx, dy) >= START_PX) {
                // Mostly sideways = horizontal line; mostly up/down = vertical
                if (dx >= dy) {
                    hLines.push(clamp(pending.y));
                    drag = { kind: 'h', index: hLines.length - 1 };
                } else {
                    vLines.push(clamp(pending.x));
                    drag = { kind: 'v', index: vLines.length - 1 };
                }
                pending = null;
            }
        }

        if (drag) {
            if (drag.kind === 'v') vLines[drag.index] = clamp(p.x);
            else hLines[drag.index] = clamp(p.y);
            draw();
            canvas.style.cursor = drag.kind === 'v' ? 'col-resize' : 'row-resize';
            return;
        }

        if (e.target === canvas) {
            const hit = lineAt(p);
            canvas.style.cursor = hit ? (hit.kind === 'v' ? 'col-resize' : 'row-resize') : 'crosshair';
        }
    });

    window.addEventListener('mouseup', (e) => {
        if (!active || e.button !== 0) return;

        if (drag) {
            // Dragged to (or past) the edge: remove the line
            const list = drag.kind === 'v' ? vLines : hLines;
            const v = list[drag.index];
            if (v <= EDGE_REMOVE || v >= 1 - EDGE_REMOVE) list.splice(drag.index, 1);
            drag = null;
            draw();
            return;
        }

        if (pending) {
            // Click without drag: toggle the section under the pointer
            const p = { x: pending.x, y: pending.y };
            pending = null;
            const s = sections().find(sec => contains(sec, p));
            if (!s) return;
            const before = picks.length;
            picks = picks.filter(q => !contains(s, q));
            if (picks.length === before) picks.push(p);
            draw();
        }
    });

    canvas.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const hit = lineAt(toFraction(e));
        if (!hit) return;
        (hit.kind === 'v' ? vLines : hLines).splice(hit.index, 1);
        draw();
    });

    // ---- save -----------------------------------------------------------

    // Encoders the canvas supports; other formats are saved as PNG
    const ENCODE = {
        '.png': { type: 'image/png', ext: '.png' },
        '.jpg': { type: 'image/jpeg', ext: '.jpg', quality: 0.95 },
        '.jpeg': { type: 'image/jpeg', ext: '.jpeg', quality: 0.95 },
        '.webp': { type: 'image/webp', ext: '.webp', quality: 0.95 }
    };

    function canvasToBytes(c, enc) {
        return new Promise((resolve, reject) => {
            c.toBlob(async (blob) => {
                if (!blob) return reject(new Error('Could not encode section'));
                resolve(new Uint8Array(await blob.arrayBuffer()));
            }, enc.type, enc.quality);
        });
    }

    async function save() {
        if (!active || saving) return;
        const chosen = sectionsToSave().list;
        if (chosen.length === 0) return;

        saving = true;
        updateControls();
        const sourcePath = imagePath;
        try {
            // Decode from the file itself (full resolution, EXIF orientation applied)
            const bytes = await fsTrim.promises.readFile(sourcePath);
            const bitmap = await createImageBitmap(new Blob([bytes]), { imageOrientation: 'from-image' });
            const enc = ENCODE[pathTrim.extname(sourcePath).toLowerCase()] || ENCODE['.png'];

            const out = [];
            for (const s of chosen) {
                const sx = Math.round(s.x0 * bitmap.width);
                const sy = Math.round(s.y0 * bitmap.height);
                const sw = Math.max(1, Math.round(s.x1 * bitmap.width) - sx);
                const sh = Math.max(1, Math.round(s.y1 * bitmap.height) - sy);
                const c = document.createElement('canvas');
                c.width = sw;
                c.height = sh;
                c.getContext('2d').drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
                out.push({ data: await canvasToBytes(c, enc), ext: enc.ext });
            }
            bitmap.close();

            const result = await ipcRenderer.invoke('save-trim-sections', sourcePath, out);
            if (!result.success) {
                reportFailure('Trim save', result, { name: pathTrim.basename(sourcePath) });
                return;
            }
            // Saved: leave trim mode so arrows / folder keys work again
            exit();
            const names = result.saved.map(p => pathTrim.basename(p)).join(', ');
            flashStatus(`Saved ${result.saved.length} section${result.saved.length === 1 ? '' : 's'}`, names, 'ok');
        } catch (err) {
            reportFailure('Trim save', { error: err.message }, { name: pathTrim.basename(sourcePath) });
        } finally {
            saving = false;
            if (active) updateControls();
        }
    }

    // ---- wiring ---------------------------------------------------------

    trimBtn.addEventListener('click', () => {
        trimBtn.blur();
        toggle();
    });

    saveBtn.addEventListener('click', () => {
        saveBtn.blur();
        save();
    });

    // Capture phase on window runs before renderer.js's document handler:
    // in trim mode only trim keys work, so nothing gets moved/deleted by accident.
    window.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
        const isT = (e.key === 't' || e.key === 'T') && !e.ctrlKey && !e.altKey && !e.metaKey;
        if (!active) {
            if (isT) {
                e.preventDefault();
                e.stopImmediatePropagation();
                enter();
            }
            return;
        }
        e.preventDefault();
        e.stopImmediatePropagation();
        if (e.key === 'Escape' || isT) exit();
        else if (e.key === 'Enter') save();
    }, true);

    // A different image (open folder, reload, sort...) ends trim mode
    imageEl.addEventListener('load', () => {
        if (!active) return;
        if (!images[currentIndex] || images[currentIndex].path !== imagePath) exit();
        else layout();
    });

    window.addEventListener('resize', layout);
    new ResizeObserver(layout).observe(container);
})();
