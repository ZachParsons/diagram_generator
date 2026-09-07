/**
 * Example "given input data" for DG.generateFromData(). Loaded via a
 * plain <script> tag (not fetch) so double-clicking index.html works
 * with no local server. Mirrors the shape documented in README.md.
 */
window.DG_SAMPLE_INPUT = {
  nodes: [
    { id: 'ui', label: 'UI', group: 'frontend', connections: ['api'] },
    { id: 'mobile', label: 'Mobile App', group: 'frontend', connections: ['api'] },
    { id: 'api', label: 'API Gateway', group: 'backend', connections: ['auth', 'orders', 'catalog'] },
    { id: 'auth', label: 'Auth Service', group: 'backend', connections: ['users_db'] },
    { id: 'orders', label: 'Orders Service', group: 'backend', connections: ['orders_db', 'catalog'] },
    { id: 'catalog', label: 'Catalog Service', group: 'backend', connections: ['catalog_db'] },
    { id: 'users_db', label: 'Users DB', group: 'data', connections: [] },
    { id: 'orders_db', label: 'Orders DB', group: 'data', connections: [] },
    { id: 'catalog_db', label: 'Catalog DB', group: 'data', connections: [] },
  ],
};
