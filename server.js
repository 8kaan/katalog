require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const baseDir = __dirname;
const catalogsRoot = path.join(baseDir, 'public', 'catalogs');
const registryPath = path.join(baseDir, 'public', 'catalogs.json');

if (!fs.existsSync(catalogsRoot)) fs.mkdirSync(catalogsRoot, { recursive: true });
if (!fs.existsSync(registryPath)) {
    fs.writeFileSync(registryPath, JSON.stringify([]));
}

app.get('/api/list-catalogs', (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(fs.readFileSync(registryPath));
});

app.use(express.static(baseDir));
app.use(express.static(path.join(baseDir, 'public')));
app.use('/catalogs', express.static(catalogsRoot));

app.get('*', (req, res) => {
    res.sendFile(path.join(baseDir, 'index.html'));
});

app.listen(port, () => {
    const networkInterfaces = require('os').networkInterfaces();
    let networkIp = 'Bilinmiyor';
    
    for (const interfaceName in networkInterfaces) {
        for (const iface of networkInterfaces[interfaceName]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                networkIp = iface.address;
                break;
            }
        }
    }

    console.log(`\n-----------------------------------------------`);
    console.log(`🚀 Dijital Katalog Sunucusu Başlatıldı!`);
    console.log(`\n🏠 Yerel Erişim:   http://localhost:${port}`);
    console.log(`🌐 Ağ Erişimi:     http://${networkIp}:${port} (Tablet/Telefon için)`);
    console.log(`-----------------------------------------------\n`);
});
