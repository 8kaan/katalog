


window.onerror = function (msg, url, line) {
    alert(`KRİTİK HATA: ${msg}\nSatır: ${line}`);
    console.error(msg, url, line);
};
window.onunhandledrejection = function (e) {
    alert(`SİSTEM HATASI: ${e.reason}`);
    console.error(e);
};


if (typeof $ === 'undefined') {
    console.warn("JQuery not loaded yet. Application may delay startup.");
}

let pdfjsLib = window['pdfjs-dist/build/pdf'] || window.pdfjsLib;
if (pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
} else {
    console.error("PDF.js library NOT found!");
}


const DB_NAME = 'pdf-storage';
const DB_VERSION = 4;
let db;


function getDisplayMode() {
    
    return 'double';
}

let currentDisplayMode = getDisplayMode();
const renderedPages = {}; 

const MAX_CANVAS_MEMORY = (window.innerWidth < 1024) ? 100 : 250;
const canvasLRU = [];


const CONCURRENCY = (window.innerWidth < 1024) ? 4 : 12;

function getRenderScale() {
    
    const w = window.innerWidth;
    const isMobile = w < 1024;
    let scale = isMobile ? 2.0 : 3.0; 
    if (w * scale > 8000) scale = 8000 / w;
    return scale;
}
let pdfAspectRatio = 1.414;
let manifestData = null;
let isStaticMode = false;



let loadingStartTime = 0;

const MIN_LOADING_TIME = 1500;
function updateLoadingStatus(pct, msg = "") {
    const el = document.getElementById('loading-text');
    const bar = document.getElementById('loading-progress-bar');
    const container = document.getElementById('loading-progress-container');

    
    
    if (bar) bar.style.width = `${pct}%`;
    if (container) container.style.display = 'block';
}

function getTotalPages() {
    const sm = window.isStaticMode || isStaticMode;
    const m = window.manifestData || manifestData;
    if (sm && m) {
        return parseInt(m.total_pages) || 0;
    }
    if (pdfDoc) return pdfDoc.numPages;
    return 0;
}


let currentCatalogId = null;
let catalogIndex = []; 


async function getCatalogs() {
    const res = await fetch(`/api/list-catalogs?v=${Date.now()}`);
    return res.ok ? await res.json() : [];
}

async function initDB() {
    if (db) return Promise.resolve(); 
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = (e) => {
            const dbRef = e.target.result;
            const storeNames = Array.from(dbRef.objectStoreNames);
            storeNames.forEach(name => dbRef.deleteObjectStore(name));
            dbRef.createObjectStore('pdfs');
            dbRef.createObjectStore('rendered-pages');
        };
        request.onsuccess = (e) => { db = e.target.result; resolve(); };
        request.onerror = (e) => { console.error("DB Init Error:", e.target.error); reject(e.target.error); };
    });
}


let controlActivityTimer = null;
function activateControls() {
    const controls = document.getElementById('controls');
    if (!controls) return;

    
    controls.classList.add('is-active-manual');

    
    if (controlActivityTimer) clearTimeout(controlActivityTimer);
    controlActivityTimer = setTimeout(() => {
        
        controls.classList.remove('is-active-manual');
        controlActivityTimer = null;
    }, 5000); 
}


function ensureDB() {
    if (!db) throw new Error("Veritabanı bağlantısı kurulamadı!");
}

async function savePDF(data) {
    ensureDB();
    const tx = db.transaction('pdfs', 'readwrite');
    tx.objectStore('pdfs').put(data, 'katalog');
    return new Promise(r => tx.oncomplete = r);
}

async function loadPDFFromLocal() {
    ensureDB();
    const tx = db.transaction('pdfs', 'readonly');
    return new Promise(r => {
        const req = tx.objectStore('pdfs').get('katalog');
        req.onsuccess = () => r(req.result);
        req.onerror = () => r(null);
    });
}


const SCALE_TAG = 'v11_TurboRender';

async function savePageToDisk(num, blob) {
    ensureDB();
    const tx = db.transaction('rendered-pages', 'readwrite');
    tx.objectStore('rendered-pages').put(blob, `page_${num}_${SCALE_TAG}`);
}

async function getPageFromDisk(num) {
    ensureDB();
    const tx = db.transaction('rendered-pages', 'readonly');
    return new Promise(r => {
        const req = tx.objectStore('rendered-pages').get(`page_${num}_${SCALE_TAG}`);
        req.onsuccess = () => r(req.result);
        req.onerror = () => r(null);
    });
}


let pdfDoc = null;
let lastPageTurnTime = 0; 
let isProgrammaticTurn = false; 
let currentPage = 1; 




async function startApp() {
    try {
        window.loadingStartTime = Date.now(); 
        loadingStartTime = window.loadingStartTime;
        await initDB();

        const urlParams = new URLSearchParams(window.location.search);
        const catalogId = urlParams.get('id');



        initSwipeNavigation(); 

        const backBtn = document.getElementById('back-to-library');
        if (catalogId) {
            currentCatalogId = catalogId;
            if (backBtn) backBtn.style.display = 'block';
            await loadSelectedCatalog(catalogId);
        } else {
            showLoading();
            await renderLibrary();
            hideLoading();
        }
    } catch (err) {
        console.error("App Boot Crash:", err);
        hideLoading(true);
        const statusEl = document.getElementById('status-msg');
        if (statusEl) statusEl.innerText = 'Başlatma Hatası: ' + err.message;
    }
}

