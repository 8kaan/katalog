const { defineConfig } = require('vite');
const fs = require('fs');
const path = require('path');

const syncPlugin = () => ({
  name: 'sync-plugin',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const url = req.url.split('?')[0];

      const baseDir = path.resolve(__dirname, 'public');
      const catalogsRoot = path.join(baseDir, 'catalogs');
      const registryPath = path.join(baseDir, 'catalogs.json');

      if (!fs.existsSync(catalogsRoot)) fs.mkdirSync(catalogsRoot, { recursive: true });
      if (!fs.existsSync(registryPath)) fs.writeFileSync(registryPath, JSON.stringify([]));

      if (url === '/api/list-catalogs' && req.method === 'GET') {
          res.setHeader('Content-Type', 'application/json');
          res.end(fs.readFileSync(registryPath));
      } else {
          next();
      }
    });
  }
});

module.exports = defineConfig(() => {
  return {
    plugins: [syncPlugin()],
    server: {
      host: true,
      port: 5173,
      strictPort: true
    }
  };
});
