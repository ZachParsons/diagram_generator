/**
 * p5 canvas visualizer. Only depends on the diagram JSON schema (see
 * schema.js) -- it has no idea how the diagram was produced, so any
 * diagram JSON built elsewhere (imported from a file, produced by a
 * different generator) renders the same way.
 */
(function (global) {
  function buildNodeIndex(nodes) {
    const map = new Map();
    nodes.forEach((n) => map.set(n.id, n));
    return map;
  }

  function buildEdgeIndex(edges) {
    const map = new Map();
    edges.forEach((e) => map.set(e.id, e));
    return map;
  }

  /** Straight-edged closed polygon through `points` (local coords). */
  function drawStraightClosed(p, points) {
    p.beginShape();
    points.forEach((pt) => p.vertex(pt.x, pt.y));
    p.endShape(p.CLOSE);
  }

  /**
   * Smooth closed Catmull-Rom curve through `points`. Closing a curveVertex
   * loop requires repeating the last point before the first, and the first
   * two points again after the last -- see the p5 curveVertex reference.
   */
  function drawCurvedClosed(p, points) {
    const n = points.length;
    p.beginShape();
    p.curveVertex(points[n - 1].x, points[n - 1].y);
    points.forEach((pt) => p.curveVertex(pt.x, pt.y));
    p.curveVertex(points[0].x, points[0].y);
    p.curveVertex(points[1].x, points[1].y);
    p.endShape(p.CLOSE);
  }

  /** Point on a uniform Catmull-Rom segment (p1->p2, neighbors p0/p3) at t -- matches p5's curveVertex math closely enough to use for a clip path. */
  function catmullRomPoint(p0, p1, p2, p3, t) {
    const t2 = t * t;
    const t3 = t2 * t;
    return {
      x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
      y: 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
    };
  }

  /** A curved closed outline sampled down to a plain polygon -- close enough to drawCurvedClosed's actual curve to double as a clip path. */
  function sampleClosedCurveOutline(points, perSegment) {
    const n = points.length;
    const out = [];
    for (let i = 0; i < n; i++) {
      const p0 = points[(i - 1 + n) % n];
      const p1 = points[i];
      const p2 = points[(i + 1) % n];
      const p3 = points[(i + 2) % n];
      for (let s = 0; s < perSegment; s++) out.push(catmullRomPoint(p0, p1, p2, p3, s / perSegment));
    }
    return out;
  }

  /**
   * Clips all subsequent drawing to `node`'s own outline, in the current
   * (already translated+rotated) transform -- this is how a node's nested
   * `children` (see renderNodesAndEdges) end up rendered only inside their
   * container's shape instead of spilling out past it. Every call must be
   * paired with a later unclip() before the enclosing p.pop().
   */
  function clipToNodeShape(p, node) {
    const ctx = p.drawingContext;
    const outline = node.curved ? sampleClosedCurveOutline(node.points, 8) : node.points;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(outline[0].x, outline[0].y);
    for (let i = 1; i < outline.length; i++) ctx.lineTo(outline[i].x, outline[i].y);
    ctx.closePath();
    ctx.clip();
  }

  function unclip(p) {
    p.drawingContext.restore();
  }

  // A safety cap on how many `children` levels actually get rendered,
  // independent of the generator's own params.recursionMaxDepth -- so a
  // hand-edited/imported diagram JSON with runaway nesting can't hang the
  // renderer.
  const MAX_RENDER_RECURSION_DEPTH = 8;

  function drawNode(p, node, showLabels, depth) {
    p.push();
    p.translate(node.x, node.y);
    p.rotate(node.rotation || 0);
    p.noStroke();
    p.fill(node.fill);

    if (node.curved) {
      drawCurvedClosed(p, node.points);
    } else {
      drawStraightClosed(p, node.points);
    }

    if (node.children && depth < MAX_RENDER_RECURSION_DEPTH && (node.children.nodes.length || node.children.edges.length)) {
      clipToNodeShape(p, node);
      renderNodesAndEdges(p, node.children.nodes, node.children.edges, showLabels, depth + 1);
      unclip(p);
    }
    p.pop();

    if (node.label && showLabels) {
      p.push();
      p.noStroke();
      p.fill(255);
      p.textAlign(p.CENTER, p.CENTER);
      p.textSize(11);
      p.text(node.label, node.x, node.y);
      p.pop();
    }
  }

  /** Point on the A->B line at exactly distance `dist` from B. */
  function pullBack(a, b, dist) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const t = Math.max(0, (len - dist) / len);
    return { x: a.x + dx * t, y: a.y + dy * t };
  }

  function nodeRadius(node) {
    return Math.min(node.w, node.h) / 2;
  }

  /**
   * Resolves an edge endpoint reference -- a node id string, a literal
   * {x,y} point, or an edge reference { edgeRef, t } -- to { point, node }.
   * `node` is null for a literal point or an edge reference: neither is
   * attached to a node's shape, so neither ever gets pulled back off a
   * node boundary (see endpointAnchor).
   *
   * `visiting` is the set of edge ids already being resolved up the current
   * call chain -- an edge ref that points back into one of them (directly,
   * or through a longer cycle of edges referencing each other) resolves to
   * null instead of recursing forever.
   */
  function resolveEndpoint(nodeIndex, edgeIndex, ref, visiting) {
    if (typeof ref === 'string') {
      const node = nodeIndex.get(ref);
      return node ? { point: { x: node.x, y: node.y }, node } : null;
    }
    if (ref && typeof ref.edgeRef === 'string') {
      if (visiting.has(ref.edgeRef)) return null;
      const edge = edgeIndex.get(ref.edgeRef);
      if (!edge) return null;
      const point = edgePointAt(edge, ref.t, nodeIndex, edgeIndex, visiting);
      return point ? { point, node: null } : null;
    }
    return ref && typeof ref.x === 'number' && typeof ref.y === 'number' ? { point: ref, node: null } : null;
  }

  /**
   * The trunk points of `edge` itself (its self-loop bezier if it's a
   * self-loop, else its normal start->end path), used both to draw the
   * edge and to resolve some other edge's endpoint that references a point
   * along it. Returns null if `edge`'s own endpoints don't resolve.
   */
  function edgeTrunkSamples(edge, nodeIndex, edgeIndex, visiting) {
    const nextVisiting = new Set(visiting);
    nextVisiting.add(edge.id);
    if (typeof edge.source === 'string' && edge.source === edge.target) {
      const node = nodeIndex.get(edge.source);
      return node ? selfLoopGeometry(node, edge).points : null;
    }
    const sourceResolved = resolveEndpoint(nodeIndex, edgeIndex, edge.source, nextVisiting);
    const targetResolved = resolveEndpoint(nodeIndex, edgeIndex, edge.target, nextVisiting);
    if (!sourceResolved || !targetResolved) return null;
    const start = endpointAnchor(sourceResolved, targetResolved.point, edge.sourceGap);
    const end = endpointAnchor(targetResolved, sourceResolved.point, edge.targetGap);
    return edgeTrunkPoints(edge, start, end);
  }

  /** The point `t` (0..1) of the way along `edge`'s own rendered path, or null if it doesn't resolve. */
  function edgePointAt(edge, t, nodeIndex, edgeIndex, visiting) {
    const samples = edgeTrunkSamples(edge, nodeIndex, edgeIndex, visiting);
    if (!samples || !samples.length) return null;
    const clamped = Math.max(0, Math.min(1, t));
    return samples[Math.round(clamped * (samples.length - 1))];
  }

  /** The point where a line touching `resolved` should actually start/end: its own boundary (+ gap), or the literal point if it's floating. */
  function endpointAnchor(resolved, towards, gap) {
    if (!resolved.node) return resolved.point;
    return pullBack(towards, resolved.point, nodeRadius(resolved.node) + (gap || 0));
  }

  /** How far back from its tip an arrowhead's wide base sits, given the line width it's capping. */
  function arrowheadSize(width) {
    return Math.max(8, (width || 4) * 1.8);
  }

  function drawArrowhead(p, at, angle, color, width) {
    const size = arrowheadSize(width);
    p.push();
    p.translate(at.x, at.y);
    p.rotate(angle);
    p.noStroke();
    p.fill(color);
    p.triangle(0, 0, -size, size * 0.5, -size, -size * 0.5);
    p.pop();
  }

  /** Coarse control points for an edge's path shape between two anchors. */
  function pathControlPoints(style, start, end) {
    if (style === 'orthogonal') {
      const midX = (start.x + end.x) / 2;
      return [start, { x: midX, y: start.y }, { x: midX, y: end.y }, end];
    }
    if (style === 'curved') {
      const mx = (start.x + end.x) / 2;
      const my = (start.y + end.y) / 2;
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const bend = 0.18;
      return [start, { x: mx - dy * bend, y: my + dx * bend }, end];
    }
    return [start, end];
  }

  /** N points spaced evenly by arc length along a 2+ point polyline. */
  function resamplePolyline(points, n) {
    const segLens = [];
    let total = 0;
    for (let i = 0; i < points.length - 1; i++) {
      const d = Math.hypot(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y);
      segLens.push(d);
      total += d;
    }
    if (total === 0) return new Array(n).fill(points[0]);

    const out = [];
    for (let i = 0; i < n; i++) {
      let target = (i / (n - 1)) * total;
      let seg = 0;
      while (seg < segLens.length - 1 && target > segLens[seg]) {
        target -= segLens[seg];
        seg++;
      }
      const t = target / (segLens[seg] || 1);
      const a = points[seg];
      const b = points[seg + 1];
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
    return out;
  }

  /** N points along a quadratic bezier defined by [start, control, end]. */
  function sampleQuadraticBezier([a, c, b], n) {
    const out = [];
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const mt = 1 - t;
      out.push({
        x: mt * mt * a.x + 2 * mt * t * c.x + t * t * b.x,
        y: mt * mt * a.y + 2 * mt * t * c.y + t * t * b.y,
      });
    }
    return out;
  }

  /** N points along a cubic bezier defined by [start, control1, control2, end]. */
  function sampleCubicBezier([a, c1, c2, b], n) {
    const out = [];
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const mt = 1 - t;
      out.push({
        x: mt * mt * mt * a.x + 3 * mt * mt * t * c1.x + 3 * mt * t * t * c2.x + t * t * t * b.x,
        y: mt * mt * mt * a.y + 3 * mt * mt * t * c1.y + 3 * mt * t * t * c2.y + t * t * t * b.y,
      });
    }
    return out;
  }

  /**
   * Geometry for a self-loop edge: two points on the node's own boundary
   * (`loopAngle` +/- half of `loopSpread`), joined by a cubic bezier whose
   * control points push outward to `loopSize` node-radii, so it reads as a
   * loop bulging off the node rather than a degenerate zero-length line.
   */
  function selfLoopGeometry(node, edge) {
    const r = nodeRadius(node);
    const a1 = edge.loopAngle - edge.loopSpread / 2;
    const a2 = edge.loopAngle + edge.loopSpread / 2;
    const start = { x: node.x + Math.cos(a1) * r, y: node.y + Math.sin(a1) * r };
    const end = { x: node.x + Math.cos(a2) * r, y: node.y + Math.sin(a2) * r };
    const outR = r * (1 + edge.loopSize);
    const c1 = { x: node.x + Math.cos(a1) * outR, y: node.y + Math.sin(a1) * outR };
    const c2 = { x: node.x + Math.cos(a2) * outR, y: node.y + Math.sin(a2) * outR };
    return { start, end, points: sampleCubicBezier([start, c1, c2, end], PATH_SAMPLES) };
  }

  const PATH_SAMPLES = 32;

  function samplePath(style, start, end) {
    const control = pathControlPoints(style, start, end);
    return style === 'curved' ? sampleQuadraticBezier(control, PATH_SAMPLES) : resamplePolyline(control, PATH_SAMPLES);
  }

  /**
   * The points an edge's trunk actually follows: a user-dragged
   * `controlPoint` always wins (as a single bezier control point,
   * overriding `style`) since dragging an edge is how a bend gets set in
   * the first place; otherwise it's just `samplePath(edge.style, ...)`.
   */
  function edgeTrunkPoints(edge, start, end) {
    return edge.controlPoint ? sampleQuadraticBezier([start, edge.controlPoint, end], PATH_SAMPLES) : samplePath(edge.style, start, end);
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function withAlpha(p, cssColor, alpha) {
    const c = p.color(cssColor);
    c.setAlpha(Math.round(Math.max(0, Math.min(1, alpha)) * 255));
    return c;
  }

  /** A tapered quad between two path samples, filled with one color. */
  function drawRibbonSegment(p, a, b, widthA, widthB, fillColor) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    p.fill(fillColor);
    p.beginShape();
    p.vertex(a.x + (nx * widthA) / 2, a.y + (ny * widthA) / 2);
    p.vertex(b.x + (nx * widthB) / 2, b.y + (ny * widthB) / 2);
    p.vertex(b.x - (nx * widthB) / 2, b.y - (ny * widthB) / 2);
    p.vertex(a.x - (nx * widthA) / 2, a.y - (ny * widthA) / 2);
    p.endShape(p.CLOSE);
  }

  /**
   * Draws the tapered, faded, patterned (solid/dashed/dotted/striped) path
   * between `start` and `end`, and returns the sampled points so the caller
   * can point arrowheads along the true path direction at each end.
   *
   * `trimStart`/`trimEnd` (arc-length pixels) hold the ribbon back from an
   * arrow-tipped end: an arrowhead tapers to a zero-width point exactly at
   * the tip, but the ribbon's own last segment doesn't (it just stops at a
   * flat, `width`-wide cap), so without trimming, that flat cap pokes out
   * past the sides of the now-thin arrowhead right near the point instead
   * of staying hidden under the arrowhead's wide base.
   */
  function drawTrunk(p, edge, start, end, precomputedSamples, trimStart, trimEnd) {
    const samples = precomputedSamples || edgeTrunkPoints(edge, start, end);
    const n = samples.length;
    const cum = [0];
    for (let i = 1; i < n; i++) {
      cum.push(cum[i - 1] + Math.hypot(samples[i].x - samples[i - 1].x, samples[i].y - samples[i - 1].y));
    }
    const total = cum[n - 1] || 1;
    const lo = trimStart || 0;
    const hi = total - (trimEnd || 0);
    const widthAt = (t) => lerp(edge.widthStart, edge.widthEnd, t);
    const opacityAt = (t) => lerp(edge.opacityStart, edge.opacityEnd, t);

    p.push();
    p.noStroke();

    if (edge.pattern === 'dotted') {
      const spacing = Math.max(6, edge.widthStart + edge.widthEnd);
      for (let d = 0, seg = 0; d <= total; d += spacing) {
        if (d < lo || d > hi) continue;
        while (seg < n - 2 && cum[seg + 1] < d) seg++;
        const segLen = cum[seg + 1] - cum[seg] || 1;
        const segT = (d - cum[seg]) / segLen;
        const pt = { x: lerp(samples[seg].x, samples[seg + 1].x, segT), y: lerp(samples[seg].y, samples[seg + 1].y, segT) };
        const t = d / total;
        const w = widthAt(t);
        p.fill(withAlpha(p, edge.color, opacityAt(t)));
        p.ellipse(pt.x, pt.y, w, w);
      }
    } else {
      const period = edge.pattern === 'dashed' ? 17 : edge.pattern === 'striped' ? 14 : Infinity;
      const dashOn = edge.pattern === 'dashed' ? 10 : period;
      for (let i = 0; i < n - 1; i++) {
        const mid = (cum[i] + cum[i + 1]) / 2;
        if (mid < lo || mid > hi) continue;
        const tA = cum[i] / total;
        const tB = cum[i + 1] / total;
        if ((mid % period) >= dashOn) continue; // dashed gap
        const fillColor = edge.pattern === 'striped' && Math.floor(mid / period) % 2 === 1 ? edge.color2 : edge.color;
        const opacity = opacityAt((tA + tB) / 2);
        drawRibbonSegment(p, samples[i], samples[i + 1], widthAt(tA), widthAt(tB), withAlpha(p, fillColor, opacity));
      }
    }
    p.pop();
    return samples;
  }

  function drawBranchLine(p, from, to, width, color, opacity) {
    p.push();
    p.stroke(withAlpha(p, color, opacity));
    p.strokeWeight(Math.max(1, width * 0.6));
    p.line(from.x, from.y, to.x, to.y);
    p.pop();
  }

  /** Draws extra branch lines converging into `trunkPoint` (or diverging out of it) plus their own arrowheads. */
  function drawBranches(p, refs, trunkPoint, nodeIndex, edgeIndex, edge, width, opacity, arrowOn, arrowFromTrunk) {
    refs.forEach((ref) => {
      const resolved = resolveEndpoint(nodeIndex, edgeIndex, ref, new Set([edge.id]));
      if (!resolved) return;
      const anchor = resolved.node ? pullBack(trunkPoint, resolved.point, nodeRadius(resolved.node)) : resolved.point;
      const from = arrowFromTrunk ? trunkPoint : anchor;
      const to = arrowFromTrunk ? anchor : trunkPoint;
      // Hold the line back from the arrow tip -- see drawTrunk's trimStart/trimEnd comment for why.
      const lineEnd = arrowOn ? pullBack(from, to, arrowheadSize(width)) : to;
      drawBranchLine(p, from, lineEnd, width, edge.color, opacity);
      if (arrowOn) {
        const angle = Math.atan2(to.y - from.y, to.x - from.x);
        drawArrowhead(p, to, angle, edge.color, width);
      }
    });
  }

  function drawEdge(p, edge, nodeIndex, edgeIndex) {
    if (typeof edge.source === 'string' && edge.source === edge.target) {
      const node = nodeIndex.get(edge.source);
      if (!node) return;
      const { start, end, points } = selfLoopGeometry(node, edge);
      const trimStart = edge.arrowStart ? arrowheadSize(edge.widthStart) : 0;
      const trimEnd = edge.arrowEnd ? arrowheadSize(edge.widthEnd) : 0;
      const samples = drawTrunk(p, edge, start, end, points, trimStart, trimEnd);
      if (edge.arrowStart) {
        const towards = samples[1] || end;
        drawArrowhead(p, start, Math.atan2(start.y - towards.y, start.x - towards.x), edge.color, edge.widthStart);
      }
      if (edge.arrowEnd) {
        const towards = samples[samples.length - 2] || start;
        drawArrowhead(p, end, Math.atan2(end.y - towards.y, end.x - towards.x), edge.color, edge.widthEnd);
      }
      return;
    }

    const visiting = new Set([edge.id]);
    const sourceResolved = resolveEndpoint(nodeIndex, edgeIndex, edge.source, visiting);
    const targetResolved = resolveEndpoint(nodeIndex, edgeIndex, edge.target, visiting);
    if (!sourceResolved || !targetResolved) return;

    const start = endpointAnchor(sourceResolved, targetResolved.point, edge.sourceGap);
    const end = endpointAnchor(targetResolved, sourceResolved.point, edge.targetGap);

    const trimStart = edge.arrowStart ? arrowheadSize(edge.widthStart) : 0;
    const trimEnd = edge.arrowEnd ? arrowheadSize(edge.widthEnd) : 0;
    const samples = drawTrunk(p, edge, start, end, undefined, trimStart, trimEnd);

    if (edge.extraSources && edge.extraSources.length) {
      drawBranches(p, edge.extraSources, start, nodeIndex, edgeIndex, edge, edge.widthStart, edge.opacityStart, edge.arrowStart, false);
    }
    if (edge.extraTargets && edge.extraTargets.length) {
      drawBranches(p, edge.extraTargets, end, nodeIndex, edgeIndex, edge, edge.widthEnd, edge.opacityEnd, edge.arrowEnd, true);
    }

    if (edge.arrowStart) {
      const towards = samples[1] || end;
      const angle = Math.atan2(start.y - towards.y, start.x - towards.x);
      drawArrowhead(p, start, angle, edge.color, edge.widthStart);
    }
    if (edge.arrowEnd) {
      const towards = samples[samples.length - 2] || start;
      const angle = Math.atan2(end.y - towards.y, end.x - towards.x);
      drawArrowhead(p, end, angle, edge.color, edge.widthEnd);
    }
  }

  /** Draws one { nodes, edges } level -- the top-level diagram, or (recursively, from drawNode) a node's nested `children`. */
  function renderNodesAndEdges(p, nodes, edges, showLabels, depth) {
    const nodeIndex = buildNodeIndex(nodes);
    const edgeIndex = buildEdgeIndex(edges);
    edges.forEach((e) => drawEdge(p, e, nodeIndex, edgeIndex));
    nodes.forEach((n) => drawNode(p, n, showLabels, depth));
  }

  /** Draws nodes/edges only -- caller owns clearing/filling the background. */
  function renderDiagramP5(p, diagram, options) {
    const showLabels = !options || options.showLabels !== false;
    p.push();
    renderNodesAndEdges(p, diagram.nodes, diagram.edges, showLabels, 0);
    p.pop();
  }

  /** True if local-space point (x,y) falls inside the closed `points` outline (ray casting). */
  function pointInPolygon(x, y, points) {
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const xi = points[i].x, yi = points[i].y;
      const xj = points[j].x, yj = points[j].y;
      const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
      if (intersects) inside = !inside;
    }
    return inside;
  }

  /**
   * Topmost node under diagram-space point (x,y), or null. Checks nodes in
   * reverse draw order so a node drawn on top of another wins the hit test.
   */
  function hitTestNode(diagram, x, y) {
    for (let i = diagram.nodes.length - 1; i >= 0; i--) {
      const node = diagram.nodes[i];
      const dx = x - node.x;
      const dy = y - node.y;
      const rot = -(node.rotation || 0);
      const cos = Math.cos(rot);
      const sin = Math.sin(rot);
      const localX = dx * cos - dy * sin;
      const localY = dx * sin + dy * cos;
      if (pointInPolygon(localX, localY, node.points)) return node;
    }
    return null;
  }

  /** Closest point to (px,py) on segment a-b, and the distance to it. */
  function closestPointOnSegment(px, py, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / lenSq));
    const x = a.x + dx * t;
    const y = a.y + dy * t;
    return { x, y, dist: Math.hypot(px - x, py - y) };
  }

  /** Distance from (x,y) to a literal or edge-attached (non-node) endpoint ref, or null if `ref` is node-attached. */
  function floatingEndpointDistance(nodeIndex, edgeIndex, ownerEdgeId, ref, x, y) {
    const resolved = resolveEndpoint(nodeIndex, edgeIndex, ref, new Set([ownerEdgeId]));
    if (!resolved || resolved.node) return null;
    return Math.hypot(x - resolved.point.x, y - resolved.point.y);
  }

  /**
   * The closest draggable part of any edge to diagram-space point (x,y),
   * within `threshold` pixels, or null. A floating (non-node) endpoint --
   * `source`/`target`/an `extraSources`/`extraTargets` entry, whether a bare
   * {x,y} point or a point attached to another edge -- can be dragged
   * directly; anywhere else along the path grabs the edge's bend
   * (`edge.controlPoint`), the same way clicking a node grabs its position.
   */
  function hitTestEdge(diagram, x, y, threshold) {
    const nodeIndex = buildNodeIndex(diagram.nodes);
    const edgeIndex = buildEdgeIndex(diagram.edges);
    const endpointGrabRadius = Math.max(threshold, 10);
    let best = null;
    const consider = (dist, hit) => {
      if (dist <= (hit.kind === 'bend' ? threshold : endpointGrabRadius) && (!best || dist < best.dist)) {
        best = { ...hit, dist };
      }
    };

    diagram.edges.forEach((edge) => {
      const samples = edgeTrunkSamples(edge, nodeIndex, edgeIndex, new Set());
      if (!samples) return;

      let d = floatingEndpointDistance(nodeIndex, edgeIndex, edge.id, edge.source, x, y);
      if (d !== null) consider(d, { edge, kind: 'endpoint', which: 'source' });
      d = floatingEndpointDistance(nodeIndex, edgeIndex, edge.id, edge.target, x, y);
      if (d !== null) consider(d, { edge, kind: 'endpoint', which: 'target' });
      (edge.extraSources || []).forEach((ref, index) => {
        const dd = floatingEndpointDistance(nodeIndex, edgeIndex, edge.id, ref, x, y);
        if (dd !== null) consider(dd, { edge, kind: 'extra', which: 'extraSources', index });
      });
      (edge.extraTargets || []).forEach((ref, index) => {
        const dd = floatingEndpointDistance(nodeIndex, edgeIndex, edge.id, ref, x, y);
        if (dd !== null) consider(dd, { edge, kind: 'extra', which: 'extraTargets', index });
      });

      for (let i = 0; i < samples.length - 1; i++) {
        const closest = closestPointOnSegment(x, y, samples[i], samples[i + 1]);
        consider(closest.dist, { edge, kind: 'bend' });
      }
    });
    return best;
  }

  /**
   * Closest point on any edge OTHER than `excludeEdgeId` to diagram-space
   * point (x,y), within `threshold`, as { edgeId, t } -- or null. Used to
   * snap a dropped edge endpoint onto another edge, turning it into an
   * `{ edgeRef, t }` reference instead of a bare {x,y} point.
   */
  function findEdgeSnapTarget(diagram, x, y, threshold, excludeEdgeId) {
    const nodeIndex = buildNodeIndex(diagram.nodes);
    const edgeIndex = buildEdgeIndex(diagram.edges);
    let best = null;
    diagram.edges.forEach((edge) => {
      if (edge.id === excludeEdgeId) return;
      const samples = edgeTrunkSamples(edge, nodeIndex, edgeIndex, new Set());
      if (!samples || samples.length < 2) return;
      for (let i = 0; i < samples.length - 1; i++) {
        const closest = closestPointOnSegment(x, y, samples[i], samples[i + 1]);
        if (closest.dist <= threshold && (!best || closest.dist < best.dist)) {
          best = { edgeId: edge.id, t: i / (samples.length - 1), dist: closest.dist };
        }
      }
    });
    return best;
  }

  global.DG = global.DG || {};
  Object.assign(global.DG, { renderDiagramP5, hitTestNode, hitTestEdge, findEdgeSnapTarget });
})(window);
