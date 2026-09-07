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
  // the sidebar); the diagram's logical width/height (from params, fixed at
  // generation time) is scaled+centered to fit inside it ("contain"), so the
  // diagram is never confined to a small fixed-size box.
  // While dragging: { kind: 'node', node, grabDX, grabDY }
  //              | { kind: 'edgeEndpoint', edge, which }        -- which: 'source' | 'target'
  //              | { kind: 'edgeExtra', edge, which, index }    -- which: 'extraSources' | 'extraTargets'
  //              | { kind: 'edgeBend', edge }
  let dragState = null;

  function fitTransform(p) {
    const dw = currentDiagram.meta.width;
    const dh = currentDiagram.meta.height;
    const scale = Math.min(p.width / dw, p.height / dh) || 1;
    return {
      scale,
      offsetX: (p.width - dw * scale) / 2,
      offsetY: (p.height - dh * scale) / 2,
    };
  }

  function toDiagramSpace(p, mx, my) {
    const t = fitTransform(p);
    return { x: (mx - t.offsetX) / t.scale, y: (my - t.offsetY) / t.scale };
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
      p.background(currentDiagram.meta.background);
      const t = fitTransform(p);
      p.push();
      p.translate(t.offsetX, t.offsetY);
      p.scale(t.scale);
      DG.renderDiagramP5(p, currentDiagram);
      p.pop();
    };

    function withinCanvas() {
      return p.mouseX >= 0 && p.mouseY >= 0 && p.mouseX <= p.width && p.mouseY <= p.height;
    }

    p.mousePressed = () => {
      if (!currentDiagram || !withinCanvas()) return;
      const pt = toDiagramSpace(p, p.mouseX, p.mouseY);

      const node = DG.hitTestNode(currentDiagram, pt.x, pt.y);
      if (node) {
        dragState = { kind: 'node', node, grabDX: pt.x - node.x, grabDY: pt.y - node.y };
        p.canvas.classList.add('dragging');
        return;
      }

      // A grab threshold in diagram-space units, roughly matching a ~6px reach on screen.
      const edgeHit = DG.hitTestEdge(currentDiagram, pt.x, pt.y, 6 / (fitTransform(p).scale || 1));
      if (edgeHit) {
        dragState = { kind: edgeHit.kind === 'endpoint' ? 'edgeEndpoint' : edgeHit.kind === 'extra' ? 'edgeExtra' : 'edgeBend', edge: edgeHit.edge, which: edgeHit.which, index: edgeHit.index };
        p.canvas.classList.add('dragging');
      }
    };

    p.mouseDragged = () => {
      if (!dragState) return;
      const pt = toDiagramSpace(p, p.mouseX, p.mouseY);
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
  DG.setupControls(params, {
    onChange: regenerate,
    onRegenerate: regenerate,
    onExportJSON: exportDiagramJSON,
    onExportPNG: exportPNG,
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

  function exportDiagramJSON() {
    if (!currentDiagram) return;
    const blob = new Blob([JSON.stringify(currentDiagram, null, 2)], { type: 'application/json' });
    downloadBlob(`diagram-${currentDiagram.meta.seed}.json`, blob);
    setStatus('Exported diagram JSON.');
  }

  function exportPNG() {
    if (!p5Instance) return;
    p5Instance.saveCanvas(`diagram-${params.seed}`, 'png');
    setStatus('Exported PNG.');
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
