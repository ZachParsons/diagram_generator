/**
 * The diagram data model. This is the "wire format" that flows between
 * generator -> renderer, and that gets exported/imported as JSON so a
 * diagram produced here can be fed into a different visualizer, and a
 * diagram produced elsewhere can be fed into the renderers here.
 *
 * Diagram shape:
 * {
 *   meta: {
 *     seed, width, height, background,
 *     generatedAt (ISO string), generatorVersion
 *   },
 *   nodes: [
 *     {
 *       id, label, group,
 *       shape: 'oval' | 'triangle' | 'quad' | 'blob',  // a label describing how `points` was generated
 *       x, y,            // center position
 *       w, h,            // nominal bounding box used to derive `points` (independent, so never square/circular)
 *       points: [{x,y}, ...],  // closed outline, local coords relative to (x,y), pre-rotation
 *       curved,          // true: render as a smooth closed curve through `points`; false: straight edges
 *       rotation,        // radians
 *       fill, fillOpacity,  // fill is a CSS color string (e.g. 'hsl(210,70%,55%)' or '#3366ff'); shapes are unoutlined (fill only)
 *       children         // optional nested { nodes, edges } (same shapes recursively),
 *                        // clipped to this node's outline and rendered in this node's own
 *                        // local coordinate space (same origin/rotation as `points`) --
 *                        // see generator.js's generateChildDiagram()/params.recursionProbability
 *     }, ...
 *   ],
 *   edges: [
 *     {
 *       id,
 *       source, target,       // a node id string, a literal {x,y} point (a "floating"
 *                              // endpoint attached to nothing), or an edge reference
 *                              // { edgeRef: <edge id>, t: 0..1 } -- a point that far
 *                              // along another edge's own rendered path, attached to
 *                              // that edge rather than to any node
 *       extraSources,          // optional array of extra source refs (node id, {x,y},
 *                              // or edge ref) that converge into `source`, drawn as
 *                              // thin branch lines -- omit/[] for a plain single edge
 *       extraTargets,          // optional array of extra target refs that `target`
 *                              // splits/diverges into, drawn as thin branch lines
 *       style: 'straight' | 'curved' | 'orthogonal',   // path shape
 *       pattern: 'solid' | 'dashed' | 'dotted' | 'striped',  // stroke texture
 *       widthStart, widthEnd,      // taper: line width at the source vs target end
 *       opacityStart, opacityEnd,  // fade: opacity at the source vs target end
 *       color, color2,             // color2 is the alternate color for 'striped'
 *       arrowStart, arrowEnd,      // booleans, independent per end
 *       sourceGap, targetGap,      // extra pixels pulled back from a node's edge
 *                                  // (negative = overshoot into the node); ignored
 *                                  // for a literal-point (floating) endpoint
 *       controlPoint,              // optional {x,y} -- when present, overrides `style`
 *                                  // and bends the trunk through this exact point (set
 *                                  // by dragging the edge in the canvas view)
 *       loopAngle, loopSpread, loopSize,  // present only when source === target (a
 *                                  // self-loop): the loop's outward direction, the
 *                                  // angle between its two attachment points on the
 *                                  // node's boundary, and how far it bulges out as a
 *                                  // multiple of the node's radius
 *       label
 *     }, ...
 *   ]
 * }
 */