async function renderLibrary() {
    const catalogs = await getCatalogs();
    const grid = document.getElementById('catalog-grid');
    const library = document.getElementById('library-view');
    const viewer = document.getElementById('flipbook-container');

    if (viewer) viewer.style.display = 'none';
    const vp = document.getElementById('viewport');
    if (vp) vp.style.display = 'none';
    if (library) library.style.display = 'flex';

    const ctrl = document.getElementById('controls');
    if (ctrl) ctrl.style.display = 'none';

    const topBar = document.getElementById('top-bar');
    if (topBar) topBar.style.display = 'none';

    const bottomBar = document.getElementById('bottom-bar');
    if (bottomBar) bottomBar.style.display = 'none';

    const backToLib = document.getElementById('back-to-library');
    if (backToLib) backToLib.style.display = 'none';

    
    const searchPanel = document.getElementById('search-panel');
    if (searchPanel) searchPanel.classList.add('modal-hidden');
    const searchInput = document.getElementById('global-search-input');
    if (searchInput) searchInput.value = '';
    const fsBtn = document.getElementById('toggle-fullscreen');
    if (fsBtn) fsBtn.style.display = 'none';

    document.body.classList.remove('is-viewing-catalog'); 

    

    if ($('#flipbook').data('turn')) {
        $('#flipbook').turn('destroy').empty();
        
        
        renderQueue = [];
        isProcessingQueue = false;
        resetZoom();
    }



    grid.innerHTML = '';

    if (catalogs.length === 0) {
        grid.innerHTML = '<p style="grid-column: 1/-1; text-align:center; opacity: 0.5;">Henüz hiç katalog eklenmemiş.</p>';
        return;
    }

    catalogs.forEach(cat => {
        const card = document.createElement('div');
        card.className = 'catalog-card';
        card.setAttribute('data-id', cat.id); 
        card.innerHTML = `

            <div class="catalog-cover">
                <div class="cat-gloss"></div>
                <div class="cat-fold"></div>
                <img src="/catalogs/${cat.id}/pages/page-1.webp" onerror="this.src='https://placehold.co/400x600/1a1a1a/eb8921?text=${encodeURIComponent(cat.name)}'">
            </div>
            <div class="catalog-info">
                <h4>${cat.name}</h4>
            </div>
        `;
        card.onclick = () => {
            const url = new URL(window.location);
            url.searchParams.set('id', cat.id);
            window.history.pushState({}, '', url);
            startApp();
        };

        grid.appendChild(card);
    });
}

document.getElementById('back-to-library').onclick = () => {
    const url = new URL(window.location);
    url.searchParams.delete('id');
    window.history.pushState({}, '', url);
    startApp();
};

async function loadSelectedCatalog(id, targetPage = 1, suppressHide = false) {
    window.loadingStartTime = Date.now(); 
    loadingStartTime = window.loadingStartTime;
    showLoading(); 
    
    zoomLevel = 1;
    applyZoom();

    document.getElementById('library-view').style.display = 'none';
    const viewport = document.getElementById('viewport');
    viewport.style.display = 'block'; 
    document.body.classList.add('is-viewing-catalog');

    const topBar = document.getElementById('top-bar');
    if (topBar) topBar.style.display = 'flex';
    const bottomBar = document.getElementById('bottom-bar');
    if (bottomBar) bottomBar.style.display = 'flex';

    const topNav = document.getElementById('top-nav-group');
    if (topNav) topNav.style.display = 'flex';
    const libBtn = document.getElementById('back-to-library');
    if (libBtn) libBtn.style.display = 'flex';

    const fsBtn = document.getElementById('toggle-fullscreen');
    if (fsBtn) fsBtn.style.display = 'flex';

    if (typeof $ !== 'undefined') {
        $(document).trigger('catalog:ready');
    }

    try {
        const mRes = await fetch(`/catalogs/${id}/manifest.json?v=${Date.now()}`);
        if (mRes.ok) {
            const data = await mRes.json();
            window.manifestData = data;
            manifestData = data;
            isStaticMode = true;
            await initStaticCatalog(id);
        } else {
            const res = await fetch(`/catalogs/${id}/katalog.pdf`);
            if (res.ok) {
                const data = await res.arrayBuffer();
                await renderCatalog(data);
            }
        }

        
        setTimeout(() => {
            syncLayout(0);
            if (targetPage > 1) {
                loudTurn('page', targetPage);
            }
            if (!suppressHide) hideLoading();
        }, 300);

    } catch (e) {
        console.error("Critical Load Error:", e);
        if (!suppressHide) hideLoading(true);
    }
}


function showCustomDialog({ title, msg, onConfirm, isPrompt = false, defaultValue = '' }) {
    const dialog = document.getElementById('custom-dialog');
    const titleEl = document.getElementById('dialog-title');
    const msgEl = document.getElementById('dialog-msg');
    const inputContainer = document.getElementById('dialog-prompt-container');
    const inputEl = document.getElementById('dialog-input');
    const confirmBtn = document.getElementById('dialog-confirm');
    const cancelBtn = document.getElementById('dialog-cancel');

    if (!dialog || !titleEl || !msgEl || !confirmBtn) return;

    titleEl.innerText = title || "ONAY";
    msgEl.innerText = msg || "";

    if (isPrompt) {
        inputContainer.style.display = 'block';
        inputEl.value = defaultValue;
        setTimeout(() => inputEl.focus(), 100);
    } else {
        inputContainer.style.display = 'none';
    }

    dialog.classList.remove('modal-hidden');
    dialog.style.display = 'flex';

    confirmBtn.onclick = () => {
        const result = isPrompt ? inputEl.value : true;
        dialog.classList.add('modal-hidden');
        if (onConfirm) onConfirm(result);
    };

    cancelBtn.onclick = () => {
        dialog.classList.add('modal-hidden');
    };
}




async function renderCatalog(dataBuffer = null) {
    console.log("Starting render engine (V68.0)...");
    document.getElementById('empty-state').style.display = 'none';
    document.getElementById('flipbook-container').style.display = 'block';

    let loadingTask;
    try {
        if (dataBuffer) {
            const typedData = (dataBuffer instanceof Uint8Array) ? dataBuffer : new Uint8Array(dataBuffer);
            loadingTask = pdfjsLib.getDocument({
                data: typedData,
                
                onProgress: (p) => {
                    const pct = Math.round((p.loaded / p.total) * 100);
                    if (!isNaN(pct)) updateLoadingStatus(pct);
                }
            });
        } else {
            loadingTask = pdfjsLib.getDocument({
                url: `/catalogs/${currentCatalogId}/katalog.pdf`,
                onProgress: (p) => {
                    const pct = Math.round((p.loaded / p.total) * 100);
                    if (!isNaN(pct)) updateLoadingStatus(pct);
                }
            });
        }
    } catch (e) {
        console.error("Render Engine Error (Init):", e);
        
        loadingTask = pdfjsLib.getDocument(`/catalogs/${currentCatalogId}/katalog.pdf`);
    }

    pdfDoc = await loadingTask.promise;
    const total = pdfDoc.numPages;
    const firstPage = await pdfDoc.getPage(1);
    const vp = firstPage.getViewport({ scale: 1 });
    pdfAspectRatio = vp.width / vp.height;

    
    const allPages = Array.from({ length: total }, (_, i) => i + 1);
    const container = document.getElementById('flipbook-container');
    container.style.display = 'block';
    const oldFb = document.getElementById('flipbook');
    if (oldFb) {
        if ($(oldFb).data('turn')) $(oldFb).turn('destroy');
        oldFb.remove();
    }
    const $fb = $('<div id="flipbook"></div>').appendTo(container);

    
    for (let i = 0; i < allPages.length; i += CONCURRENCY) {
        const chunk = allPages.slice(i, i + CONCURRENCY);
        await Promise.all(chunk.map(num => renderPage(num)));
        const progress = Math.round(((i + chunk.length) / total) * 100);
        updateLoadingStatus(progress);
    }

    initTurnJS(true);

    hideLoading();

    
    resetZoom();
    handleResize();
}


