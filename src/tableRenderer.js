/**
 * A second, deliberately independent visualizer for the exact same
 * diagram JSON schema -- proof that the generator's output is pluggable
 * into more than one renderer. Renders nodes/edges as plain HTML tables
 * instead of a canvas drawing.
 */
(function (global) {
  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (k === 'text') node.textContent = v;
      else node.setAttribute(k, v);
    });
    (children || []).forEach((c) => node.appendChild(c));
    return node;
  }

  function swatch(color) {
    return el('span', { class: 'swatch', style: `background:${color}` });
  }

  function buildNodesTable(diagram) {
    const rows = diagram.nodes.map((n) =>
      el('tr', {}, [
        el('td', { text: n.id }),
        el('td', { text: n.label || '' }),
        el('td', { text: n.group || '' }),
        el('td', { text: n.shape }),
        el('td', { text: `${n.x.toFixed(0)}, ${n.y.toFixed(0)}` }),
        el('td', { text: `${n.w.toFixed(0)} x ${n.h.toFixed(0)}` }),
        el('td', {}, [swatch(n.fill)]),
      ])
    );
    return el('table', { class: 'diagram-table' }, [
      el('thead', {}, [
        el('tr', {}, [
          'ID', 'Label', 'Group', 'Shape', 'Position', 'Size', 'Fill',
        ].map((h) => el('th', { text: h }))),
      ]),
      el('tbody', {}, rows),
    ]);
  }

  function refLabel(ref) {
    return typeof ref === 'string' ? ref : `(${ref.x.toFixed(0)}, ${ref.y.toFixed(0)})`;
  }

  function arrowLabel(e) {
    if (e.arrowStart && e.arrowEnd) return 'both';
    if (e.arrowStart) return 'start';
    if (e.arrowEnd) return 'end';
    return 'none';
  }

  function buildEdgesTable(diagram) {
    const rows = diagram.edges.map((e) => {
      const branches = (e.extraSources || []).length + (e.extraTargets || []).length;
      return el('tr', {}, [
        el('td', { text: e.id }),
        el('td', { text: refLabel(e.source) }),
        el('td', { text: refLabel(e.target) }),
        el('td', { text: e.style }),
        el('td', { text: e.pattern }),
        el('td', { text: `${e.widthStart.toFixed(1)} → ${e.widthEnd.toFixed(1)}` }),
        el('td', { text: `${e.opacityStart.toFixed(2)} → ${e.opacityEnd.toFixed(2)}` }),
        el('td', { text: arrowLabel(e) }),
        el('td', { text: branches ? String(branches) : '' }),
        el('td', {}, [swatch(e.color)]),
      ]);
    });
    return el('table', { class: 'diagram-table' }, [
      el('thead', {}, [
        el(
          'tr',
          {},
          ['ID', 'Source', 'Target', 'Path', 'Texture', 'Width', 'Opacity', 'Arrows', 'Branches', 'Color'].map((h) =>
            el('th', { text: h })
          )
        ),
      ]),
      el('tbody', {}, rows),
    ]);
  }

  function renderDiagramTable(container, diagram) {
    container.innerHTML = '';
    container.appendChild(el('h3', { text: `Nodes (${diagram.nodes.length})` }));
    container.appendChild(buildNodesTable(diagram));
    container.appendChild(el('h3', { text: `Edges (${diagram.edges.length})` }));
    container.appendChild(buildEdgesTable(diagram));
  }

  global.DG = global.DG || {};
  global.DG.renderDiagramTable = renderDiagramTable;
})(window);
