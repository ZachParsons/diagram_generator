/**
 * Tweakpane parameter panel. Knows nothing about p5 or rendering --
 * it just mutates the shared `params` object and calls back whenever
 * something changes so main.js can regenerate + redraw.
 */
(function (global) {
  function setupControls(params, callbacks) {
    const pane = new Tweakpane.Pane({ title: 'Diagram Parameters', container: document.getElementById('pane-container') });

    const onChange = () => callbacks.onChange();

    // A new random seed, keeping every other control exactly as set --
    // this is what makes "give me a new diagram with the same values" work.
    function rerollSeed() {
      params.seed = DG.randomSeedString();
      pane.refresh();
      onChange();
    }

    // --- Global -----------------------------------------------------
    const global_ = pane.addFolder({ title: 'Global' });
    global_.addInput(params, 'seed', { label: 'Seed' }).on('change', onChange);
    global_.addButton({ title: 'Randomize Seed' }).on('click', rerollSeed);
    global_.addInput(params, 'width', { label: 'Width', min: 200, max: 2000, step: 10 }).on('change', onChange);
    global_.addInput(params, 'height', { label: 'Height', min: 200, max: 2000, step: 10 }).on('change', onChange);
    global_.addInput(params, 'background', { label: 'Background' }).on('change', onChange);

    // --- Nodes --------------------------------------------------------
    const nodes = pane.addFolder({ title: 'Nodes' });
    nodes.addInput(params, 'nodeCount', { label: 'Count', min: 1, max: 200, step: 1 }).on('change', onChange);
    const shapesFolder = nodes.addFolder({ title: 'Enabled shapes' });
    DG.SHAPES.forEach((shape) => {
      shapesFolder.addInput(params.shapes, shape, { label: shape }).on('change', onChange);
    });
    nodes.addInput(params, 'irregularity', { label: 'Irregularity', min: 0, max: 1, step: 0.01 }).on('change', onChange);
    nodes.addInput(params, 'blobPointsMin', { label: 'Blob points min', min: 4, max: 20, step: 1 }).on('change', onChange);
    nodes.addInput(params, 'blobPointsMax', { label: 'Blob points max', min: 4, max: 20, step: 1 }).on('change', onChange);
    nodes.addInput(params, 'sizeMin', { label: 'Size min', min: 4, max: 400, step: 1 }).on('change', onChange);
    nodes.addInput(params, 'sizeMax', { label: 'Size max', min: 4, max: 400, step: 1 }).on('change', onChange);
    nodes.addInput(params, 'rotationRandom', { label: 'Random rotation' }).on('change', onChange);

    // --- Layout ---------------------------------------------------------
    const layout = pane.addFolder({ title: 'Layout' });
    layout
      .addInput(params, 'layout', { label: 'Mode', options: { Grid: 'grid', Random: 'random', Circular: 'circular' } })
      .on('change', onChange);
    layout.addInput(params, 'padding', { label: 'Padding', min: 0, max: 300, step: 1 }).on('change', onChange);

    // --- Style ---------------------------------------------------------
    const style = pane.addFolder({ title: 'Style' });
    style.addInput(params, 'hueMin', { label: 'Hue min', min: 0, max: 360, step: 1 }).on('change', onChange);
    style.addInput(params, 'hueMax', { label: 'Hue max', min: 0, max: 360, step: 1 }).on('change', onChange);
    style.addInput(params, 'saturation', { label: 'Saturation %', min: 0, max: 100, step: 1 }).on('change', onChange);
    style.addInput(params, 'lightnessMin', { label: 'Lightness min %', min: 0, max: 100, step: 1 }).on('change', onChange);
    style.addInput(params, 'lightnessMax', { label: 'Lightness max %', min: 0, max: 100, step: 1 }).on('change', onChange);
    style.addInput(params, 'fillOpacityMin', { label: 'Fill opacity min', min: 0, max: 1, step: 0.01 }).on('change', onChange);
    style.addInput(params, 'fillOpacityMax', { label: 'Fill opacity max', min: 0, max: 1, step: 0.01 }).on('change', onChange);

    // --- Edges / relationships ------------------------------------------
    const edges = pane.addFolder({ title: 'Relationships (edges)' });
    edges
      .addInput(params, 'edgeMode', {
        label: 'Mode',
        options: { None: 'none', Random: 'random', Chain: 'chain', Star: 'star' },
      })
      .on('change', onChange);
    edges.addInput(params, 'edgeProbability', { label: 'Probability', min: 0, max: 1, step: 0.01 }).on('change', onChange);
    edges
      .addInput(params, 'edgeStyle', {
        label: 'Path shape',
        options: { Straight: 'straight', Curved: 'curved', Orthogonal: 'orthogonal' },
      })
      .on('change', onChange);
    const patternsFolder = edges.addFolder({ title: 'Enabled textures' });
    DG.EDGE_PATTERNS.forEach((pattern) => {
      patternsFolder.addInput(params.edgePatterns, pattern, { label: pattern }).on('change', onChange);
    });
    edges
      .addInput(params, 'edgeArrowMode', {
        label: 'Arrowheads',
        options: { None: 'none', Start: 'start', End: 'end', Both: 'both', Random: 'random' },
      })
      .on('change', onChange);
    edges.addInput(params, 'edgeWidthMin', { label: 'Width min', min: 0.5, max: 20, step: 0.5 }).on('change', onChange);
    edges.addInput(params, 'edgeWidthMax', { label: 'Width max', min: 0.5, max: 20, step: 0.5 }).on('change', onChange);
    edges.addInput(params, 'edgeTaper', { label: 'Taper (differing ends)' }).on('change', onChange);
    edges.addInput(params, 'edgeOpacityMin', { label: 'Opacity min', min: 0, max: 1, step: 0.01 }).on('change', onChange);
    edges.addInput(params, 'edgeOpacityMax', { label: 'Opacity max', min: 0, max: 1, step: 0.01 }).on('change', onChange);
    edges.addInput(params, 'edgeFade', { label: 'Fade (differing ends)' }).on('change', onChange);
    edges
      .addInput(params, 'edgeEndOffsetJitter', { label: 'End gap jitter', min: 0, max: 30, step: 1 })
      .on('change', onChange);
    edges
      .addInput(params, 'edgeBranchProbability', { label: 'Split/converge chance', min: 0, max: 1, step: 0.01 })
      .on('change', onChange);
    edges
      .addInput(params, 'floatingEdgeCount', { label: 'Floating edges', min: 0, max: 30, step: 1 })
      .on('change', onChange);

    // --- Actions ---------------------------------------------------------
    // Regenerate is a reroll (new seed, same settings) -- with an unchanged
    // seed the generator is deterministic, so re-running it would produce
    // pixel-identical output and look like the button did nothing.
    const actions = pane.addFolder({ title: 'Actions' });
    actions.addButton({ title: 'Regenerate' }).on('click', rerollSeed);
    actions.addButton({ title: 'Export diagram JSON' }).on('click', () => callbacks.onExportJSON());
    actions.addButton({ title: 'Export PNG' }).on('click', () => callbacks.onExportPNG());

    return pane;
  }

  global.DG = global.DG || {};
  global.DG.setupControls = setupControls;
})(window);
