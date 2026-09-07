/**
 * Wires params -> generator -> renderers together, plus the import/export
 * plumbing that makes the diagram JSON pluggable in and out of this app.
 */
(function () {
  const PARAMS_KEY = 'diagram-generator:params';
  const INPUT_DATA_KEY = 'diagram-generator:inputData';

  // Controls persist across refreshes by saving `params` to localStorage on
  // every regenerate and restoring it (merged over the defaults, so newly
  // added params still get a sane value) on load.
  function loadParams() {
    const defaults = DG.defaultParams();
    try {
      const saved = JSON.parse(localStorage.getItem(PARAMS_KEY));
      if (!saved) return defaults;
      return Object.assign(defaults, saved, { shapes: Object.assign(defaults.shapes, saved.shapes) });
    } catch (err) {
      return defaults;
    }
  }

  function saveParams() {
    try {
      localStorage.setItem(PARAMS_KEY, JSON.stringify(params));
    } catch (err) {
      // Ignore (e.g. private browsing storage quota) -- persistence is a convenience, not required.
    }
  }

  function loadInputData() {
    try {
      return JSON.parse(localStorage.getItem(INPUT_DATA_KEY));
    } catch (err) {
      return null;
    }
  }

  const params = loadParams();
  let currentDiagram = null;
  let inputData = loadInputData();
  let p5Instance = null;

  const sketchContainer = document.getElementById('sketch-container');
  const tableContainer = document.getElementById('table-container');
  const statusEl = document.getElementById('status');
  const dataStatusEl = document.getElementById('data-status');

  function setStatus(msg) {
    statusEl.textContent = msg;
    if (msg) setTimeout(() => { if (statusEl.textContent === msg) statusEl.textContent = ''; }, 4000);
  }

  // --- generation ------------------------------------------------------
  function regenerate() {
    try {
      currentDiagram =
        params.useInputData && inputData
          ? DG.generateFromData(inputData, params)
          : DG.generateDiagram(params);
      viewNeedsReset = true;
      renderCurrent();
      saveParams();
    } catch (err) {
      console.error(err);
      setStatus(`Generation error: ${err.message}`);
    }
  }

  function renderCurrent() {
    if (!currentDiagram) return;
    if (p5Instance) p5Instance.redraw();
    DG.renderDiagramTable(tableContainer, currentDiagram);
  }

  // --- p5 sketch (instance mode) ------------------------------------------
  // The canvas always fills sketch-container (the full viewport area next to
  // the sidebar). `view` is the diagram->canvas transform (screen = diagram
  // * view.scale + view.offset*), initialized to "contain" (fit + centered)
  // whenever a new diagram is set, then freely pannable/zoomable by the user
  // from there -- see the mouseWheel/mousePressed/mouseDragged handlers and
  // the zoom buttons below.
  let view = null;
  let viewNeedsReset = true;

  // While dragging: { kind: 'pan', startX, startY, startOffsetX, startOffsetY }
  //              | { kind: 'node', node, grabDX, grabDY }
  //              | { kind: 'edgeEndpoint', edge, which }        -- which: 'source' | 'target'
  //              | { kind: 'edgeExtra', edge, which, index }    -- which: 'extraSources' | 'extraTargets'
  //              | { kind: 'edgeBend', edge }
  let dragState = null;

  function initView(p) {
    const dw = currentDiagram.meta.width;
    const dh = currentDiagram.meta.height;
    const scale = Math.min(p.width / dw, p.height / dh) || 1;
    view = {
      scale,
      offsetX: (p.width - dw * scale) / 2,
      offsetY: (p.height - dh * scale) / 2,
      baseScale: scale,
    };
    viewNeedsReset = false;
  }

  function toDiagramSpace(sx, sy) {
    return { x: (sx - view.offsetX) / view.scale, y: (sy - view.offsetY) / view.scale };
  }

  /** Zooms by `factor` around the fixed screen point (sx, sy), e.g. the cursor or canvas center. */
  function zoomAround(sx, sy, factor) {
    if (!view) return;
    const before = toDiagramSpace(sx, sy);
    view.scale = Math.min(view.baseScale * 8, Math.max(view.baseScale * 0.15, view.scale * factor));
    view.offsetX = sx - before.x * view.scale;
    view.offsetY = sy - before.y * view.scale;
  }

  function sketch(p) {
    p.setup = () => {
      const c = p.createCanvas(sketchContainer.clientWidth, sketchContainer.clientHeight);
      c.parent(sketchContainer);
      p.noLoop();
      renderCurrent();
    };

    p.draw = () => {
      if (!currentDiagram) return;
      if (!view || viewNeedsReset) initView(p);
      p.background(currentDiagram.meta.background);
      p.push();
      p.translate(view.offsetX, view.offsetY);
      p.scale(view.scale);
      DG.renderDiagramP5(p, currentDiagram, { showLabels: params.showNodeLabels });
      p.pop();
    };

    function withinCanvas() {
      return p.mouseX >= 0 && p.mouseY >= 0 && p.mouseX <= p.width && p.mouseY <= p.height;
    }

    p.mouseWheel = (event) => {
      if (!currentDiagram || !view || !withinCanvas()) return;
      const factor = Math.min(1.75, Math.max(0.57, Math.exp(-event.deltaY * 0.00405)));
      zoomAround(p.mouseX, p.mouseY, factor);
      p.redraw();
      return false; // prevent the page itself from scrolling
    };

    p.mousePressed = () => {
      if (!currentDiagram || !view || !withinCanvas()) return;
      const pt = toDiagramSpace(p.mouseX, p.mouseY);

      const node = DG.hitTestNode(currentDiagram, pt.x, pt.y);
      if (node) {
        dragState = { kind: 'node', node, grabDX: pt.x - node.x, grabDY: pt.y - node.y };
        p.canvas.classList.add('dragging');
        return;
      }

      // A grab threshold in diagram-space units, roughly matching a ~6px reach on screen.
      const edgeHit = DG.hitTestEdge(currentDiagram, pt.x, pt.y, 6 / (view.scale || 1));
      if (edgeHit) {
        dragState = { kind: edgeHit.kind === 'endpoint' ? 'edgeEndpoint' : edgeHit.kind === 'extra' ? 'edgeExtra' : 'edgeBend', edge: edgeHit.edge, which: edgeHit.which, index: edgeHit.index };
        p.canvas.classList.add('dragging');
        return;
      }

      // Empty space: pan the view instead of moving anything.
      dragState = { kind: 'pan', startX: p.mouseX, startY: p.mouseY, startOffsetX: view.offsetX, startOffsetY: view.offsetY };
      p.canvas.classList.add('dragging');
    };

    p.mouseDragged = () => {
      if (!dragState) return;
      if (dragState.kind === 'pan') {
        view.offsetX = dragState.startOffsetX + (p.mouseX - dragState.startX);
        view.offsetY = dragState.startOffsetY + (p.mouseY - dragState.startY);
        p.redraw();
        return;
      }
      const pt = toDiagramSpace(p.mouseX, p.mouseY);
      if (dragState.kind === 'node') {
        dragState.node.x = pt.x - dragState.grabDX;
        dragState.node.y = pt.y - dragState.grabDY;
      } else if (dragState.kind === 'edgeEndpoint') {
        dragState.edge[dragState.which] = { x: pt.x, y: pt.y };
      } else if (dragState.kind === 'edgeExtra') {
        dragState.edge[dragState.which][dragState.index] = { x: pt.x, y: pt.y };
      } else if (dragState.kind === 'edgeBend') {
        dragState.edge.controlPoint = { x: pt.x, y: pt.y };
      }
      p.redraw();
    };

    function endDrag() {
      if (!dragState) return;
      dragState = null;
      p.canvas.classList.remove('dragging');
    }
    p.mouseReleased = endDrag;
  }
  p5Instance = new p5(sketch);

  // --- view controls (zoom in/out/reset) ------------------------------------
  document.getElementById('zoom-in').addEventListener('click', () => {
    if (!p5Instance || !view) return;
    zoomAround(p5Instance.width / 2, p5Instance.height / 2, 1.5);
    p5Instance.redraw();
  });
  document.getElementById('zoom-out').addEventListener('click', () => {
    if (!p5Instance || !view) return;
    zoomAround(p5Instance.width / 2, p5Instance.height / 2, 1 / 1.5);
    p5Instance.redraw();
  });
  document.getElementById('zoom-reset').addEventListener('click', () => {
    if (!p5Instance || !currentDiagram) return;
    initView(p5Instance);
    p5Instance.redraw();
  });

  // Keep the canvas sized to its container (the viewport area beside the
  // sidebar) as the window resizes.
  new ResizeObserver(() => {
    if (!p5Instance) return;
    const w = sketchContainer.clientWidth;
    const h = sketchContainer.clientHeight;
    if (w > 0 && h > 0 && (p5Instance.width !== w || p5Instance.height !== h)) {
      p5Instance.resizeCanvas(w, h);
      p5Instance.redraw();
    }
  }).observe(sketchContainer);

  // --- table drawer --------------------------------------------------------
  // The table is a collapsible drawer overlaying the bottom of the canvas
  // (rather than a separate full-screen view), so both are visible/usable
  // at once; it's kept up to date continuously (renderCurrent() above always
  // renders it) so expanding it never shows stale data.
  const TABLE_EXPANDED_KEY = 'diagram-generator:tableExpanded';
  const tableDrawer = document.getElementById('table-drawer');
  const tableDrawerToggle = document.getElementById('table-drawer-toggle');
  tableDrawer.classList.toggle('expanded', localStorage.getItem(TABLE_EXPANDED_KEY) === 'true');
  tableDrawerToggle.addEventListener('click', () => {
    const expanded = tableDrawer.classList.toggle('expanded');
    try {
      localStorage.setItem(TABLE_EXPANDED_KEY, String(expanded));
    } catch (err) {
      // Ignore -- persistence is a convenience, not required.
    }
  });

  // --- controls panel ------------------------------------------------------
  // onDisplayChange is for controls that only affect how the *current*
  // diagram is drawn (e.g. label visibility) -- redraw only, since routing
  // them through regenerate() would discard any manual node/edge dragging
  // even though, being unseeded, it'd reproduce the identical diagram.
  function redrawOnly() {
    if (p5Instance) p5Instance.redraw();
    saveParams();
  }

  DG.setupControls(params, {
    onChange: regenerate,
    onRegenerate: regenerate,
    onDisplayChange: redrawOnly,
    onExportJSON: exportDiagramJSON,
    onExportPNG: exportPNG,
    onExportBoth: exportBoth,
  });

  // --- download location -----------------------------------------------
  // The File System Access API (Chromium only) is the only way a web page
  // can write straight to a chosen folder instead of the browser's default
  // downloads location; the directory handle is IndexedDB-persisted (it
  // isn't string-serializable, so localStorage can't hold it) and re-used
  // silently across reloads as long as the browser still grants permission
  // for it without a fresh prompt.
  const IDB_NAME = 'diagram-generator';
  const IDB_STORE = 'handles';
  const DIR_HANDLE_KEY = 'downloadDir';
  const supportsFsAccess = typeof window.showDirectoryPicker === 'function';
  let downloadDirHandle = null;

  function openIdb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbGet(key) {
    const db = await openIdb();
    return new Promise((resolve, reject) => {
      const req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbSet(key, value) {
    const db = await openIdb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(value, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }

  async function idbDelete(key) {
    const db = await openIdb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).delete(key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }

  const downloadFolderStatusEl = document.getElementById('download-folder-status');
  const chooseFolderBtn = document.getElementById('choose-download-folder');
  const clearFolderBtn = document.getElementById('clear-download-folder');

  function updateFolderStatus() {
    if (!supportsFsAccess) {
      downloadFolderStatusEl.textContent = 'Not supported in this browser -- using the browser default.';
      chooseFolderBtn.disabled = true;
      return;
    }
    downloadFolderStatusEl.textContent = downloadDirHandle ? `Saving exports to "${downloadDirHandle.name}".` : 'Using the browser default.';
    clearFolderBtn.hidden = !downloadDirHandle;
  }

  (async function restoreDownloadDir() {
    if (!supportsFsAccess) {
      updateFolderStatus();
      return;
    }
    try {
      const handle = await idbGet(DIR_HANDLE_KEY);
      if (handle && (await handle.queryPermission({ mode: 'readwrite' })) === 'granted') {
        downloadDirHandle = handle;
      } else if (handle) {
        setStatus('Download folder needs re-authorization -- click "Choose folder..." to re-enable.');
      }
    } catch (err) {
      // Ignore -- fall back to the browser default.
    }
    updateFolderStatus();
  })();

  chooseFolderBtn.addEventListener('click', async () => {
    try {
      const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
      downloadDirHandle = handle;
      await idbSet(DIR_HANDLE_KEY, handle);
      setStatus(`Exports will save to "${handle.name}".`);
    } catch (err) {
      if (err.name !== 'AbortError') setStatus(`Could not set download folder: ${err.message}`);
    }
    updateFolderStatus();
  });

  clearFolderBtn.addEventListener('click', async () => {
    downloadDirHandle = null;
    try {
      await idbDelete(DIR_HANDLE_KEY);
    } catch (err) {
      // Ignore.
    }
    setStatus('Reverted to the browser default download location.');
    updateFolderStatus();
  });

  // --- export --------------------------------------------------------------
  function downloadBlob(filename, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  /** Writes into the chosen folder if one is set (falling back to a normal download on failure), else downloads normally. */
  async function saveBlob(filename, blob) {
    if (downloadDirHandle) {
      try {
        const fileHandle = await downloadDirHandle.getFileHandle(filename, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(blob);
        await writable.close();
        return;
      } catch (err) {
        setStatus(`Could not save to "${downloadDirHandle.name}" (${err.message}) -- used the browser default instead.`);
      }
    }
    downloadBlob(filename, blob);
  }

  function canvasBlob() {
    return new Promise((resolve) => p5Instance.canvas.toBlob(resolve, 'image/png'));
  }

  async function exportDiagramJSON() {
    if (!currentDiagram) return;
    const blob = new Blob([JSON.stringify(currentDiagram, null, 2)], { type: 'application/json' });
    await saveBlob(`diagram-${currentDiagram.meta.seed}.json`, blob);
    setStatus('Exported diagram JSON.');
  }

  async function exportPNG() {
    if (!p5Instance) return;
    const blob = await canvasBlob();
    await saveBlob(`diagram-${params.seed}.png`, blob);
    setStatus('Exported PNG.');
  }

  async function exportBoth() {
    if (!currentDiagram || !p5Instance) return;
    await exportDiagramJSON();
    await exportPNG();
    setStatus('Exported diagram JSON + PNG.');
  }

  // --- import: a diagram JSON produced by this tool (or another one) ------
  document.getElementById('import-diagram-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        const errors = DG.validateDiagram(parsed);
        if (errors.length) {
          setStatus(`Invalid diagram JSON: ${errors[0]}`);
          return;
        }
        currentDiagram = parsed;
        viewNeedsReset = true;
        renderCurrent();
        setStatus(`Loaded external diagram "${file.name}" (bypassing generator).`);
      } catch (err) {
        setStatus(`Could not parse JSON: ${err.message}`);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  });

  // --- input data: drives generateFromData() instead of pure random -------
  const useInputDataCheckbox = document.getElementById('use-input-data');
  useInputDataCheckbox.checked = params.useInputData;
  if (inputData) {
    dataStatusEl.textContent = `Restored data: ${inputData.nodes.length} nodes`;
  }

  useInputDataCheckbox.addEventListener('change', () => {
    params.useInputData = useInputDataCheckbox.checked;
    regenerate();
  });

  function setInputData(data, sourceLabel) {
    inputData = data;
    dataStatusEl.textContent = `${sourceLabel}: ${data.nodes.length} nodes`;
    try {
      localStorage.setItem(INPUT_DATA_KEY, JSON.stringify(data));
    } catch (err) {
      // Ignore -- persistence is a convenience, not required.
    }
    if (params.useInputData) regenerate();
  }

  document.getElementById('load-sample-data').addEventListener('click', () => {
    setInputData(window.DG_SAMPLE_INPUT, 'Sample data');
    useInputDataCheckbox.checked = true;
    params.useInputData = true;
    regenerate();
  });

  document.getElementById('import-data-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        if (!Array.isArray(parsed.nodes)) throw new Error('expected { nodes: [...] }');
        setInputData(parsed, file.name);
      } catch (err) {
        setStatus(`Could not load input data: ${err.message}`);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  });

  document.getElementById('apply-pasted-data').addEventListener('click', () => {
    const textarea = document.getElementById('paste-data-textarea');
    try {
      const parsed = JSON.parse(textarea.value);
      if (!Array.isArray(parsed.nodes)) throw new Error('expected { nodes: [...] }');
      setInputData(parsed, 'Pasted data');
    } catch (err) {
      setStatus(`Could not parse pasted data: ${err.message}`);
    }
  });

  regenerate();
})();
