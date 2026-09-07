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
      radiusJitter: 0.9,
      curved: true,
    },
  };

  /** True if segments p1->p2 and p3->p4 cross (sharing an endpoint doesn't count as crossing). */
  function segmentsIntersect(p1, p2, p3, p4) {
    const ccw = (a, b, c) => (c.y - a.y) * (b.x - a.x) > (b.y - a.y) * (c.x - a.x);
    return ccw(p1, p3, p4) !== ccw(p2, p3, p4) && ccw(p1, p2, p3) !== ccw(p1, p2, p4);
  }

  /** Point at parameter t in [0,1] between p1 and p2 on a uniform Catmull-Rom spline through p0,p1,p2,p3. */
  function catmullRomPoint(p0, p1, p2, p3, t) {
    const t2 = t * t;
    const t3 = t2 * t;
    const c = (a, b, c2, d) => 0.5 * (2 * b + (-a + c2) * t + (2 * a - 5 * b + 4 * c2 - d) * t2 + (-a + 3 * b - 3 * c2 + d) * t3);
    return { x: c(p0.x, p1.x, p2.x, p3.x), y: c(p0.y, p1.y, p2.y, p3.y) };
  }

  /** Samples the closed Catmull-Rom curve canvasRenderer.js actually draws through `points`. */
  function sampleClosedCurve(points, samplesPerSegment) {
    const n = points.length;
    const out = [];
    for (let i = 0; i < n; i++) {
      const p0 = points[(i - 1 + n) % n];
      const p1 = points[i];
      const p2 = points[(i + 1) % n];
      const p3 = points[(i + 2) % n];
      for (let s = 0; s < samplesPerSegment; s++) {
        out.push(catmullRomPoint(p0, p1, p2, p3, s / samplesPerSegment));
      }
    }
    return out;
  }

  /**
   * True if the closed curve through `points` crosses itself anywhere. Tests
   * the same Catmull-Rom curve canvasRenderer.js renders (sampled finely),
   * not just the straight-line control polygon -- the curve overshoots past
   * its control points, so it can loop back on itself even when the control
   * polygon itself doesn't cross.
   */
  function curveSelfIntersects(points) {
    const samplesPerSegment = 8;
    const curve = sampleClosedCurve(points, samplesPerSegment);
    const n = curve.length;
    // Segments within this many samples of each other along the curve are
    // part of the same smooth bend and can sit close together without it
    // being a real crossing -- only flag genuinely distant segments.
    const skipWindow = samplesPerSegment + 2;
    for (let i = 0; i < n; i++) {
      for (let j = i + 2; j < n; j++) {
        const gap = Math.min(j - i, n - (j - i));
        if (gap <= skipWindow) continue;
        if (segmentsIntersect(curve[i], curve[(i + 1) % n], curve[j], curve[(j + 1) % n])) return true;
      }
    }
    return false;
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
    for (let attempt = 1; attempt < 12 && curveSelfIntersects(candidate); attempt++) {
      candidate = sample();
    }
    for (let relax = 0; relax < 8 && curveSelfIntersects(candidate); relax++) {
      candidate = relaxPoints(candidate);
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
   * With probability `edgeBranchProbability`, turns a plain edge into a
   * split (extra branch fanning out from the target) or a converge (extra
   * branch feeding into the source). The branch endpoint is usually another
   * node, but is sometimes a bare {x,y} point -- an edge end that isn't
   * attached to any node at all.
   */
  function maybeAddBranch(edge, nodes, params, rng) {
    if (!rng.bool(params.edgeBranchProbability)) return;
    const usedIds = new Set([edge.source, edge.target]);
    const candidates = nodes.filter((n) => !usedIds.has(n.id));
    const endpoint =
      candidates.length && rng.bool(0.7)
        ? rng.pick(candidates).id
        : { x: rng.range(0, params.width), y: rng.range(0, params.height) };
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
        maybeAddBranch(edge, nodes, params, rng);
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
    // node at all -- the most literal reading of "edges that don't start or
    // end at a node".
    for (let i = 0; i < params.floatingEdgeCount; i++) {
      const a = { x: rng.range(0, params.width), y: rng.range(0, params.height) };
      const b = { x: rng.range(0, params.width), y: rng.range(0, params.height) };
      edges.push(makeEdge(`f${i}`, a, b, params, rng));
    }

    return edges;
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
      diagram.nodes.push(buildNode(`n${i}`, `N${i}`, null, shape, positions[i], { w, h }, params, rng));
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