async function initStaticCatalog(id) {
    currentCatalogId = id;
    pdfAspectRatio = manifestData.aspect_ratio || 1.414;
    const total = manifestData.total_pages;
    const allPages = Array.from({ length: total }, (_, i) => i + 1);
    const batchSize = 12; 

    
    for (let i = 0; i < allPages.length; i += batchSize) {
        const chunk = allPages.slice(i, i + batchSize);
        await Promise.all(chunk.map(num => renderPage(num)));
        const progress = Math.round(((i + chunk.length) / total) * 100);
        updateLoadingStatus(progress);
    }

    
    const container = document.getElementById('flipbook-container');
    container.style.display = 'block';
    const oldFb = document.getElementById('flipbook');
    if (oldFb) {
        if ($(oldFb).data('turn')) $(oldFb).turn('destroy');
        oldFb.remove();
    }
    const $fb = $('<div id="flipbook"></div>').appendTo(container);

    
    allPages.forEach(num => {
        const cacheKey = `${currentCatalogId}_${num}`; 
        const $page = $(`<div class="page" data-num="${num}"></div>`).appendTo($fb);
        if (renderedPages[cacheKey]) {
            $page.append(renderedPages[cacheKey]).addClass('rendered');
        }
    });

    
    initTurnJS(true); 
    $('.side-nav-btn').addClass('is-active');
    document.getElementById('controls').style.display = 'flex';

    
    const elapsed = Date.now() - loadingStartTime;
    const remaining = Math.max(0, MIN_LOADING_TIME - elapsed);

    setTimeout(() => {
        hideLoading();
        resetZoom();
        handleResize();
    }, remaining);

    
    if (pdfDoc || isStaticMode) {
        indexCatalogOffline();
    }
}


function normalizeForSearch(str) {
    if (!str) return "";
    return str.replace(/\s+/g, ' ') 
        .replace(/İ/g, "i")
        .replace(/I/g, "ı")
        .replace(/Ğ/g, "ğ")
        .replace(/Ü/g, "ü")
        .replace(/Ş/g, "ş")
        .replace(/Ö/g, "ö")
        .replace(/Ç/g, "ç")
        .toLowerCase()
        .replace(/[\u0300-\u036f]/g, "") 
        .replace(/\s/g, "") 
        .trim();
}


function cleanOriginalText(str) {
    if (!str) return "";
    return str.replace(/\s+/g, ' ').trim();
}


