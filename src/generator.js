/**
 * Turns a params object (+ optional input data) into a diagram JSON
 * object following the schema in schema.js. This is the only place
 * that knows how "random" maps to actual node/edge values; renderers
 * never see params, only the resulting diagram.
 */
(function (global) {
  function hslString(h, s, l, a) {
    // p5's CSS color parser only accepts an integer hue (a decimal point fails to match its regex).
    h = Math.round(((h % 360) + 360) % 360);
    l = l.toFixed(1);
    return a === undefined ? `hsl(${h}, ${s}%, ${l}%)` : `hsla(${h}, ${s}%, ${l}%, ${a.toFixed(2)})`;
  }

  /**
   * Whether a size roll should land in the "large" tier, the "small" tier,
   * or (tiers disabled) neither -- shared by node sizing and edge width so
   * "more variance, some smalls and some larges" means the same thing in
   * both places. Returns null when tiering is off, else a boolean.
   */
  function pickSizeTier(rng, params) {
    return params.sizeTiers ? rng.bool(params.largeTierProbability) : null;
  }

  /**
   * Samples within [min,max], but when `isLarge` isn't null, restricts to
   * the top 40% (large) or bottom 40% (small) of the range instead of the
   * whole span -- leaving a gap in the middle so results cluster into two
   * visibly distinct size classes rather than spreading evenly.
   */
  function tieredRange(rng, min, max, isLarge) {
    if (isLarge === null) return rng.range(min, max);
    const span = max - min;
    return isLarge ? rng.range(min + span * 0.6, max) : rng.range(min, min + span * 0.4);
  }

  function pickShape(params, rng) {
    const enabled = DG.SHAPES.filter((s) => params.shapes[s]);
    return enabled.length ? rng.pick(enabled) : 'blob';
  }

  // Per-shape-family base irregularity, tuned so each family reads as a
  // distinct kind of shape while never collapsing into a regular/symmetric
  // one (see SHAPE_FAMILY comment below for why there's always a floor).
  const SHAPE_FAMILY = {
    oval: { vertices: () => 7, angleJitter: 0.1, radiusJitter: 0.2, curved: true },
    triangle: { vertices: () => 3, angleJitter: 0.32, radiusJitter: 0.45, curved: false },
    quad: { vertices: () => 4, angleJitter: 0.28, radiusJitter: 0.4, curved: false },
    blob: {
      vertices: (rng, params) => rng.int(params.blobPointsMin, params.blobPointsMax),
      angleJitter: 0.22,
      // Higher than the other families -- blobs are meant to read as the
      // most organic/cavitated shape -- safe because irregularPoints()
      // hard-caps the neighbor-to-neighbor radius ratio for curved
      // families, which is what actually prevents the self-intersection
      // artifact regardless of how high this goes.
      radiusJitter: 0.65,
      curved: true,
    },
  };

  // --- self-intersection detection (curved shapes only) --------------------
  // A hand-rolled reimplementation of p5's Catmull-Rom curve math (sampling
  // the curve, checking sampled segments for crossings) turned out to
  // subtly diverge from what p5 actually renders in a way that was hard to
  // pin down -- it kept missing real self-intersections. Rather than keep
  // guessing at p5's exact internals, this renders the candidate outline at
  // a small fixed scale with the literal same curveVertex/endShape(CLOSE)
  // call sequence drawCurvedClosed (canvasRenderer.js) uses, then flood-
  // fills background pixels reachable from the canvas border; any
  // background pixel NOT reached is enclosed by the outline -- a self-
  // intersection hole. Checking the literal thing that gets drawn is more
  // reliable than any approximation of it.
  // Large enough that a real self-intersection hole (which can be a very
  // thin sliver) reliably survives anti-aliasing and shows up as more than
  // a pixel or two -- empirically, checking at only ~100px missed holes
  // that were clearly visible (hundreds of pixels) once actually rendered
  // at typical node/canvas size.
  const HOLE_CHECK_SIZE = 600;
  let holeCheckP5 = null;
  (function initHoleCheckP5() {
    if (typeof window === 'undefined' || typeof window.p5 !== 'function') return;
    const host = document.createElement('div');
    host.style.position = 'fixed';
    host.style.left = '-9999px';
    host.style.top = '-9999px';
    document.body.appendChild(host);
    new window.p5((p) => {
      p.setup = () => {
        p.pixelDensity(1);
        p.createCanvas(HOLE_CHECK_SIZE, HOLE_CHECK_SIZE).parent(host);
        p.noLoop();
        p.noStroke();
        holeCheckP5 = p;
      };
    });
  })();

  /** Background (near-black) pixels NOT reachable from the canvas border without crossing fill -- i.e. enclosed holes. */
  function countEnclosedPixels(p) {
    const canvas = p.canvas;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    const img = ctx.getImageData(0, 0, w, h).data;
    const isBg = (i) => img[i * 4] < 20 && img[i * 4 + 1] < 20 && img[i * 4 + 2] < 20;
    const n = w * h;
    const reached = new Uint8Array(n);
    const stack = [];
    const seed = (i) => {
      if (isBg(i) && !reached[i]) {
        reached[i] = 1;
        stack.push(i);
      }
    };
    for (let x = 0; x < w; x++) {
      seed(x);
      seed((h - 1) * w + x);
    }
    for (let y = 0; y < h; y++) {
      seed(y * w);
      seed(y * w + w - 1);
    }
    while (stack.length) {
      const i = stack.pop();
      const x = i % w;
      const y = (i / w) | 0;
      if (x > 0) seed(i - 1);
      if (x < w - 1) seed(i + 1);
      if (y > 0) seed(i - w);
      if (y < h - 1) seed(i + w);
    }
    let count = 0;
    for (let i = 0; i < n; i++) {
      if (isBg(i) && !reached[i]) count++;
    }
    return count;
  }

  /**
   * True if the closed curve through `points` has a self-intersection hole.
   * If the checker isn't ready yet (e.g. the very first diagram generated
   * right on page load, before its own p5 instance finishes an async
   * setup), this can't validate -- it returns false (accept the candidate
   * as-is) rather than block generation; every later call is validated.
   */
  function curveHasHole(points) {
    if (!holeCheckP5) return false;
    const p = holeCheckP5;
    const n = points.length;
    let maxR = 1;
    points.forEach((pt) => {
      maxR = Math.max(maxR, Math.hypot(pt.x, pt.y));
    });
    const scale = (HOLE_CHECK_SIZE * 0.4) / maxR;
    p.background(0);
    p.push();
    p.translate(HOLE_CHECK_SIZE / 2, HOLE_CHECK_SIZE / 2);
    p.scale(scale);
    p.fill(255);
    p.beginShape();
    p.curveVertex(points[n - 1].x, points[n - 1].y);
    points.forEach((pt) => p.curveVertex(pt.x, pt.y));
    p.curveVertex(points[0].x, points[0].y);
    p.curveVertex(points[1].x, points[1].y);
    p.endShape(p.CLOSE);
    p.pop();
    return countEnclosedPixels(p) > 3; // a pixel or two of anti-aliasing noise is not a real hole
  }

  /** Nudges every point toward the average of its two neighbors -- a generic, angle-agnostic smoothing pass. */
  function relaxPoints(points) {
    const n = points.length;
    return points.map((pt, i) => {
      const prev = points[(i - 1 + n) % n];
      const next = points[(i + 1) % n];
      return { x: pt.x * 0.5 + (prev.x + next.x) * 0.25, y: pt.y * 0.5 + (prev.y + next.y) * 0.25 };
    });
  }

  /**
   * Vertices around an ellipse of half-axes (w/2, h/2), each pushed off its
   * evenly-spaced base angle and base radius by a random amount. `params.
   * irregularity` (0-1) scales the jitter on top of each shape family's own
   * base amount; the 0.5 floor means a shape is never perfectly regular even
   * at irregularity=0 -- ovals, triangles, quads and blobs should always
   * read as asymmetric, never as circles/equilateral triangles/rhombi-by-
   * accident-of-symmetry.
   */
  function irregularPoints(rng, n, w, h, angleJitterFrac, radiusJitterFrac, curved) {
    const rx = w / 2;
    const ry = h / 2;
    const step = (Math.PI * 2) / n;
    // Cap jitter well under half a step so vertices can't cross their neighbors' base angle.
    const angleJitter = Math.min(angleJitterFrac, 0.42) * step;
    const radiusJitter = Math.min(radiusJitterFrac, 1.2);

    function sample() {
      const points = [];
      for (let i = 0; i < n; i++) {
        const angle = i * step + rng.range(-angleJitter, angleJitter);
        const radiusScale = 1 + rng.range(-radiusJitter, radiusJitter);
        points.push({ x: Math.cos(angle) * rx * radiusScale, y: Math.sin(angle) * ry * radiusScale });
      }
      return points;
    }

    if (!curved) return sample(); // straight-edged: the angle cap alone already prevents crossing

    // A curved outline (Catmull-Rom, see drawCurvedClosed in
    // canvasRenderer.js) overshoots past its control points, and an
    // extreme jitter combination can make the curve loop back on itself --
    // a thin, unfilled, "bug-like" self-intersection. Rather than damping
    // the jitter itself (which would flatten out the deep, organic dents
    // that make blobs interesting), just re-roll: a fresh independent
    // sample is very likely to come out clean, so this preserves full
    // jitter range/character for every shape that doesn't actually have
    // the problem. Only in the rare case every attempt still crosses
    // itself does it fall back to progressively relaxing the last attempt
    // until it's clean, which is guaranteed to terminate (relaxing enough
    // times converges toward a convex, non-self-intersecting shape).
    let candidate = sample();
    for (let attempt = 1; attempt < 8 && curveHasHole(candidate); attempt++) {
      candidate = sample();
    }
    for (let relax = 0; relax < 5 && curveHasHole(candidate); relax++) {
      candidate = relaxPoints(candidate);
    }
    for (let fallback = 0; fallback < 3 && curveHasHole(candidate); fallback++) {
      // Last resort (very rare): every re-roll and relax pass still crossed
      // itself. Fall back to a mild, safely-in-range jitter (both angle and
      // radius, regardless of how extreme the requested setting is) plus a
      // couple of relax passes for extra margin, for just this one shape,
      // rather than ship something visibly broken -- still irregular/
      // asymmetric, just not as extreme as the requested setting.
      candidate = [];
      const mildAngleJitter = 0.08 * step;
      for (let i = 0; i < n; i++) {
        const angle = i * step + rng.range(-mildAngleJitter, mildAngleJitter);
        const radiusScale = 1 + rng.range(-0.12, 0.12);
        candidate.push({ x: Math.cos(angle) * rx * radiusScale, y: Math.sin(angle) * ry * radiusScale });
      }
      candidate = relaxPoints(relaxPoints(candidate));
    }
    if (curveHasHole(candidate)) {
      // Truly last resort: a perfectly regular n-gon inscribed in the
      // ellipse. Convex and evenly spaced, so it geometrically cannot
      // self-intersect -- this sacrifices "never regular" only for this
      // one shape in this one vanishingly rare case, rather than risk
      // shipping a visible hole no matter how many attempts came before.
      candidate = [];
      for (let i = 0; i < n; i++) {
        candidate.push({ x: Math.cos(i * step) * rx, y: Math.sin(i * step) * ry });
      }
    }
    return candidate;
  }

  function shapeGeometry(shape, w, h, params, rng) {
    const family = SHAPE_FAMILY[shape] || SHAPE_FAMILY.blob;
    const jitterAmp = 0.5 + params.irregularity; // never fully regular, scales up to 1.5x with the slider
    const n = family.vertices(rng, params);
    const points = irregularPoints(rng, n, w, h, family.angleJitter * jitterAmp, family.radiusJitter * jitterAmp, family.curved);
    return { points, curved: family.curved };
  }

  function styleNode(params, rng, hue) {
    const h = hue !== undefined ? hue : rng.range(params.hueMin, params.hueMax);
    const fillL = rng.range(params.lightnessMin, params.lightnessMax);
    const fillA = rng.range(params.fillOpacityMin, params.fillOpacityMax);
    return {
      fill: hslString(h, params.saturation, fillL, fillA),
      fillOpacity: fillA,
    };
  }

  function buildNode(id, label, group, shape, pos, size, params, rng, hue) {
    const style = styleNode(params, rng, hue);
    const geometry = shapeGeometry(shape, size.w, size.h, params, rng);
    return {
      id,
      label,
      group: group || null,
      shape,
      x: pos.x,
      y: pos.y,
      w: size.w,
      h: size.h,
      points: geometry.points,
      curved: geometry.curved,
      rotation: params.rotationRandom ? rng.range(0, Math.PI * 2) : 0,
      ...style,
    };
  }

  function pickPattern(params, rng) {
    const enabled = DG.EDGE_PATTERNS.filter((p) => params.edgePatterns[p]);
    return enabled.length ? rng.pick(enabled) : 'solid';
  }

  function resolveArrowMode(params, rng) {
    return params.edgeArrowMode === 'random' ? rng.pick(['none', 'start', 'end', 'both']) : params.edgeArrowMode;
  }

  function edgeStyleValues(params, rng) {
    const widthStart = tieredRange(rng, params.edgeWidthMin, params.edgeWidthMax, pickSizeTier(rng, params));
    const opacityStart = rng.range(params.edgeOpacityMin, params.edgeOpacityMax);
    const arrowMode = resolveArrowMode(params, rng);
    return {
      style: params.edgeStyle,
      pattern: pickPattern(params, rng),
      widthStart,
      widthEnd: params.edgeTaper ? tieredRange(rng, params.edgeWidthMin, params.edgeWidthMax, pickSizeTier(rng, params)) : widthStart,
      opacityStart,
      opacityEnd: params.edgeFade ? rng.range(params.edgeOpacityMin, params.edgeOpacityMax) : opacityStart,
      // Edges get their own independent hue/saturation/lightness ranges --
      // not tied to the node color params -- so they're just as varied and
      // colorful as nodes without literally sharing a palette with them.
      color: hslString(
        rng.range(params.edgeHueMin, params.edgeHueMax),
        rng.range(params.edgeSaturationMin, params.edgeSaturationMax),
        rng.range(params.edgeLightnessMin, params.edgeLightnessMax)
      ),
      color2: hslString(
        rng.range(params.edgeHueMin, params.edgeHueMax),
        rng.range(params.edgeSaturationMin, params.edgeSaturationMax),
        rng.range(params.edgeLightnessMin, params.edgeLightnessMax)
      ),
      arrowStart: arrowMode === 'start' || arrowMode === 'both',
      arrowEnd: arrowMode === 'end' || arrowMode === 'both',
      sourceGap: rng.range(-params.edgeEndOffsetJitter, params.edgeEndOffsetJitter),
      targetGap: rng.range(-params.edgeEndOffsetJitter, params.edgeEndOffsetJitter),
    };
  }

  function makeEdge(id, source, target, params, rng) {
    const edge = { id, source, target, label: null, ...edgeStyleValues(params, rng) };
    if (typeof source === 'string' && source === target) {
      // A self-loop: canvasRenderer draws a loop bulging out from the node
      // rather than the normal source->target trunk (which would be
      // degenerate here, both ends resolving to the same point). These
      // three values are all it needs, decided here so the renderer stays
      // pure/data-driven rather than rolling its own hidden randomness.
      edge.loopAngle = rng.range(0, Math.PI * 2); // outward direction the loop bulges
      edge.loopSpread = rng.range(0.35, 0.7); // radians between the loop's two attachment points
      edge.loopSize = rng.range(0.8, 1.6); // how far it bulges out, as a multiple of the node's radius
    }
    return edge;
  }

  /**
   * With probability `edgeToEdgeProbability`, replaces `fallback` (a node id
   * or bare {x,y} point) with a reference to a point partway along one of
   * `edges` instead -- an endpoint attached to another edge rather than to
   * any node. `edges` is whatever's already been generated so far, so an
   * edge can only ever attach to an earlier edge, never to itself.
   */
  function maybeEdgeEndpoint(rng, params, edges, fallback) {
    if (edges.length && rng.bool(params.edgeToEdgeProbability)) {
      return { edgeRef: rng.pick(edges).id, t: rng.range(0, 1) };
    }
    return fallback;
  }

  /**
   * With probability `edgeBranchProbability`, turns a plain edge into a
   * split (extra branch fanning out from the target) or a converge (extra
   * branch feeding into the source). The branch endpoint is usually another
   * node, but is sometimes a bare {x,y} point or a reference to another edge
   * -- an edge end that isn't attached to any node at all.
   */
  function maybeAddBranch(edge, nodes, edges, params, rng) {
    if (!rng.bool(params.edgeBranchProbability)) return;
    const usedIds = new Set([edge.source, edge.target]);
    const candidates = nodes.filter((n) => !usedIds.has(n.id));
    const fallback =
      candidates.length && rng.bool(0.7)
        ? rng.pick(candidates).id
        : { x: rng.range(0, params.width), y: rng.range(0, params.height) };
    const endpoint = maybeEdgeEndpoint(rng, params, edges, fallback);
    if (rng.bool(0.5)) {
      edge.extraTargets = [endpoint];
    } else {
      edge.extraSources = [endpoint];
    }
  }

  function generateRandomEdges(nodes, params, rng) {
    const edges = [];
    let n = 0;
    if (params.edgeMode !== 'none' && nodes.length >= 2) {
      const push = (source, target) => {
        const edge = makeEdge(`e${n++}`, source, target, params, rng);
        maybeAddBranch(edge, nodes, edges, params, rng);
        edges.push(edge);
      };

      if (params.edgeMode === 'chain') {
        for (let i = 0; i < nodes.length - 1; i++) push(nodes[i].id, nodes[i + 1].id);
      } else if (params.edgeMode === 'star') {
        for (let i = 1; i < nodes.length; i++) push(nodes[0].id, nodes[i].id);
      } else if (params.edgeMode === 'random') {
        for (let i = 0; i < nodes.length; i++) {
          for (let j = i + 1; j < nodes.length; j++) {
            if (rng.bool(params.edgeProbability)) push(nodes[i].id, nodes[j].id);
          }
        }
      }

      // Self-loops: a node connecting to itself. Not run through maybeAddBranch --
      // a converge/split branch on top of a loop doesn't make sense.
      nodes.forEach((node) => {
        if (rng.bool(params.selfLoopProbability)) edges.push(makeEdge(`s${n++}`, node.id, node.id, params, rng));
      });
    }

    // Decorative edges with both ends floating free in space, attached to no
    // node at all (or, sometimes, attached instead to another edge) -- the
    // most literal reading of "edges that don't start or end at a node".
    for (let i = 0; i < params.floatingEdgeCount; i++) {
      const aFallback = { x: rng.range(0, params.width), y: rng.range(0, params.height) };
      const bFallback = { x: rng.range(0, params.width), y: rng.range(0, params.height) };
      const a = maybeEdgeEndpoint(rng, params, edges, aFallback);
      const b = maybeEdgeEndpoint(rng, params, edges, bFallback);
      edges.push(makeEdge(`f${i}`, a, b, params, rng));
    }

    return edges;
  }

  /**
   * A nested { nodes, edges } living entirely within a `boxW` x `boxH` box
   * centered on (0,0) -- the same local coordinate convention as a node's
   * own `points` -- so it can be rendered directly inside the parent node's
   * transform with no extra translate/scale. Recurses into its own
   * children up to `params.recursionMaxDepth`, each recursion shrinking the
   * box so nesting can't outgrow its container.
   */
  function generateChildDiagram(boxW, boxH, idPrefix, params, rng, depth) {
    const count = rng.int(params.recursionMinChildren, params.recursionMaxChildren);
    const padding = Math.min(boxW, boxH) * 0.12;
    const positions = DG.layouts[params.layout](count, boxW, boxH, padding, rng).map((pt) => ({
      x: pt.x - boxW / 2,
      y: pt.y - boxH / 2,
    }));
    const minDim = Math.min(boxW, boxH);
    const sizeMin = Math.max(4, minDim * 0.18);
    const sizeMax = Math.max(sizeMin + 1, minDim * 0.4);

    const nodes = [];
    for (let i = 0; i < count; i++) {
      const shape = pickShape(params, rng);
      const sizeTier = pickSizeTier(rng, params);
      const w = tieredRange(rng, sizeMin, sizeMax, sizeTier);
      const h = tieredRange(rng, sizeMin, sizeMax, sizeTier);
      const node = buildNode(`${idPrefix}n${i}`, `${idPrefix}n${i}`, null, shape, positions[i], { w, h }, params, rng);
      if (depth < params.recursionMaxDepth && rng.bool(params.recursionProbability)) {
        node.children = generateChildDiagram(w * 0.85, h * 0.85, `${node.id}.`, params, rng, depth + 1);
      }
      nodes.push(node);
    }

    // Reuses the normal random-edge generator, boxed to this local space --
    // floating edges are capped low so nested diagrams stay legible rather
    // than adding their own full share of decorative clutter.
    const childParams = Object.assign({}, params, { width: boxW, height: boxH, floatingEdgeCount: Math.min(params.floatingEdgeCount, 1) });
    const edges = generateRandomEdges(nodes, childParams, rng);
    return { nodes, edges };
  }

  /** Fully random generation driven only by params. */
  function generateDiagram(params) {
    const rng = new DG.SeededRNG(params.seed);
    const diagram = DG.createEmptyDiagram({
      seed: params.seed,
      width: params.width,
      height: params.height,
      background: params.background,
    });

    const positions = DG.layouts[params.layout](params.nodeCount, params.width, params.height, params.padding, rng);

    for (let i = 0; i < params.nodeCount; i++) {
      const shape = pickShape(params, rng);
      const sizeTier = pickSizeTier(rng, params);
      const w = tieredRange(rng, params.sizeMin, params.sizeMax, sizeTier);
      const h = tieredRange(rng, params.sizeMin, params.sizeMax, sizeTier);
      const node = buildNode(`n${i}`, `N${i}`, null, shape, positions[i], { w, h }, params, rng);
      if (params.recursionMaxDepth > 0 && rng.bool(params.recursionProbability)) {
        node.children = generateChildDiagram(w * 0.85, h * 0.85, `${node.id}.`, params, rng, 1);
      }
      diagram.nodes.push(node);
    }

    diagram.edges = generateRandomEdges(diagram.nodes, params, rng);
    return diagram;
  }

  /**
   * Generation seeded by real input data: node identity/labels/grouping
   * and the relationship graph come from `inputData`, while position and
   * visual style still come from the same randomization params/RNG. This
   * is the seam for "generate diagrams from given input data" -- swap
   * this function's input for a real dataset and everything downstream
   * (renderers, export) keeps working unchanged.
   *
   * inputData shape: { nodes: [{ id, label, group, connections: [id, ...] }] }
   */
  function generateFromData(inputData, params) {
    const rng = new DG.SeededRNG(params.seed);
    const diagram = DG.createEmptyDiagram({
      seed: params.seed,
      width: params.width,
      height: params.height,
      background: params.background,
    });

    const dataNodes = (inputData && inputData.nodes) || [];
    const positions = DG.layouts[params.layout](dataNodes.length, params.width, params.height, params.padding, rng);

    // Stable hue per group so related nodes read as visually related.
    const groupHues = new Map();
    function hueForGroup(group) {
      if (!group) return undefined;
      if (!groupHues.has(group)) groupHues.set(group, rng.range(params.hueMin, params.hueMax));
      return groupHues.get(group);
    }

    dataNodes.forEach((dn, i) => {
      const shape = pickShape(params, rng);
      const sizeTier = pickSizeTier(rng, params);
      const w = tieredRange(rng, params.sizeMin, params.sizeMax, sizeTier);
      const h = tieredRange(rng, params.sizeMin, params.sizeMax, sizeTier);
      diagram.nodes.push(
        buildNode(
          dn.id !== undefined ? String(dn.id) : `n${i}`,
          dn.label !== undefined ? dn.label : String(dn.id),
          dn.group,
          shape,
          positions[i],
          { w, h },
          params,
          rng,
          hueForGroup(dn.group)
        )
      );
    });

    const seen = new Set();
    let n = 0;
    dataNodes.forEach((dn) => {
      const sourceId = dn.id !== undefined ? String(dn.id) : null;
      (dn.connections || []).forEach((targetRaw) => {
        const targetId = String(targetRaw);
        if (sourceId === null) return;
        const key = [sourceId, targetId].sort().join('::');
        if (seen.has(key)) return;
        seen.add(key);
        diagram.edges.push(makeEdge(`e${n++}`, sourceId, targetId, params, rng));
      });
    });

    return diagram;
  }

  global.DG = global.DG || {};
  Object.assign(global.DG, { generateDiagram, generateFromData });
})(window);