(function (global) {
  // Every shape here is generated with an irregularity floor (see generator.js
  // shapeGeometry()) so none of them can render as a perfect circle, equilateral
  // triangle, square/rectangle, or regular polygon -- always lopsided ovals,
  // scalene triangles, rhombus/trapezoid/kite-ish quads, and irregular blobs.
  const SHAPES = ['oval', 'triangle', 'quad', 'blob'];
  const EDGE_STYLES = ['straight', 'curved', 'orthogonal'];
  const EDGE_PATTERNS = ['solid', 'dashed', 'dotted', 'striped'];
  const EDGE_ARROW_MODES = ['none', 'start', 'end', 'both', 'random'];
  const LAYOUTS = ['grid', 'random', 'circular'];
  const EDGE_MODES = ['none', 'random', 'chain', 'star'];

  const GENERATOR_VERSION = '0.1.0';

  function defaultParams() {
    return {
      seed: DG.randomSeedString(),
      width: 900,
      height: 600,
      background: '#101418',

      nodeCount: 12,
      shapes: { oval: true, triangle: true, quad: true, blob: true },
      irregularity: 0.35,
      blobPointsMin: 6,
      blobPointsMax: 11,
      sizeMin: 24,
      sizeMax: 70,
      // When on, node size and edge width both sample from the bottom or
      // top 40% of their min/max range instead of the whole span, so
      // results cluster into visibly distinct small/large tiers instead of
      // an even spread -- see generator.js's tieredRange().
      sizeTiers: true,
      largeTierProbability: 0.4,
      rotationRandom: true,
      showNodeLabels: true,

      layout: 'random',
      padding: 40,

      hueMin: 0,
      hueMax: 360,
      saturation: 65,
      lightnessMin: 40,
      lightnessMax: 65,
      fillOpacityMin: 0.55,
      fillOpacityMax: 0.95,

      edgeMode: 'random',
      edgeProbability: 0.15,
      edgeStyle: 'curved',
      edgePatterns: { solid: true, dashed: true, dotted: true, striped: true },
      edgeArrowMode: 'end',
      // Independent of the node color params, so edges are just as varied
      // and colorful as nodes without sharing a literal palette with them.
      edgeHueMin: 0,
      edgeHueMax: 360,
      edgeSaturationMin: 35,
      edgeSaturationMax: 85,
      edgeLightnessMin: 45,
      edgeLightnessMax: 80,
      edgeWidthMin: 1,
      edgeWidthMax: 5,
      edgeTaper: true,
      edgeOpacityMin: 0.35,
      edgeOpacityMax: 0.9,
      edgeFade: true,
      edgeEndOffsetJitter: 6,
      edgeBranchProbability: 0.12,
      floatingEdgeCount: 3,
      selfLoopProbability: 0.08,
      // Chance that a branch endpoint or floating edge endpoint attaches to
      // another edge (a point partway along its path) instead of a node or
      // bare {x,y} point -- see generator.js's maybeEdgeEndpoint().
      edgeToEdgeProbability: 0.1,

      // Recursion: nodes can contain their own nested nodes/edges, clipped
      // to the parent node's shape -- see generator.js's generateChildDiagram().
      // Off by default (probability 0) since it's the more expensive/dense option.
      recursionProbability: 0,
      recursionMaxDepth: 2,
      recursionMinChildren: 2,
      recursionMaxChildren: 4,

      useInputData: false,
      // When on (and an image has been loaded this session -- see
      // main.js's loadImageFile()), generateFromImage() drives node
      // position/color/edges instead of pure random or useInputData.
      // Takes priority over useInputData if both are on.
      useImageData: false,
    };
  }

  function createEmptyDiagram(meta) {
    return {
      meta: Object.assign(
        {
          seed: '',
          width: 900,
          height: 600,
          background: '#101418',
          generatedAt: new Date().toISOString(),
          generatorVersion: GENERATOR_VERSION,
        },
        meta || {}
      ),
      nodes: [],
      edges: [],
    };
  }

  /**
   * Validates one { nodes, edges } level (the top-level diagram, or any
   * node's nested `children`) and recurses into every node's `children`.
   * `label` prefixes error messages so a problem inside a deeply nested
   * diagram still points at where it lives (e.g. `n3.children`).
   */
  function validateNodesEdges(nodes, edges, label, errors) {
    if (!Array.isArray(nodes)) {
      errors.push(`${label}: missing "nodes" array.`);
      return;
    }
    if (!Array.isArray(edges)) {
      errors.push(`${label}: missing "edges" array.`);
      return;
    }

    const ids = new Set();
    nodes.forEach((n, i) => {
      if (n.id === undefined || n.id === null) errors.push(`${label}: node[${i}] missing "id".`);
      else if (ids.has(n.id)) errors.push(`${label}: duplicate node id "${n.id}".`);
      else ids.add(n.id);
      if (typeof n.x !== 'number' || typeof n.y !== 'number') {
        errors.push(`${label}: node "${n.id}" missing numeric x/y.`);
      }
    });

    const edgeIds = new Set();
    edges.forEach((e) => {
      if (e.id !== undefined && e.id !== null) edgeIds.add(e.id);
    });
    // An edge endpoint is a known node id, a literal {x,y} point (a
    // "floating" endpoint not attached to any node), or an edge reference
    // { edgeRef: <edge id>, t } attaching to a point along another edge.
    function validEndpoint(ref) {
      if (typeof ref === 'string') return ids.has(ref);
      if (ref && typeof ref.edgeRef === 'string') return edgeIds.has(ref.edgeRef) && typeof ref.t === 'number';
      return ref && typeof ref.x === 'number' && typeof ref.y === 'number';
    }
    edges.forEach((e, i) => {
      if (!validEndpoint(e.source)) errors.push(`${label}: edge[${i}] source "${JSON.stringify(e.source)}" is not a known node id, edge ref, or {x,y} point.`);
      if (!validEndpoint(e.target)) errors.push(`${label}: edge[${i}] target "${JSON.stringify(e.target)}" is not a known node id, edge ref, or {x,y} point.`);
      (e.extraSources || []).forEach((ref, j) => {
        if (!validEndpoint(ref)) errors.push(`${label}: edge[${i}] extraSources[${j}] is not a known node id, edge ref, or {x,y} point.`);
      });
      (e.extraTargets || []).forEach((ref, j) => {
        if (!validEndpoint(ref)) errors.push(`${label}: edge[${i}] extraTargets[${j}] is not a known node id, edge ref, or {x,y} point.`);
      });
    });

    nodes.forEach((n) => {
      if (n.children) validateNodesEdges(n.children.nodes, n.children.edges, `${label}: node "${n.id}".children`, errors);
    });
  }

  /** Very light structural check so a hand-edited/foreign JSON file fails loudly, not silently. */
  function validateDiagram(diagram) {
    const errors = [];
    if (!diagram || typeof diagram !== 'object') {
      return ['Diagram must be an object.'];
    }
    if (!diagram.meta) errors.push('Missing "meta".');
    if (!Array.isArray(diagram.nodes)) errors.push('Missing "nodes" array.');
    if (!Array.isArray(diagram.edges)) errors.push('Missing "edges" array.');
    if (errors.length) return errors;

    validateNodesEdges(diagram.nodes, diagram.edges, 'diagram', errors);
    return errors;
  }

  global.DG = global.DG || {};
  Object.assign(global.DG, {
    SHAPES,
    EDGE_STYLES,
    EDGE_PATTERNS,
    EDGE_ARROW_MODES,
    LAYOUTS,
    EDGE_MODES,
    GENERATOR_VERSION,
    defaultParams,
    createEmptyDiagram,
    validateDiagram,
  });
})(window);
