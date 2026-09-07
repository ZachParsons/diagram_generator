/**
 * A second, deliberately independent visualizer for the exact same
 * diagram JSON schema -- proof that the generator's output is pluggable
 * into more than one renderer. Renders nodes/edges as plain HTML tables
 * instead of a canvas drawing, with the "safe" (non-structural) fields
 * editable in place: position, size, rotation, label, group, and fill for
 * nodes; style, pattern, width, opacity, color, and arrows for edges.
 * Structural fields (a node's generated point outline, an edge's node/
 * point references) stay read-only -- editing those is a canvas drag, not
 * a table edit. Edits commit on blur/Enter/change, not on every keystroke,
 * so a table rebuild (which every edit triggers, to reflect the new value
 * everywhere) never yanks focus out from under an in-progress edit.
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

  /** A <td> wrapping an editable <input>/<select>, calling onCommit(parsedValue) on change. */
  function editableCell(type, value, onCommit, options) {
    if (!onCommit) return el('td', { text: value });

    if (type === 'select') {
      const select = el(
        'select',
        { class: 'cell-input' },
        options.map((opt) => el('option', { value: opt, text: opt, ...(opt === value ? { selected: 'selected' } : {}) }))
      );
      select.addEventListener('change', () => onCommit(select.value));
      return el('td', {}, [select]);
    }

    if (type === 'checkbox') {
      const input = el('input', { class: 'cell-input', type: 'checkbox', ...(value ? { checked: 'checked' } : {}) });
      input.addEventListener('change', () => onCommit(input.checked));
      return el('td', {}, [input]);
    }

    const attrs = { class: 'cell-input', type, value };
    if (type === 'number' && options) Object.assign(attrs, options);
    const input = el('input', attrs);
    input.addEventListener('change', () => onCommit(type === 'number' ? parseFloat(input.value) : input.value));
    return el('td', {}, [input]);
  }

  /** A color swatch (live preview as you type) alongside an editable raw CSS-color text field. */
  function colorCell(value, onCommit) {
    if (!onCommit) return el('td', {}, [swatch(value)]);
    const box = swatch(value);
    const input = el('input', { class: 'cell-input cell-input-color', type: 'text', value });
    input.addEventListener('input', () => {
      box.style.background = input.value;
    });
    input.addEventListener('change', () => onCommit(input.value));
    return el('td', { class: 'color-cell' }, [box, input]);
  }

  function buildNodesTable(diagram, callbacks) {
    const onField = callbacks && callbacks.onNodeFieldChange;
    const rows = diagram.nodes.map((n) => {
      const set = (field, transform) => (value) => onField(n.id, field, transform ? transform(value) : value);
      return el('tr', {}, [
        el('td', { text: n.id }),
        editableCell('text', n.label || '', onField && set('label')),
        editableCell('text', n.group || '', onField && set('group')),
        el('td', { text: n.shape }),
        editableCell('number', n.x.toFixed(1), onField && set('x'), { step: 'any' }),
        editableCell('number', n.y.toFixed(1), onField && set('y'), { step: 'any' }),
        editableCell('number', n.w.toFixed(1), onField && set('w'), { step: 'any', min: 1 }),
        editableCell('number', n.h.toFixed(1), onField && set('h'), { step: 'any', min: 1 }),
        editableCell('number', ((n.rotation || 0) * (180 / Math.PI)).toFixed(0), onField && set('rotation', (deg) => (deg * Math.PI) / 180), {
          step: 1,
        }),
        colorCell(n.fill, onField && set('fill')),
      ]);
    });
    return el('table', { class: 'diagram-table' }, [
      el('thead', {}, [
        el(
          'tr',
          {},
          ['ID', 'Label', 'Group', 'Shape', 'X', 'Y', 'W', 'H', 'Rotation°', 'Fill'].map((h) => el('th', { text: h }))
        ),
      ]),
      el('tbody', {}, rows),
    ]);
  }

  function refLabel(ref) {
    return typeof ref === 'string' ? ref : `(${ref.x.toFixed(0)}, ${ref.y.toFixed(0)})`;
  }

  function branchCount(e) {
    return (e.extraSources || []).length + (e.extraTargets || []).length;
  }

  const EDGE_STYLES = ['straight', 'curved', 'orthogonal'];
  const EDGE_PATTERNS = ['solid', 'dashed', 'dotted', 'striped'];

  function buildEdgesTable(diagram, callbacks) {
    const onField = callbacks && callbacks.onEdgeFieldChange;
    const rows = diagram.edges.map((e) => {
      const set = (field, transform) => (value) => onField(e.id, field, transform ? transform(value) : value);
      const branches = branchCount(e);
      return el('tr', {}, [
        el('td', { text: e.id }),
        el('td', { text: refLabel(e.source) }),
        el('td', { text: refLabel(e.target) }),
        editableCell('select', e.style, onField && set('style'), EDGE_STYLES),
        editableCell('select', e.pattern, onField && set('pattern'), EDGE_PATTERNS),
        editableCell('number', e.widthStart.toFixed(1), onField && set('widthStart'), { step: 'any', min: 0 }),
        editableCell('number', e.widthEnd.toFixed(1), onField && set('widthEnd'), { step: 'any', min: 0 }),
        editableCell('number', e.opacityStart.toFixed(2), onField && set('opacityStart'), { step: 'any', min: 0, max: 1 }),
        editableCell('number', e.opacityEnd.toFixed(2), onField && set('opacityEnd'), { step: 'any', min: 0, max: 1 }),
        editableCell('checkbox', e.arrowStart, onField && set('arrowStart')),
        editableCell('checkbox', e.arrowEnd, onField && set('arrowEnd')),
        el('td', { text: branches ? String(branches) : '' }),
        colorCell(e.color, onField && set('color')),
      ]);
    });
    return el('table', { class: 'diagram-table' }, [
      el('thead', {}, [
        el(
          'tr',
          {},
          [
            'ID', 'Source', 'Target', 'Path', 'Texture', 'Width start', 'Width end', 'Opacity start', 'Opacity end',
            'Arrow start', 'Arrow end', 'Branches', 'Color',
          ].map((h) => el('th', { text: h }))
        ),
      ]),
      el('tbody', {}, rows),
    ]);
  }

  function renderDiagramTable(container, diagram, callbacks) {
    container.innerHTML = '';
    container.appendChild(el('h3', { text: `Nodes (${diagram.nodes.length})` }));
    container.appendChild(buildNodesTable(diagram, callbacks));
    container.appendChild(el('h3', { text: `Edges (${diagram.edges.length})` }));
    container.appendChild(buildEdgesTable(diagram, callbacks));
  }

  global.DG = global.DG || {};
  global.DG.renderDiagramTable = renderDiagramTable;
})(window);
