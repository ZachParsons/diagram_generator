/**
 * Layout functions place N node centers within a width x height canvas.
 * Each takes (count, width, height, padding, rng) and returns an array
 * of { x, y } the generator then assigns to nodes in order.
 */
(function (global) {
  function grid(count, width, height, padding, rng) {
    const cols = Math.max(1, Math.round(Math.sqrt((count * width) / height)));
    const rows = Math.max(1, Math.ceil(count / cols));
    const cellW = (width - padding * 2) / cols;
    const cellH = (height - padding * 2) / rows;
    const jitter = Math.min(cellW, cellH) * 0.15;
    const points = [];
    for (let i = 0; i < count; i++) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const jx = rng ? rng.range(-jitter, jitter) : 0;
      const jy = rng ? rng.range(-jitter, jitter) : 0;
      points.push({
        x: padding + cellW * (col + 0.5) + jx,
        y: padding + cellH * (row + 0.5) + jy,
      });
    }
    return points;
  }

  function random(count, width, height, padding, rng) {
    const points = [];
    for (let i = 0; i < count; i++) {
      points.push({
        x: rng.range(padding, width - padding),
        y: rng.range(padding, height - padding),
      });
    }
    return points;
  }

  function circular(count, width, height, padding, rng) {
    const cx = width / 2;
    const cy = height / 2;
    const radius = Math.max(10, Math.min(width, height) / 2 - padding);
    const startAngle = rng ? rng.range(0, Math.PI * 2) : 0;
    const points = [];
    for (let i = 0; i < count; i++) {
      const angle = startAngle + (i / count) * Math.PI * 2;
      points.push({
        x: cx + Math.cos(angle) * radius,
        y: cy + Math.sin(angle) * radius,
      });
    }
    return points;
  }

  const LAYOUT_FNS = { grid, random, circular };

  global.DG = global.DG || {};
  global.DG.layouts = LAYOUT_FNS;
})(window);
