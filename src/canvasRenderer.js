/**
 * p5 canvas visualizer. Only depends on the diagram JSON schema (see
 * schema.js) -- it has no idea how the diagram was produced, so any
 * diagram JSON built elsewhere (imported from a file, produced by a
 * different generator) renders the same way.
 */
(function (global) {
  function buildNodeIndex(diagram) {
    const map = new Map();
    diagram.nodes.forEach((n) => map.set(n.id, n));
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

  function drawNode(p, node) {
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
    p.pop();

    if (node.label) {
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
   * Resolves an edge endpoint reference -- a node id string, or a literal
   * {x,y} point -- to { point, node }. `node` is null for a literal point:
   * a "floating" endpoint that isn't attached to anything and so never gets
   * pulled back off a node boundary.
   */
  function resolveEndpoint(nodeIndex, ref) {
    if (typeof ref === 'string') {
      const node = nodeIndex.get(ref);
      return node ? { point: { x: node.x, y: node.y }, node } : null;
    }
    return ref && typeof ref.x === 'number' && typeof ref.y === 'number' ? { point: ref, node: null } : null;
  }

  /** The point where a line touching `resolved` should actually start/end: its own boundary (+ gap), or the literal point if it's floating. */
  function endpointAnchor(resolved, towards, gap) {
    if (!resolved.node) return resolved.point;
    return pullBack(towards, resolved.point, nodeRadius(resolved.node) + (gap || 0));
  }

  function drawArrowhead(p, at, angle, color, width) {
    const size = Math.max(8, (width || 4) * 1.8);
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
   */
  function drawTrunk(p, edge, start, end) {
    const samples = edgeTrunkPoints(edge, start, end);
    const n = samples.length;
    const cum = [0];
    for (let i = 1; i < n; i++) {
      cum.push(cum[i - 1] + Math.hypot(samples[i].x - samples[i - 1].x, samples[i].y - samples[i - 1].y));
    }
    const total = cum[n - 1] || 1;
    const widthAt = (t) => lerp(edge.widthStart, edge.widthEnd, t);
    const opacityAt = (t) => lerp(edge.opacityStart, edge.opacityEnd, t);

    p.push();
    p.noStroke();

    if (edge.pattern === 'dotted') {
      const spacing = Math.max(6, edge.widthStart + edge.widthEnd);
      for (let d = 0, seg = 0; d <= total; d += spacing) {
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
        const tA = cum[i] / total;
        const tB = cum[i + 1] / total;
        const mid = (cum[i] + cum[i + 1]) / 2;
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
  function drawBranches(p, refs, trunkPoint, nodeIndex, edge, width, opacity, arrowOn, arrowFromTrunk) {
    refs.forEach((ref) => {
      const resolved = resolveEndpoint(nodeIndex, ref);
      if (!resolved) return;
      const anchor = resolved.node ? pullBack(trunkPoint, resolved.point, nodeRadius(resolved.node)) : resolved.point;
      const from = arrowFromTrunk ? trunkPoint : anchor;
      const to = arrowFromTrunk ? anchor : trunkPoint;
      drawBranchLine(p, from, to, width, edge.color, opacity);
      if (arrowOn) {
        const angle = Math.atan2(to.y - from.y, to.x - from.x);
        drawArrowhead(p, to, angle, edge.color, width);
      }
    });
  }

  function drawEdge(p, edge, nodeIndex) {
    const sourceResolved = resolveEndpoint(nodeIndex, edge.source);
    const targetResolved = resolveEndpoint(nodeIndex, edge.target);
    if (!sourceResolved || !targetResolved) return;

    const start = endpointAnchor(sourceResolved, targetResolved.point, edge.sourceGap);
    const end = endpointAnchor(targetResolved, sourceResolved.point, edge.targetGap);

    const samples = drawTrunk(p, edge, start, end);

    if (edge.extraSources && edge.extraSources.length) {
      drawBranches(p, edge.extraSources, start, nodeIndex, edge, edge.widthStart, edge.opacityStart, edge.arrowStart, false);
    }
    if (edge.extraTargets && edge.extraTargets.length) {
      drawBranches(p, edge.extraTargets, end, nodeIndex, edge, edge.widthEnd, edge.opacityEnd, edge.arrowEnd, true);
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

  /** Draws nodes/edges only -- caller owns clearing/filling the background. */
  function renderDiagramP5(p, diagram) {
    p.push();
    const nodeIndex = buildNodeIndex(diagram);
    diagram.edges.forEach((e) => drawEdge(p, e, nodeIndex));
    diagram.nodes.forEach((n) => drawNode(p, n));
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

  /** Distance from (x,y) to a literal (non-node) endpoint ref, or null if `ref` is node-attached. */
  function floatingEndpointDistance(nodeIndex, ref, x, y) {
    const resolved = resolveEndpoint(nodeIndex, ref);
    if (!resolved || resolved.node) return null;
    return Math.hypot(x - resolved.point.x, y - resolved.point.y);
  }

  /**
   * The closest draggable part of any edge to diagram-space point (x,y),
   * within `threshold` pixels, or null. A floating (non-node) endpoint --
   * `source`/`target`/an `extraSources`/`extraTargets` entry -- can be
   * dragged directly; anywhere else along the path grabs the edge's bend
   * (`edge.controlPoint`), the same way clicking a node grabs its position.
   */
  function hitTestEdge(diagram, x, y, threshold) {
    const nodeIndex = buildNodeIndex(diagram);
    const endpointGrabRadius = Math.max(threshold, 10);
    let best = null;
    const consider = (dist, hit) => {
      if (dist <= (hit.kind === 'bend' ? threshold : endpointGrabRadius) && (!best || dist < best.dist)) {
        best = { ...hit, dist };
      }
    };

    diagram.edges.forEach((edge) => {
      const sourceResolved = resolveEndpoint(nodeIndex, edge.source);
      const targetResolved = resolveEndpoint(nodeIndex, edge.target);
      if (!sourceResolved || !targetResolved) return;
      const start = endpointAnchor(sourceResolved, targetResolved.point, edge.sourceGap);
      const end = endpointAnchor(targetResolved, sourceResolved.point, edge.targetGap);

      let d = floatingEndpointDistance(nodeIndex, edge.source, x, y);
      if (d !== null) consider(d, { edge, kind: 'endpoint', which: 'source' });
      d = floatingEndpointDistance(nodeIndex, edge.target, x, y);
      if (d !== null) consider(d, { edge, kind: 'endpoint', which: 'target' });
      (edge.extraSources || []).forEach((ref, index) => {
        const dd = floatingEndpointDistance(nodeIndex, ref, x, y);
        if (dd !== null) consider(dd, { edge, kind: 'extra', which: 'extraSources', index });
      });
      (edge.extraTargets || []).forEach((ref, index) => {
        const dd = floatingEndpointDistance(nodeIndex, ref, x, y);
        if (dd !== null) consider(dd, { edge, kind: 'extra', which: 'extraTargets', index });
      });

      const samples = edgeTrunkPoints(edge, start, end);
      for (let i = 0; i < samples.length - 1; i++) {
        const closest = closestPointOnSegment(x, y, samples[i], samples[i + 1]);
        consider(closest.dist, { edge, kind: 'bend' });
      }
    });
    return best;
  }

  global.DG = global.DG || {};
  Object.assign(global.DG, { renderDiagramP5, hitTestNode, hitTestEdge });
})(window);