async function indexCatalogOffline() {
    console.log(`[INDEX] Background Indexing Started for: ${currentCatalogId}`);
    catalogIndex = []; 

    
    try {
        const res = await fetch(`/catalogs/${currentCatalogId}/search-index.json?v=${Date.now()}`);
        if (res.ok) {
            catalogIndex = await res.json();
            console.log(`[INDEX] Pre-built server index loaded successfully. Pages: ${catalogIndex.length}`);
            refreshSearchPanel();
            return;
        }
    } catch (e) {
        console.warn("[INDEX] Server index missing or unreachable, falling back to PDF scan...");
    }

    let localPdf = pdfDoc;
    if (!localPdf && currentCatalogId) {
        try {
            console.log("[INDEX] Fetching source PDF for indexing...");
            const res = await fetch(`/catalogs/${currentCatalogId}/katalog.pdf`);
            if (!res.ok) throw new Error("HTTP " + res.status);
            const buf = await res.arrayBuffer();
            const loading = pdfjsLib.getDocument({ data: buf });
            localPdf = await loading.promise;
        } catch (e) {
            console.error(`[INDEX] Critical Error: PDF fetch failed (${e.message}). Search restricted.`);
            return;
        }
    }

    if (!localPdf) {
        console.warn("[INDEX] No PDF document available for indexing.");
        return;
    }

    console.log(`[INDEX] Total pages to index: ${localPdf.numPages}`);

    for (let i = 1; i <= localPdf.numPages; i++) {
        if (i % 5 === 0) {
            await new Promise(r => setTimeout(r, 50));
            console.log(`[INDEX] Progress: %${Math.round((i / localPdf.numPages) * 100)}`);
        }
        try {
            const page = await localPdf.getPage(i);
            const content = await page.getTextContent();
            
            const rawText = content.items.map(item => item.str).join('');
            const cleanText = content.items.map(item => item.str).join(' '); 
            const text = normalizeForSearch(rawText);
            catalogIndex.push({ page: i, text: text, original: cleanOriginalText(cleanText) });
        } catch (e) { console.warn(`[INDEX] Page ${i} failed: ${e.message}`); }
    }
    console.log(`[INDEX] Complete. Total: ${catalogIndex.length} pages indexed.`);

    
    
    if (isAdmin && catalogIndex.length > 0) {
        console.log("[INDEX] Admin session detected. Saving built index to server for remote optimization...");
        fetch(`/api/save-search-index?id=${currentCatalogId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(catalogIndex)
        });
    }

    refreshSearchPanel();
}

function refreshSearchPanel() {
    const input = document.getElementById('global-search-input');
    if (input && input.value.length >= 3) {
        handleGlobalSearch(input.value);
    }
}

function handleGlobalSearch(query) {
    const q = normalizeForSearch(query); 
    console.log(`[SEARCH] Query: "${q}" - Index Size: ${catalogIndex.length}`);

    const panel = document.getElementById('search-panel');
    const resultsList = document.getElementById('search-results-list');
    const countEl = document.getElementById('search-total-count');

    if (!q) {
        if (panel) panel.classList.add('modal-hidden');
        return;
    }

    
    const errorEl = document.getElementById('search-error');
    if (q.length < 3) {
        if (errorEl) errorEl.classList.add('is-visible');
        return;
    } else {
        if (errorEl) errorEl.classList.remove('is-visible');
    }

    if (panel) panel.classList.remove('modal-hidden');
    if (resultsList) resultsList.innerHTML = '';

    
    if (catalogIndex.length === 0) {
        console.warn("[SEARCH] Index is empty. Search will yield no results.");
        if (resultsList) resultsList.innerHTML = '<div style="padding:20px; text-align:center; opacity:0.5;">İNDEKSLENİYOR, LÜTFEN BEKLEYİN...</div>';
    }

    const matches = catalogIndex.filter(item => item.text.includes(q));
    console.log(`[SEARCH] Matches found: ${matches.length}`);

    if (countEl) countEl.innerText = matches.length;

    if (matches.length === 0 && catalogIndex.length > 0) {
        if (resultsList) resultsList.innerHTML = '<div style="padding:20px; text-align:center; opacity:0.5;">SONUÇ BULUNAMADI.</div>';
    }

    matches.forEach(match => {
        const item = document.createElement('div');
        item.className = 'search-result-item';
        const idx = match.text.indexOf(q);
        const snippet = match.original.substring(Math.max(0, idx - 40), Math.min(match.original.length, idx + q.length + 40));

        item.innerHTML = `
            <div class="res-page">SAYFA ${match.page}</div>
            <div class="res-snippet">...${snippet.replace(new RegExp(q, 'gi'), '<strong>$&</strong>')}...</div>
        `;
        item.onclick = () => {
            loudTurn('page', match.page);
            if (window.innerWidth < 1024 && panel) panel.classList.add('modal-hidden');
        };
        if (resultsList) resultsList.appendChild(item);
    });
}

async function renderPage(num) {
    const total = getTotalPages();
    if (num < 1 || num > total) return; 

    const cacheKey = `${currentCatalogId}_${num}`;

    
    if (renderedPages[cacheKey]) {
        injectCanvasToDOM(num, renderedPages[cacheKey]);
        return;
    }

    if (isStaticMode) {
        
        return new Promise((resolve) => {
            const img = new Image();
            
            img.src = `/catalogs/${currentCatalogId}/pages/page-${num}.webp?v=${manifestData.timestamp}`;
            img.style.width = '100%';
            img.style.height = '100%';
            img.style.objectFit = 'contain';
            img.style.display = 'block';

            img.onload = () => {
                
                if (num === 1 && img.width > 0 && img.height > 0) {
                    const realRatio = img.width / img.height;
                    if (Math.abs(pdfAspectRatio - realRatio) > 0.01) {
                        pdfAspectRatio = realRatio;
                        syncLayout(100);
                    }
                }
                renderedPages[cacheKey] = img; 
                injectCanvasToDOM(num, img);
                resolve(img);
            };
            img.onerror = async () => {
                console.warn(`Static Page ${num} missing, falling back to PDF render...`);
                
                try {
                    const canvas = await renderFromPDF(num);
                    resolve(canvas);
                } catch (err) {
                    resolve(null);
                }
            };
        });
    } else {
        if (!pdfDoc) return;
        return renderFromPDF(num);
    }
}

async function renderFromPDF(num) {
    if (!pdfDoc) {
        try {
            const pdfRes = await fetch(`/catalogs/${currentCatalogId}/katalog.pdf`);
            const buf = await pdfRes.arrayBuffer();
            pdfDoc = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
        } catch (e) {
            console.error("PDF Load Error for Fallback:", e);
            return null;
        }
    }
    const cacheKey = `${currentCatalogId}_${num}`; 
    try {
        const page = await pdfDoc.getPage(num);
        const scale = getRenderScale();
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext('2d', { alpha: false });
        await page.render({ canvasContext: ctx, viewport }).promise;

        renderedPages[cacheKey] = canvas;
        injectCanvasToDOM(num, canvas);

        
        setTimeout(() => {
            new Promise(r => canvas.toBlob(r, 'image/webp', 0.8)).then(blob => {
                if (blob) {
                    savePageToDisk(num, blob);
                    
                    if (isAdmin && currentCatalogId) {
                        fetch(`/api/upload-page?id=${currentCatalogId}&page=${num}`, { method: 'POST', body: blob });
                    }
                }
            });
        }, 10);
    } catch (e) {
        console.error(`PDF Render Error ${num}:`, e);
    }
}

async function blobToCanvas(blob) {
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    bitmap.close();
    return canvas;
}

function injectCanvasToDOM(num, canvas) {
    const $page = $(`.page[data-num="${num}"]`);
    if ($page.length) {
        $page.empty().append(canvas).addClass('rendered');
    }

    const cacheKey = `${currentCatalogId}_${num}`;

    if (!renderedPages[cacheKey]) {
        renderedPages[cacheKey] = canvas;
        canvasLRU.push(cacheKey);
        if (canvasLRU.length > MAX_CANVAS_MEMORY) {
            const oldestKey = canvasLRU.shift();
            delete renderedPages[oldestKey];
        }
    } else {
        
        const idx = canvasLRU.indexOf(cacheKey);
        if (idx > -1) canvasLRU.splice(idx, 1);
        canvasLRU.push(cacheKey);
    }
}


function initTurnJS(skipPageCreation = false) {
    
    const container = document.getElementById('flipbook-container');

    if (!skipPageCreation) {
        const oldFb = document.getElementById('flipbook');
        if (oldFb) {
            if ($(oldFb).data('turn')) $(oldFb).turn('destroy');
            oldFb.remove();
        }
        const $fb = $('<div id="flipbook"></div>').appendTo(container);
        const total = getTotalPages();
        for (let i = 1; i <= total; i++) {
            $fb.append(`<div class="page" data-num="${i}"><div class="page-loader" style="display:flex;justify-content:center;align-items:center;width:100%;height:100%;color:rgba(255,255,255,0.2);font-size:10px;letter-spacing:2px;">SAYFA ${i}</div></div>`);
        }
    }

    const total = getTotalPages();
    const $fb = $('#flipbook');

    const dims = calculateDimensions();
    if (container) {
        container.style.width = dims.width + 'px';
        container.style.height = dims.height + 'px';
    }
    const zoomContent = document.getElementById('zoom-content');
    if (zoomContent) {
        zoomContent.style.width = dims.width + 'px';
        zoomContent.style.height = dims.height + 'px';
    }

    
    const displayMode = 'double';

    
    $('#flipbook').turn({
        width: dims.width,
        height: dims.height,
        display: displayMode,
        autoCenter: true, 
        pages: total,
        acceleration: true,
        gradients: false, 
        elevation: 50,
        duration: 1000,
        when: {
            turning: (e, page) => {
                resetZoom();
                syncLayout(0); 
            },
            turned: (e, page) => {
                currentPage = page; 
                
                const view = $(e.target).turn('view').filter(v => v !== 0);
                const infoEl = document.getElementById('page-info');
                if (infoEl && view.length > 0) {
                    infoEl.innerText = view.length > 1 ? `SAYFA ${view[0]} - ${view[1]}` : `SAYFA ${view[0]}`;
                }
                syncLayout(0); 
            },
            missing: (e, pages) => {
                pages.forEach(p => renderPage(p));
            }
        }
    });
    const fbEl = document.getElementById('flipbook');
    if (fbEl) bridgeTouchToMouse(fbEl);
    updatePageInfo(); 
    hideLoading();
}



function bridgeTouchToMouse(target) {
    const typeMap = { touchstart: 'mousedown', touchmove: 'mousemove', touchend: 'mouseup' };
    const handler = (e) => {
        
        if (e.touches && e.touches.length > 2) { e.preventDefault(); return; }
        
        if (e.touches && e.touches.length === 2) return;
        
        const touch = e.changedTouches[0];
        const mouseEvent = new MouseEvent(typeMap[e.type], { bubbles: true, clientX: touch.clientX, clientY: touch.clientY });
        target.dispatchEvent(mouseEvent);
        e.preventDefault();
    };
    target.addEventListener('touchstart', handler, { passive: false });
    target.addEventListener('touchmove', handler, { passive: false });
    target.addEventListener('touchend', handler, { passive: false });
}

function calculateDimensions() {
    const topBar = document.getElementById('top-bar');
    const bottomBar = document.getElementById('bottom-bar');

    
    const topH = (topBar && topBar.offsetHeight > 0) ? topBar.offsetHeight : 42;
    const bottomH = (bottomBar && bottomBar.offsetHeight > 0) ? bottomBar.offsetHeight : 48;

    const uw = window.innerWidth;
    const uh = window.innerHeight;
    const usableH = uh - topH - bottomH;

    const ratio = (pdfAspectRatio > 0.1 && pdfAspectRatio < 3) ? pdfAspectRatio : 0.707;
    const dpsRatio = ratio * 2;

    
    const margin = (uw <= 1024) ? 15 : 0;
    const safeUw = uw - (margin * 2);

    let targetH = usableH;
    let targetW = targetH * dpsRatio;

    if (targetW > safeUw) {
        targetW = safeUw;
        targetH = targetW / dpsRatio;
    }

    return {
        width: Math.round(targetW),
        height: Math.round(targetH),
        topOffset: topH,
        bottomOffset: bottomH
    };
}


const handleOrientationChange = () => {
    
    setTimeout(() => {
        console.log("[ORIENT-SYNC] Yön değişimi algılandı, layout sabitleniyor...");
        if (document.fullscreenElement && currentCatalogId) {
            
            const savedPage = currentPage; 
            showLoading();
            setTimeout(async () => {
                if ($('#flipbook').data('turn')) {
                    $('#flipbook').turn('destroy').empty();
                }
                await loadSelectedCatalog(currentCatalogId, savedPage, false);
            }, 300);
        } else {
            syncLayout(0);
            setTimeout(() => syncLayout(0), 400);
            setTimeout(() => syncLayout(0), 700);
        }
    }, 350);
};

window.addEventListener('orientationchange', handleOrientationChange);

if (screen.orientation) {
    screen.orientation.addEventListener('change', handleOrientationChange);
}


let layoutSyncTimer = null;

function syncLayout(delay = 50) {
    if (layoutSyncTimer) clearTimeout(layoutSyncTimer);

    const execute = () => {
        

        
        const dims = calculateDimensions();

        const $fb = $('#flipbook');
        const zv = document.getElementById('zoom-viewport');
        const zc = document.getElementById('zoom-content');
        const c = document.getElementById('flipbook-container');

        
        if (zoomLevel > 1) { zoomLevel = 1; applyZoom(); }

        
        if (zv) {
            zv.style.cssText = `
                position: absolute !important; 
                top: ${dims.topOffset}px !important; 
                bottom: ${dims.bottomOffset}px !important; 
                left: 0 !important; 
                right: 0 !important; 
                height: auto !important;
                display: flex !important; 
                align-items: center !important; 
                justify-content: center !important; 
                overflow: hidden !important;
            `;
        }

        
        if (zc) {
            zc.style.cssText = `
                width: ${dims.width}px !important; 
                height: ${dims.height}px !important; 
                position: relative !important; 
                margin: 0 !important;
                transform: scale(${zoomLevel}) !important; 
                transform-origin: center center !important;
                transition: transform 0.2s ease-out !important;
            `;
        }

        if (c) {
            c.style.cssText = `width: 100% !important; height: 100% !important; position: relative !important;`;
        }

        
        if ($fb.turn && $fb.data('turn')) {
            $fb.turn('size', dims.width, dims.height);
            $fb.turn('resize');

            
            const internal = $fb.find('.turn-viewport');
            if (internal.length) {
                internal.css({
                    'top': '50%',
                    'left': '50%',
                    'transform': 'translate(-50%, -50%)',
                    'margin': '0',
                    'position': 'absolute'
                });
            }
        }
    };

    
    execute();
    requestAnimationFrame(execute);
    setTimeout(execute, 150);
    setTimeout(execute, 300);
}

function handleResize() {
    syncLayout(0); 
}


function debounce(func, wait) {
    let timeout;
    return function (...args) {
        const context = this;
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(context, args), wait);
    };
}

const debouncedResize = debounce(handleResize, 150);
window.addEventListener('resize', debouncedResize);

function updatePageInfo() {
    const $fb = $('#flipbook');
    const infoEl = document.getElementById('page-info');
    if (!infoEl || !$fb.length || !$fb.data('turn')) return;

    const view = $fb.turn('view').filter(v => v !== 0);
    if (view.length > 0) {
        infoEl.innerText = view.length > 1 ? `SAYFA ${view[0]} - ${view[1]}` : `SAYFA ${view[0]}`;
    }
}



function showLoading() {
    const el = document.getElementById('loading-overlay');
    if (el) el.style.display = 'flex';
}

function hideLoading(instant = false) {
    const el = document.getElementById('loading-overlay');
    if (!el) return;
    if (instant) {
        el.style.display = 'none';
    } else {
        $(el).fadeOut(500);
    }
}


let zoomLevel = 1;
let currentX = 0, currentY = 0;
let isPanning = false;
let lastMouseX = 0, lastMouseY = 0;
let lastTouchTime = 0;

function applyZoom() {
    const c = document.getElementById('zoom-content');
    const edgeZones = document.querySelectorAll('.edge-swipe-zone');

    if (c) {
        c.style.transform = `translate(${currentX}px, ${currentY}px) scale(${zoomLevel})`;
    }

    
    edgeZones.forEach(z => {
        z.style.pointerEvents = zoomLevel > 1 ? 'none' : 'auto';
    });

    if ($('#flipbook').data('turn')) {
        $('#flipbook').turn('disable', zoomLevel > 1);
    }
}




function fitToScreen() {
    return;
}

function resetZoom() {
    zoomLevel = 1; currentX = 0; currentY = 0; applyZoom();
}

const viewport = document.getElementById('viewport');
if (viewport) {
    
    viewport.addEventListener('wheel', (e) => {
        e.preventDefault();
        const rect = viewport.getBoundingClientRect();
        const mx = e.clientX - rect.left - rect.width / 2;
        const my = e.clientY - rect.top - rect.height / 2;

        const oldZoom = zoomLevel;
        const scrollFactor = e.deltaY > 0 ? 0.9 : 1.1;
        zoomLevel = Math.min(Math.max(1, zoomLevel * scrollFactor), 2);

        if (zoomLevel !== oldZoom) {
            if (zoomLevel === 1) {
                resetZoom();
            } else {
                const ratio = zoomLevel / oldZoom;
                currentX = mx - (mx - currentX) * ratio;
                currentY = my - (my - currentY) * ratio;
                applyZoom();
            }
        }
    }, { passive: false });

    
    const startPan = (e) => {
        
        if (e.target.closest('button') || e.target.closest('.side-nav-btn') || e.target.closest('#controls')) {
            return;
        }

        const now = Date.now();
        const isDoubleTap = (now - lastTouchTime < 300 && (!e.touches || e.touches.length === 1));
        lastTouchTime = now;

        const clientX = e.clientX || (e.touches && e.touches[0].clientX);
        const clientY = e.clientY || (e.touches && e.touches[0].clientY);

        if (zoomLevel <= 1) return;
        isPanning = true;
        lastMouseX = clientX;
        lastMouseY = clientY;
        viewport.style.cursor = 'grabbing';
        document.body.style.userSelect = 'none'; 
        e.preventDefault(); 
    };

    const movePan = (e) => {
        if (!isPanning) return;
        const clientX = e.type.startsWith('touch') ? e.touches[0].clientX : e.clientX;
        const clientY = e.type.startsWith('touch') ? e.touches[0].clientY : e.clientY;

        const deltaX = clientX - lastMouseX;
        const deltaY = clientY - lastMouseY;

        currentX += deltaX;
        currentY += deltaY;

        lastMouseX = clientX;
        lastMouseY = clientY;

        
        const flipbook = document.getElementById('flipbook');
        if (flipbook) {
            const z = zoomLevel;
            const vw = viewport.clientWidth;
            const vh = viewport.clientHeight;
            const fw = flipbook.clientWidth * z;
            const fh = flipbook.clientHeight * z;

            
            const paddingX = vw * 0.4;
            const paddingY = vh * 0.4;

            
            if (fw <= vw) {
                currentX = Math.max(-paddingX, Math.min(paddingX, currentX));
            } else {
                const limitX = (fw - vw) / 2 + paddingX;
                currentX = Math.max(-limitX, Math.min(limitX, currentX));
            }

            
            if (fh <= vh) {
                currentY = Math.max(-paddingY, Math.min(paddingY, currentY));
            } else {
                const limitY = (fh - vh) / 2 + paddingY;
                currentY = Math.max(-limitY, Math.min(limitY, currentY));
            }
        }

        applyZoom();
    };

    const endPan = () => {
        isPanning = false;
        viewport.style.cursor = 'default';
        document.body.style.userSelect = ''; 
    };

    viewport.addEventListener('mousedown', startPan);
    viewport.addEventListener('touchstart', startPan, { passive: false });
    window.addEventListener('mousemove', movePan);
    window.addEventListener('touchmove', movePan, { passive: false });
    window.addEventListener('mouseup', endPan);
    window.addEventListener('touchend', endPan);
}


function toggleFullScreen() {
    if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(() => { });
    } else {
        if (document.exitFullscreen) document.exitFullscreen();
    }
}

function updateFullscreenUI() {
    const isFS = !!document.fullscreenElement;
    const fsBtn = document.getElementById('toggle-fullscreen');
    if (fsBtn) {
        isFS ? fsBtn.classList.add('is-active') : fsBtn.classList.remove('is-active');
    }
}

$(document).on('click', '#toggle-fullscreen', toggleFullScreen);
document.addEventListener('fullscreenchange', updateFullscreenUI);


document.addEventListener('touchstart', (e) => {
    if (e.touches.length > 2) e.preventDefault();
}, { passive: false });
document.addEventListener('touchmove', (e) => {
    if (e.touches.length > 2) e.preventDefault();
}, { passive: false });


const loudTurn = (dir, val = null) => {
    const $fb = $('#flipbook');
    if (!$fb.length) return;

    isProgrammaticTurn = true; 
    resetZoom();
    if (val !== null) $fb.turn('page', val);
    else $fb.turn(dir);
    setTimeout(() => { isProgrammaticTurn = false; }, 500); 
};

if (typeof $ !== 'undefined') {
    $(document).on('click', '#first-btn', () => loudTurn('page', 1));
    $(document).on('click', '#last-btn', () => { const t = getTotalPages(); if (t > 0) loudTurn('page', t); });
    $(document).on('click', '#prev-btn', () => loudTurn('previous'));
    $(document).on('click', '#next-btn', () => loudTurn('next'));
}


if (typeof $ !== 'undefined') {
    $(document).on('click', '#side-nav-prev', () => loudTurn('previous'));
    $(document).on('click', '#side-nav-next', () => loudTurn('next'));

    $(document).on('click', '#toggle-fullscreen, #toggle-fullscreen-top', (e) => {
        e.preventDefault();
        toggleFullScreen();
    });
}

document.addEventListener('fullscreenchange', async () => {
    const isFS = !!document.fullscreenElement;
    if (typeof updateFullscreenUI === 'function') updateFullscreenUI();
    document.body.classList.toggle('is-fullscreen', isFS);

    
    
    
    if (currentCatalogId) {
        const savedPage = currentPage; 

        showLoading(); 

        
        setTimeout(async () => {
            
            if ($('#flipbook').data('turn')) {
                $('#flipbook').turn('destroy').empty();
            }

            
            await loadSelectedCatalog(currentCatalogId, savedPage, false);

            console.log("[FS] Re-initialization complete. Alignment restored.");
        }, 400);
    }
});


const pageNav = document.getElementById('page-nav');
const pageInfo = document.getElementById('page-info');
const pageSelector = document.getElementById('page-selector-modal');
const pageSelectorGrid = document.getElementById('page-selector-grid');
const pageSelectorInput = document.getElementById('page-selector-input');
const pageSelectorConfirm = document.getElementById('page-selector-confirm');
const pageSelectorClose = document.getElementById('page-selector-close');

function openPageSelector() {
    if (!pageSelector || !pageSelectorGrid) return;

    const $fb = $('#flipbook');
    if (!$fb.data('turn')) return;

    const total = getTotalPages();
    const current = $fb.turn('page');

    
    pageSelectorGrid.innerHTML = '';
    for (let i = 1; i <= total; i++) {
        const btn = document.createElement('button');
        btn.className = `page-btn ${i === current ? 'active' : ''}`;
        btn.innerHTML = `${i}<span>Sayfa</span>`;
        btn.onclick = () => {
            if (!$fb.data('turn')) return;
            resetZoom();
            $fb.turn('page', i);
            closePageSelector();
        };
        pageSelectorGrid.appendChild(btn);
    }

    if (pageSelectorInput) pageSelectorInput.value = current;

    pageSelector.classList.remove('modal-hidden');

    
    setTimeout(() => {
        const activeBtn = pageSelectorGrid.querySelector('.page-btn.active');
        if (activeBtn) activeBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 100);
}

function closePageSelector() {
    if (pageSelector) pageSelector.classList.add('modal-hidden');
}

if (pageNav) pageNav.onclick = openPageSelector;
if (pageSelectorClose) pageSelectorClose.onclick = closePageSelector;
if (pageSelectorConfirm) {
    pageSelectorConfirm.onclick = () => {
        const val = parseInt(pageSelectorInput.value);
        const total = getTotalPages();
        if (val >= 1 && val <= total) {
            const $fb = $('#flipbook');
            if (!$fb.data('turn')) return;
            resetZoom();
            $fb.turn('page', val);
            closePageSelector();
        }
    };
}
if (pageSelectorInput) {
    pageSelectorInput.onkeydown = (e) => {
        if (e.key === 'Enter') pageSelectorConfirm.click();
    };
}


if (pageSelector) {
    pageSelector.onclick = (e) => {
        if (e.target === pageSelector) closePageSelector();
    };
}


const controls = document.getElementById('controls');
let controlsTimeout;
function flashControls() {
    if (!controls) return;
    controls.classList.add('is-active');
    clearTimeout(controlsTimeout);
    
}
document.addEventListener('mousemove', flashControls);
document.addEventListener('touchstart', flashControls);


const sideNavPrev = document.getElementById('side-nav-prev');
const sideNavNext = document.getElementById('side-nav-next');
let sideNavTimeout;
function flashSideNav() {
    if (sideNavPrev) sideNavPrev.classList.add('is-active');
    if (sideNavNext) sideNavNext.classList.add('is-active');
    clearTimeout(sideNavTimeout);
    
}
document.addEventListener('mousemove', flashSideNav);
document.addEventListener('touchstart', flashSideNav);


document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    const $fb = $('#flipbook');
    if (!$fb.data('turn')) return;

    if (e.key === 'ArrowLeft') $fb.turn('previous');
    if (e.key === 'ArrowRight') $fb.turn('next');
    if (e.key === 'Home') $fb.turn('page', 1);
    if (e.key === 'End') {
        const total = getTotalPages();
        if (total > 0) $fb.turn('page', total);
    }
});


if (typeof $ !== 'undefined') {
    $(document).on('mousedown touchstart', '#flipbook', function (e) {
        const p = e.touches ? e.touches[0] : e;
        const pos = { x: p.clientX, y: p.clientY };
        $(this).data('lastTouch', pos);
    });

    $(document).on('mousemove touchmove', '#flipbook', function (e) {
        const p = e.touches ? e.touches[0] : e;
        $(this).data('lastTouch', { x: p.clientX, y: p.clientY });
    });
}

function initSwipeNavigation() {
    
    $(document).on('dragstart', '#flipbook, #flipbook img, #flipbook canvas, #viewport', (e) => e.preventDefault());
    $(document).on('selectstart', '#viewport', (e) => { if (zoomLevel > 1) e.preventDefault(); });
}


const keyboard = document.getElementById('virtual-keyboard');
const kbRows = document.getElementById('keyboard-rows');
let targetInput = null;

const LAYOUT = [
    ["Q", "W", "E", "R", "T", "Y", "U", "I", "O", "P", "Ğ", "Ü"],
    ["A", "S", "D", "F", "G", "H", "J", "K", "L", "Ş", "İ"],
    ["Z", "X", "C", "V", "B", "N", "M", "Ö", "Ç"]
];

function initKeyboard() {
    if (!kbRows) return;
    kbRows.innerHTML = '';
    LAYOUT.forEach(row => {
        const rowEl = document.createElement('div');
        rowEl.className = 'kb-row';
        row.forEach(key => {
            const btn = document.createElement('div');
            btn.className = 'kb-btn';
            btn.innerText = key;
            btn.onclick = () => {
                if (targetInput) {
                    targetInput.value += key;
                    targetInput.dispatchEvent(new Event('input'));
                }
            };
            rowEl.appendChild(btn);
        });
        kbRows.appendChild(rowEl);
    });
}

function showVirtualKeyboard(input) {
    targetInput = input;
    if (keyboard) keyboard.classList.remove('keyboard-hidden');
}

function hideVirtualKeyboard() {
    if (keyboard) keyboard.classList.add('keyboard-hidden');
    targetInput = null;
}

if (document.getElementById('kb-space')) document.getElementById('kb-space').onclick = () => { if (targetInput) { targetInput.value += ' '; targetInput.dispatchEvent(new Event('input')); } };
if (document.getElementById('kb-backspace')) document.getElementById('kb-backspace').onclick = () => { if (targetInput) { targetInput.value = targetInput.value.slice(0, -1); targetInput.dispatchEvent(new Event('input')); } };
if (document.getElementById('kb-clear')) document.getElementById('kb-clear').onclick = () => { if (targetInput) { targetInput.value = ''; targetInput.dispatchEvent(new Event('input')); } };
if (document.getElementById('kb-search')) document.getElementById('kb-search').onclick = () => { if (targetInput) { handleGlobalSearch(targetInput.value); } };
if (document.getElementById('kb-close')) document.getElementById('kb-close').onclick = hideVirtualKeyboard;

initKeyboard();


function boot() {
    try {
        if (typeof $ === 'undefined') {
            setTimeout(boot, 100);
            return;
        }
        startApp();
    } catch (err) {
        alert("BOOT Hatası: " + err.message);
    }
}


const searchInput = document.getElementById('global-search-input');
const searchPanelClose = document.getElementById('search-panel-close');


document.addEventListener('keydown', (e) => {
    if (e.target && e.target.id === 'global-search-input') {
        const errorEl = document.getElementById('search-error');
        if (errorEl) errorEl.classList.remove('is-visible');

        if (e.key === 'Enter') {
            console.log("[DELEGATED] Enter trapped on search input. Triggering search...");
            handleGlobalSearch(e.target.value);
            hideVirtualKeyboard(); 
        }
    }
});


const isTouchDevice = () => {
    return (('ontouchstart' in window) ||
        (navigator.maxTouchPoints > 0) ||
        (navigator.msMaxTouchPoints > 0));
};


if (isTouchDevice()) {
    document.body.classList.add('is-touch');
}
window.addEventListener('touchstart', function onFirstTouch() {
    document.body.classList.add('is-touch');
    window.removeEventListener('touchstart', onFirstTouch);
}, { passive: true });


let touchStartX = 0;
let touchStartY = 0;
let lastPinchDist = 0;

const getDist = (touches) => {
    return Math.sqrt(
        Math.pow(touches[0].screenX - touches[1].screenX, 2) +
        Math.pow(touches[0].screenY - touches[1].screenY, 2)
    );
};

document.addEventListener('touchstart', (e) => {
    if (!isTouchDevice()) return;
    if (e.touches.length === 2) {
        lastPinchDist = getDist(e.touches);
        return;
    }
    if (zoomLevel > 1) return;
    const flipbook = document.getElementById('flipbook');
    if (flipbook && flipbook.contains(e.target)) {
        touchStartX = e.changedTouches[0].screenX;
        touchStartY = e.changedTouches[0].screenY;
    }
}, { passive: false });

document.addEventListener('touchmove', (e) => {
    if (!isTouchDevice()) return;
    if (e.touches.length === 2) {
        const dist = getDist(e.touches);
        if (lastPinchDist > 0) {
            const delta = dist - lastPinchDist;
            const sensitivity = 0.005;
            const oldZoom = zoomLevel;
            zoomLevel = Math.min(Math.max(1, zoomLevel + delta * sensitivity), 2);
            if (zoomLevel !== oldZoom) {
                if (zoomLevel === 1) resetZoom();
                else applyZoom();
            }
        }
        lastPinchDist = dist;
        e.preventDefault();
    }
}, { passive: false });

document.addEventListener('touchend', (e) => {
    if (!isTouchDevice()) return;
    lastPinchDist = 0;
    if (e.touches.length > 0 || zoomLevel > 1) return;
    const flipbook = document.getElementById('flipbook');
    if (flipbook && flipbook.contains(e.target)) {
        const touchEndX = e.changedTouches[0].screenX;
        const touchEndY = e.changedTouches[0].screenY;
        const deltaX = touchEndX - touchStartX;
        const deltaY = Math.abs(touchEndY - touchStartY);
        if (deltaY > Math.abs(deltaX)) return;
        if (Math.abs(deltaX) > 60) {
            if (deltaX < 0) {
                if ($('#flipbook').data('turn')) $('#flipbook').turn('next');
            } else {
                if ($('#flipbook').data('turn')) $('#flipbook').turn('previous');
            }
        }
    }
}, { passive: true });

if (searchInput) {
    
    searchInput.addEventListener('focus', () => { if (isTouchDevice()) showVirtualKeyboard(searchInput); });
    searchInput.addEventListener('click', () => { if (isTouchDevice()) showVirtualKeyboard(searchInput); });
}
const psInput = document.getElementById('page-selector-input');
if (psInput) {
    psInput.addEventListener('focus', () => { if (isTouchDevice()) showVirtualKeyboard(psInput); });
    psInput.addEventListener('click', () => { if (isTouchDevice()) showVirtualKeyboard(psInput); });
}

document.addEventListener('click', (e) => {
    
    if (e.target && e.target.closest('#search-box')) {
        const input = document.getElementById('global-search-input');
        if (input) input.focus();
    }

    
    if (keyboard && !keyboard.classList.contains('keyboard-hidden')) {
        const isInput = e.target.id === 'global-search-input' || e.target.id === 'page-selector-input';
        const isKeyboard = e.target.closest('#virtual-keyboard');
        if (!isInput && !isKeyboard) {
            hideVirtualKeyboard();
        }
    }

    
    if (e.target && e.target.id === 'search-panel-close') {
        const panel = document.getElementById('search-panel');
        if (panel) panel.classList.add('modal-hidden');
        const input = document.getElementById('global-search-input');
        if (input) input.value = '';
    }

    
    if (e.target && e.target.closest('#zoom-in')) {
        zoomLevel = Math.min(2, zoomLevel * 1.2);
        applyZoom();
    }
    if (e.target && e.target.closest('#zoom-out')) {
        zoomLevel = Math.max(1, zoomLevel / 1.2);
        applyZoom();
    }
});


boot();
