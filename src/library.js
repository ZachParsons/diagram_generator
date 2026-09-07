/**
 * Client-side storage for a "library" of saved diagrams -- a separate
 * IndexedDB database from the one main.js uses for the download-folder
 * handle, so this feature is fully self-contained. Each saved entry keeps
 * the full diagram JSON (so it can be resumed for viewing/editing) plus a
 * small PNG thumbnail rendered once at save time via a hidden p5 instance,
 * fit to the diagram's own aspect ratio independent of whatever pan/zoom
 * the user's current canvas view happens to be in.
 */
(function (global) {
  const DB_NAME = 'diagram-generator-library';
  const STORE = 'diagrams';
  const THUMB_W = 300;
  const THUMB_H = 200;

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function put(record) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function listDiagrams() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
      req.onsuccess = () => resolve((req.result || []).sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1)));
      req.onerror = () => reject(req.error);
    });
  }

  async function deleteDiagram(id) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function renameDiagram(id, name) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        if (getReq.result) {
          getReq.result.name = name;
          store.put(getReq.result);
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /** Renders `diagram` into a small hidden p5 canvas, "contain"-fit like the main view's initial zoom, and resolves a PNG Blob. */
  function renderThumbnail(diagram) {
    return new Promise((resolve) => {
      const host = document.createElement('div');
      host.style.position = 'fixed';
      host.style.left = '-9999px';
      document.body.appendChild(host);
      new global.p5((p) => {
        p.setup = () => {
          p.pixelDensity(1);
          p.createCanvas(THUMB_W, THUMB_H).parent(host);
          p.noLoop();
          p.background(diagram.meta.background || '#101418');
          const scale = Math.min(THUMB_W / diagram.meta.width, THUMB_H / diagram.meta.height);
          p.push();
          p.translate((THUMB_W - diagram.meta.width * scale) / 2, (THUMB_H - diagram.meta.height * scale) / 2);
          p.scale(scale);
          global.DG.renderDiagramP5(p, diagram, { showLabels: false });
          p.pop();
          p.canvas.toBlob((blob) => {
            p.remove();
            host.remove();
            resolve(blob);
          }, 'image/png');
        };
      });
    });
  }

  async function saveDiagram(diagram, name) {
    const thumbnail = await renderThumbnail(diagram);
    const record = {
      id: `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      name: (name || `Diagram ${diagram.meta.seed || ''}`).trim(),
      savedAt: new Date().toISOString(),
      diagram,
      thumbnail,
    };
    await put(record);
    return record;
  }

  global.DG = global.DG || {};
  global.DG.library = { saveDiagram, listDiagrams, deleteDiagram, renameDiagram };
})(window);
