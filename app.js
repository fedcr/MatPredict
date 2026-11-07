"use strict";

// --- SERVER CONFIGURATION ---
const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycby-XX7vNVOo9pcHL6cWRCBreekhdw5L2d_8w8cOSwqptORVsVFJjcp26i1GQsoUQaQmiA/exec";
const CACHE_KEY = "matpredict.db.v2";
const AI_TIMEOUT_MS = 15000;
const FETCH_TIMEOUT_MS = 10000;

// ---------------------------------------------------------------------------
// Static knowledge
// ---------------------------------------------------------------------------
const POLYMERS = {
    PLA:  { res: 6, flex: 2,  nozzle: 205, bed: 60,  note: "full part cooling" },
    PETG: { res: 7, flex: 4,  nozzle: 240, bed: 75,  note: "low part cooling" },
    ABS:  { res: 7, flex: 3,  nozzle: 245, bed: 100, note: "enclosure, no cooling" },
    ASA:  { res: 7, flex: 3,  nozzle: 250, bed: 100, note: "enclosure, no cooling, UV stable" },
    TPU:  { res: 4, flex: 10, nozzle: 225, bed: 50,  note: "slow speed, direct drive" }
};

// Absorbance per wt% of each masterbatch in a natural (translucent) base.
// Derived from a nominal full-strength colour at 4 wt%; see solveMasterbatch().
const MB_ABSORBANCE = {
    yellow: [0.0, 0.031, 0.73],
    blue:   [0.56, 0.28, 0.022],
    red:    [0.023, 0.56, 0.56]
};
const NATURAL_BASE = [0.93, 0.92, 0.88];
const MAX_MB_TOTAL = 8;

const LOADINGS = {
    wood:    { label: "Wood powder",                       pct: 20, abrasive: false },
    coffee:  { label: "Spent coffee grounds",              pct: 5,  abrasive: false },
    carbon:  { label: "Carbon fiber",                      pct: 12, abrasive: true },
    glass:   { label: "Glass fiber",                       pct: 15, abrasive: true },
    mineral: { label: "Mineral powder (CaCO3 / marble)",   pct: 20, abrasive: true }
};

const COLOR_WORDS = {
    black: "#1a1a1a", nero: "#1a1a1a", white: "#f2f2f2", bianco: "#f2f2f2",
    red: "#c0392b", rosso: "#c0392b", blue: "#1f4fd8", blu: "#1f4fd8", azzurro: "#3a8fd9",
    green: "#2e8b57", verde: "#2e8b57", yellow: "#e8b800", giallo: "#e8b800",
    orange: "#e67e22", arancio: "#e67e22", purple: "#7b3fa0", viola: "#7b3fa0",
    grey: "#808080", gray: "#808080", grigio: "#808080", brown: "#6b4423", marrone: "#6b4423",
    pink: "#e58fb0", rosa: "#e58fb0", chestnut: "#8b5a2b", castagn: "#8b5a2b"
};

// Published measurements used as a starting point. Colour is unknown for them
// (empty), so the matcher ignores colour for these records.
// Sources are listed in data/SOURCES.md.
const REFERENCE_DB = [
    lit("Lit: neat PLA printed (49.99 MPa), Forests 2023", "", "No Odor", 49.99, 100, "PLA", 0, "none"),
    lit("Lit: PLA + 3% coffee grounds (51.28 MPa), Forests 2023", "Matte/Rough", "No Odor", 51.28, 97, "PLA", 3, "Spent coffee grounds"),
    lit("Lit: PLA + 7% coffee grounds (26.45 MPa), Forests 2023", "Matte/Rough", "No Odor", 26.45, 93, "PLA", 7, "Spent coffee grounds"),
    lit("Lit: PLA + 20% wood powder (36.7 MPa), vendor datasheet", "Wood/Fibrous", "No Odor", 36.7, 80, "PLA", 20, "Wood powder"),
    lit("Lit: PETG + 15% carbon fiber (48.7 MPa XY), vendor datasheet", "Matte/Rough", "No Odor", 48.7, 85, "PETG", 15, "Carbon fiber"),
    lit("Lit: PETG + 30% carbon fiber (60 MPa), E3S 2024", "Matte/Rough", "No Odor", 60, 70, "PETG", 30, "Carbon fiber"),
    lit("Lit: recycled PETG 70% + PLA 30% (7.47 MPa), Sinergi", "", "No Odor", 7.47, 30, "PLA", 0, "none", 70)
];

function lit(name, texture, odor, mpa, virgin, type, loading, loadingType, waste) {
    return {
        name, colorHex: "", hasTexture: !!texture, descTexture: texture || "No Texture",
        imgTexture: "none", hasOdor: odor !== "No Odor", descOdor: odor,
        resRaw: mpa, resUnit: "MPa", flexRaw: 0, flexUnit: "deg",
        wastePct: waste || 0, yellowPct: 0, bluePct: 0, redPct: 0,
        virginPct: virgin, virginType: type, loadingPct: loading, loadingType
    };
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let cloudDB = [];      // raw rows as stored in the shared sheet
let knowledge = [];    // normalised records used by the predictor
let lastResult = null;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

window.addEventListener("DOMContentLoaded", () => {
    bindUI();
    initApp();
});

function bindUI() {
    document.querySelectorAll("[data-mode]").forEach((btn) => btn.addEventListener("click", () => setMode(btn.dataset.mode)));
    $("btn-generate-a").addEventListener("click", () => generateRecipe("A"));
    $("btn-generate-b").addEventListener("click", () => generateRecipe("B"));
    $("btn-save-db").addEventListener("click", processAndSaveToDB);
    $("btn-export").addEventListener("click", exportCSV);
    $("btn-add-loading").addEventListener("click", addLoadingRow);
    $("calc-res").addEventListener("input", (e) => { $("lbl-res").textContent = e.target.value; });
    $("calc-flex").addEventListener("input", (e) => { $("lbl-flex").textContent = e.target.value; });
    [["calc-texture", "calc-texture-desc-container"], ["calc-odor", "calc-odor-desc-container"],
     ["add-texture", "texture-fields"], ["add-odor", "odor-fields"], ["mix-has-loading", "loading-fields"]]
        .forEach(([sel, box]) => $(sel).addEventListener("change", () => toggleField(sel, box)));
    $("add-img-texture").addEventListener("change", previewImage);
    $("notice-close").addEventListener("click", closeNotice);
    try { if (sessionStorage.getItem("notice_seen")) $("notice").hidden = true; } catch (e) { /* storage blocked */ }
}

function setMode(mode) {
    document.querySelectorAll("[data-mode]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.mode === mode)));
    $("panel-describe").hidden = mode !== "describe";
    $("panel-configure").hidden = mode !== "configure";
}

function closeNotice() {
    $("notice").hidden = true;
    try { sessionStorage.setItem("notice_seen", "1"); } catch (e) { /* storage blocked */ }
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------
async function callServer(payload, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const response = await fetch(APPS_SCRIPT_URL, {
            method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" },
            redirect: "follow", body: JSON.stringify(payload), signal: ctrl.signal
        });
        return await response.json();
    } finally { clearTimeout(timer); }
}

async function initApp() {
    rebuildKnowledge();   // reference data is available even if the network is not
    try {
        const cached = localStorage.getItem(CACHE_KEY);
        if (cached) { cloudDB = JSON.parse(cached); rebuildKnowledge(); }
    } catch (e) { /* no cache */ }

    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const result = await callServer({ action: "getDatabase" }, FETCH_TIMEOUT_MS);
            if (result.success && Array.isArray(result.db)) {
                cloudDB = result.db;
                try { localStorage.setItem(CACHE_KEY, JSON.stringify(cloudDB)); } catch (e) { /* quota */ }
                rebuildKnowledge();
                break;
            }
        } catch (e) { console.error("Cloud DB error:", e); }
    }
    loadAds();
}

async function loadAds() {
    try {
        const result = await callServer({ action: "getAds" }, FETCH_TIMEOUT_MS);
        if (!(result.success && Array.isArray(result.ads) && result.ads.length)) return;
        const container = $("ads-container");
        container.replaceChildren();
        result.ads.forEach((ad) => {
            if (!/^https?:\/\//i.test(String(ad.link))) return;
            const card = document.createElement("div");
            card.className = "ad-card";
            const img = document.createElement("img");
            img.alt = String(ad.name || "");
            img.loading = "lazy";
            if (/^https?:\/\//i.test(String(ad.image))) img.src = ad.image;
            const title = document.createElement("p"); title.className = "ad-title"; title.textContent = ad.name || "";
            const cat = document.createElement("p"); cat.className = "ad-category"; cat.textContent = ad.category || "";
            const a = document.createElement("a");
            a.href = ad.link; a.target = "_blank"; a.rel = "noopener noreferrer sponsored";
            a.className = "btn btn-quiet btn-small"; a.textContent = "View product";
            card.append(img, title, cat, a);
            container.appendChild(card);
        });
    } catch (e) { console.error("Error loading ads:", e); }
}

// ---------------------------------------------------------------------------
// Knowledge base normalisation
// ---------------------------------------------------------------------------
// The shared sheet has its percentage columns formatted as dates, so Apps Script returns
// numbers as ISO timestamps (serial day 0 = 1899-12-30 00:00 in the sheet's UTC+1 zone).
// Decode them back; fractions survive as time of day.
const SHEET_EPOCH_MS = Date.UTC(1899, 11, 29, 23);
const num = (v) => {
    if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) {
        const days = (Date.parse(v) - SHEET_EPOCH_MS) / 86400000;
        return Number.isFinite(days) ? Math.round(days * 100) / 100 : 0;
    }
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
};
const bool = (v) => v === true || String(v).toLowerCase() === "true";

// Tensile pull -> 1..10 score. Force units are converted with a 1.75 mm filament
// cross-section (2.405 mm2); this is an assumption, not a measurement standard.
function resScore(value, unit) {
    if (value <= 0) return null;
    let mpa = value;
    if (unit === "N") mpa = value / 2.405;
    else if (unit === "kg") mpa = (value * 9.81) / 2.405;
    return clamp(1 + (mpa / 80) * 9, 1, 10);
}
// Bend angle (0-180 deg) or deflection (0-50 mm) -> 1..10 score.
function flexScore(value, unit) {
    if (value <= 0) return null;
    return clamp(1 + (value / (unit === "mm" ? 50 : 180)) * 9, 1, 10);
}

function normalizeRecord(r) {
    const pct = { waste: num(r.wastePct), yellow: num(r.yellowPct), blue: num(r.bluePct), red: num(r.redPct), virgin: num(r.virginPct), loading: num(r.loadingPct) };
    const sum = Object.values(pct).reduce((a, b) => a + b, 0);
    if (sum < 90 || sum > 110) return null;           // reject malformed rows
    Object.keys(pct).forEach((k) => { pct[k] = (pct[k] / sum) * 100; });
    const base = String(r.virginType || "PLA").toUpperCase();
    if (!POLYMERS[base]) return null;
    return {
        name: String(r.name || ""),
        color: /^#[0-9a-f]{6}$/i.test(String(r.colorHex)) ? String(r.colorHex).toLowerCase() : null,
        texture: bool(r.hasTexture) ? String(r.descTexture || "") : "",
        odor: bool(r.hasOdor) && !/^no /i.test(String(r.descOdor)) ? String(r.descOdor || "") : "",
        res: resScore(num(r.resRaw), r.resUnit),
        flex: flexScore(num(r.flexRaw), r.flexUnit),
        pct, base, loadingType: String(r.loadingType || "none")
    };
}

function allRawRows() {
    const names = new Set(cloudDB.map((r) => String(r.name)));
    return cloudDB.concat(REFERENCE_DB.filter((r) => !names.has(r.name)));
}

function rebuildKnowledge() {
    knowledge = allRawRows().map(normalizeRecord).filter(Boolean);
    const community = cloudDB.filter((r) => !String(r.name).startsWith("Lit:")).length;
    const studies = knowledge.filter((r) => r.name.startsWith("Lit:")).length;
    $("db-status").textContent = `${knowledge.length} records in the prediction database (${community} logged by makers, ${studies} from published studies)`;
    const note = $("notice-count");
    if (note) note.textContent = String(community);
}

// ---------------------------------------------------------------------------
// Query construction
// ---------------------------------------------------------------------------
function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHex(rgb) {
    return "#" + rgb.map((c) => clamp(Math.round(c), 0, 255).toString(16).padStart(2, "0")).join("");
}

function queryFromText(text) {
    const t = text.toLowerCase();
    const q = { color: null, texture: "", odor: "", res: null, flex: null, baseHint: null, loadingKey: null };

    let bestPos = Infinity;
    Object.entries(COLOR_WORDS).forEach(([word, hex]) => {
        const i = t.indexOf(word);
        if (i >= 0 && i < bestPos) { bestPos = i; q.color = hex; }
    });

    if (/tpu|flex|soft|rubber|elastic|flessibil|gomma|bend/.test(t)) q.flex = 9;
    else if (/rigid|stiff|rigido/.test(t)) q.flex = 2;
    if (/strong|durable|resisten|tough|outdoor|load|structural|robust|esterno/.test(t)) q.res = 8;
    else if (/decor|display|prototype|cosmetic|estetic/.test(t)) q.res = 5;

    if (/tpu|rubber|gomma/.test(t)) q.baseHint = "TPU";
    else if (/\basa\b/.test(t)) q.baseHint = "ASA";
    else if (/\babs\b/.test(t)) q.baseHint = "ABS";
    else if (/petg/.test(t)) q.baseHint = "PETG";
    else if (/\bpla\b/.test(t)) q.baseHint = "PLA";
    // soft hint: only matters when no polymer was named and no flexible grade is needed
    if (/\buv\b|outdoor|sun|esterno/.test(t)) q.uv = true;

    if (/wood|legno|sawdust|chestnut|castagn/.test(t)) { q.loadingKey = "wood"; q.texture = "Wood/Fibrous"; }
    else if (/carbon|carbonio/.test(t)) q.loadingKey = "carbon";
    else if (/coffee|caff/.test(t)) { q.loadingKey = "coffee"; q.odor = "Toasted/Coffee"; }
    else if (/glass fib|fibra di vetro/.test(t)) q.loadingKey = "glass";
    else if (/stone|marble|marmo|pietra|granit/.test(t)) { q.loadingKey = "mineral"; q.texture = "Marble/Stone"; }
    return q;
}

function queryFromForm() {
    const q = {
        color: $("calc-color").value.toLowerCase(),
        texture: $("calc-texture").value === "Yes" ? $("calc-texture-desc").value : "",
        odor: $("calc-odor").value === "Yes" ? $("calc-odor-desc").value : "",
        res: num($("calc-res").value), flex: num($("calc-flex").value),
        baseHint: null, loadingKey: null
    };
    if (q.texture === "Wood/Fibrous") q.loadingKey = "wood";
    else if (q.texture === "Marble/Stone") q.loadingKey = "mineral";
    else if (q.odor === "Toasted/Coffee") q.loadingKey = "coffee";
    else if (q.odor === "Woody/Pine") q.loadingKey = "wood";
    return q;
}

// ---------------------------------------------------------------------------
// Local prediction engine: weighted k-nearest-neighbours + material priors
// ---------------------------------------------------------------------------
function loadingKeyOf(typeString) {
    const s = typeString.toLowerCase();
    if (/wood|sawdust|legno/.test(s)) return "wood";
    if (/coffee|caff/.test(s)) return "coffee";
    if (/carbon/.test(s)) return "carbon";
    if (/glass/.test(s)) return "glass";
    if (/mineral|stone|marble|chalk|caco3|talc/.test(s)) return "mineral";
    return null;
}

function distance(q, rec) {
    let sum = 0, wsum = 0;
    const add = (w, d) => { sum += w * d * d; wsum += w; };
    if (q.color && rec.color) {
        const a = hexToRgb(q.color), b = hexToRgb(rec.color);
        add(1.0, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) / 441);
    }
    add(1.2, (q.texture === rec.texture || (!q.texture && !rec.texture)) ? 0 : 1);
    add(0.6, (q.odor === rec.odor || (!q.odor && !rec.odor)) ? 0 : 1);
    if (q.res != null && rec.res != null) add(1.5, Math.abs(q.res - rec.res) / 9);
    if (q.flex != null && rec.flex != null) add(1.5, Math.abs(q.flex - rec.flex) / 9);
    if (q.baseHint) add(1.5, q.baseHint === rec.base ? 0 : 1);
    if (q.loadingKey) add(1.5, q.loadingKey === loadingKeyOf(rec.loadingType) ? 0 : 1);
    return wsum ? Math.sqrt(sum / wsum) : 1;
}

function findNeighbors(q, k = 5, maxDist = 0.55) {
    return knowledge
        .map((rec) => ({ rec, d: distance(q, rec) }))
        .filter((n) => n.d < maxDist)
        .sort((a, b) => a.d - b.d)
        .slice(0, k)
        .map((n) => ({ ...n, w: 1 / Math.pow(n.d + 0.05, 2) }));
}

function chooseBase(q, neighbors, confidence) {
    if (q.baseHint) return q.baseHint;
    const votes = {};
    const totalW = neighbors.reduce((a, n) => a + n.w, 0) || 1;
    neighbors.forEach((n) => { votes[n.rec.base] = (votes[n.rec.base] || 0) + n.w / totalW; });
    const res = q.res ?? 6, flex = q.flex ?? 3;
    let best = "PLA", bestScore = Infinity;
    Object.entries(POLYMERS).forEach(([name, p]) => {
        const cost = Math.abs(res - p.res) + 1.3 * Math.abs(flex - p.flex) - 4 * (votes[name] || 0) * confidence;
        if (cost < bestScore) { bestScore = cost; best = name; }
    });
    if (q.uv && !q.baseHint && (best === "ABS" || best === "PETG")) best = "ASA";
    return best;
}

function priorRecipe(q, base) {
    const res = q.res ?? 6;
    let waste = res >= 8 ? 0 : res >= 6 ? 10 : 20;
    if (base === "TPU") waste = Math.min(waste, 10);
    let loading = 0, key = q.loadingKey;
    if (key) loading = LOADINGS[key].pct;
    if (base === "TPU") loading = Math.min(loading, 5);
    if (key === "wood" && q.odor === "Woody/Pine") loading = Math.max(loading, 10);
    return { waste, loading, loadingKey: key };
}

// Choose masterbatch amounts so the (subtractive) mix lands on the target colour.
function mixColor(x) {
    return NATURAL_BASE.map((b, ch) => b * Math.exp(-(MB_ABSORBANCE.yellow[ch] * x[0] + MB_ABSORBANCE.blue[ch] * x[1] + MB_ABSORBANCE.red[ch] * x[2]))).map((c) => c * 255);
}
function solveMasterbatch(targetHex) {
    const target = hexToRgb(targetHex);
    const cost = (x) => {
        const c = mixColor(x);
        return Math.hypot(c[0] - target[0], c[1] - target[1], c[2] - target[2]) + 1.5 * (x[0] + x[1] + x[2]);
    };
    let best = [0, 0, 0], bestCost = cost(best);
    for (let y = 0; y <= MAX_MB_TOTAL; y += 0.5)
        for (let b = 0; b + y <= MAX_MB_TOTAL; b += 0.5)
            for (let r = 0; r + b + y <= MAX_MB_TOTAL; r += 0.5) {
                const c = cost([y, b, r]);
                if (c < bestCost) { bestCost = c; best = [y, b, r]; }
            }
    for (let step = 0.25; step >= 0.05; step /= 2) {
        let improved = true;
        while (improved) {
            improved = false;
            for (let i = 0; i < 3; i++) for (const s of [-step, step]) {
                const cand = best.slice(); cand[i] = Math.max(0, cand[i] + s);
                if (cand[0] + cand[1] + cand[2] > MAX_MB_TOTAL) continue;
                const c = cost(cand);
                if (c < bestCost - 1e-9) { bestCost = c; best = cand; improved = true; }
            }
        }
    }
    const achieved = rgbToHex(mixColor(best));
    const a = hexToRgb(achieved);
    return { yellow: best[0], blue: best[1], red: best[2], achievedHex: achieved, error: Math.hypot(a[0] - target[0], a[1] - target[1], a[2] - target[2]) / 441 };
}

function settingsFor(base, loadingKey, loadingPct) {
    const p = POLYMERS[base];
    let nozzle = p.nozzle, flow = 100;
    const notes = [p.note];
    if (loadingPct > 0 && (loadingKey === "wood" || loadingKey === "coffee")) { nozzle -= 10; flow = 105; notes.push("0.6 mm nozzle recommended"); }
    if (loadingPct > 0 && loadingKey && LOADINGS[loadingKey].abrasive) notes.push("hardened nozzle required (abrasive filler)");
    return `Nozzle ${nozzle} °C · Bed ${p.bed} °C · Flow ${flow}% · ${notes.join(", ")}`;
}

// Largest-remainder rounding so the displayed parts add up to exactly 100.0.
function roundTo100(parts) {
    const keys = Object.keys(parts);
    const scaled = keys.map((k) => parts[k] * 10);
    const total = scaled.reduce((a, b) => a + b, 0) || 1;
    const norm = scaled.map((v) => (v / total) * 1000);
    const floor = norm.map(Math.floor);
    let left = 1000 - floor.reduce((a, b) => a + b, 0);
    norm.map((v, i) => [v - floor[i], i]).sort((a, b) => b[0] - a[0]).forEach(([, i]) => { if (left > 0) { floor[i]++; left--; } });
    const out = {};
    keys.forEach((k, i) => { out[k] = floor[i] / 10; });
    return out;
}

function finalizeRecipe({ base, waste, virgin, loading, color, loadingKey }) {
    waste = clamp(waste, 0, base === "TPU" ? 20 : 40);
    loading = clamp(loading, 0, base === "TPU" ? 10 : 40);
    const mb = solveMasterbatch(color);
    const mbTotal = mb.yellow + mb.blue + mb.red;
    const rest = Math.max(0, 100 - mbTotal);
    const core = waste + virgin + loading || 1;
    const pct = roundTo100({
        waste: (waste / core) * rest, yellow: mb.yellow, blue: mb.blue, red: mb.red,
        virgin: (virgin / core) * rest, loading: (loading / core) * rest
    });
    return { pct, base, mb, loadingKey };
}

function predictLocal(q) {
    const neighbors = findNeighbors(q);
    const sumW = neighbors.reduce((a, n) => a + n.w, 0);
    const confidence = neighbors.length ? Math.min(0.85, 1 - Math.exp(-sumW / 60)) : 0;
    const base = chooseBase(q, neighbors, confidence);
    const prior = priorRecipe(q, base);

    const pool = neighbors.filter((n) => n.rec.base === base);
    const poolW = pool.reduce((a, n) => a + n.w, 0);
    let waste = prior.waste, loading = prior.loading;
    let usedKnn = false;
    if (pool.length) {
        const avg = (key) => pool.reduce((a, n) => a + n.rec.pct[key] * n.w, 0) / poolW;
        const alpha = confidence;
        waste = alpha * avg("waste") + (1 - alpha) * prior.waste;
        loading = alpha * avg("loading") + (1 - alpha) * prior.loading;
        usedKnn = true;
    }
    if (q.loadingKey && loading < 3) loading = LOADINGS[q.loadingKey].pct;

    const color = q.color || "#d8d4c8";
    const fin = finalizeRecipe({ base, waste, virgin: Math.max(0, 100 - waste - loading), loading, color, loadingKey: q.loadingKey });
    const loadLabel = q.loadingKey ? LOADINGS[q.loadingKey].label : (pool.length ? pool[0].rec.loadingType : "none");
    return {
        color, fin, confidence, usedKnn, neighbors: neighbors.map((n) => n.rec.name || "Unnamed record"),
        base, loadingLabel: fin.pct.loading > 0 ? loadLabel : "none",
        texture: q.texture || "Smooth", odor: q.odor || "Odorless",
        settings: settingsFor(base, q.loadingKey, fin.pct.loading)
    };
}

// ---------------------------------------------------------------------------
// AI refinement (validated, blended with the local model)
// ---------------------------------------------------------------------------
function parseAI(raw) {
    let data = raw;
    if (typeof data === "string") {
        try { data = JSON.parse(data.replace(/```json|```/g, "").trim()); } catch (e) { return null; }
    }
    if (!data || typeof data !== "object" || !data.recipe_pct) return null;
    const r = data.recipe_pct;
    const keys = ["waste_pct", "mb_yellow", "mb_blue", "mb_red", "virgin_pct", "loading_pct"];
    const vals = keys.map((k) => Number(r[k]));
    if (vals.some((v) => !Number.isFinite(v) || v < 0)) return null;
    const sum = vals.reduce((a, b) => a + b, 0);
    if (sum < 90 || sum > 110) return null;
    const type = String(r.virgin_type || "").toUpperCase();
    if (!POLYMERS[type]) return null;
    return {
        waste: (Number(r.waste_pct) / sum) * 100, virgin: (Number(r.virgin_pct) / sum) * 100, loading: (Number(r.loading_pct) / sum) * 100,
        base: type, color: /^#[0-9a-f]{6}$/i.test(String(data.color_hex)) ? String(data.color_hex).toLowerCase() : null,
        settings: typeof data.settings === "string" ? data.settings : "", texture: typeof data.texture === "string" ? data.texture : "",
        odor: typeof data.odor === "string" ? data.odor : "", loadingType: typeof data.loading_type === "string" ? data.loading_type : ""
    };
}

function buildPrompt(basePrompt, q, local) {
    const refs = findNeighbors(q).map((n) => {
        const r = n.rec;
        return `- ${r.name || "record"}: color ${r.color || "n/a"}, texture ${r.texture || "none"}, odor ${r.odor || "none"}, resistance ${r.res ? r.res.toFixed(1) : "n/a"}/10, flexibility ${r.flex ? r.flex.toFixed(1) : "n/a"}/10 => ${r.base}; waste ${r.pct.waste.toFixed(1)}, yellow ${r.pct.yellow.toFixed(1)}, blue ${r.pct.blue.toFixed(1)}, red ${r.pct.red.toFixed(1)}, virgin ${r.pct.virgin.toFixed(1)}, loading ${r.pct.loading.toFixed(1)} (${r.loadingType}); distance ${n.d.toFixed(2)}`;
    }).join("\n") || "- (no similar records yet)";
    const p = local.fin.pct;
    return `You are a specialized materials engineer for 3D printing and polymer extrusion.
${basePrompt}

INSTRUCTIONS:
1. Calculate the percentage mixture (waste, masterbatches, virgin polymer, loadings). The sum MUST be exactly 100.
2. EMPIRICAL DATABASE (nearest past records, most similar first). Mimic their ratios when they match the goal:
${refs}
3. A rule-based baseline is: ${local.base}; waste ${p.waste}, yellow ${p.yellow}, blue ${p.blue}, red ${p.red}, virgin ${p.virgin}, loading ${p.loading}. Only deviate from it when you can justify it physically.
4. Keep loadings at or below 40% and recycled waste at or below 40%.

Output ONLY a valid JSON object with this exact structure, without markdown formatting:
{"color_hex":"#hex", "settings":"...", "texture":"...", "odor":"...", "loading_type":"specify comma separated types or none", "recipe_pct":{"waste_pct":0, "mb_yellow":0, "mb_blue":0, "mb_red":0, "virgin_pct":0, "virgin_type":"PLA/PETG/TPU/ABS/ASA", "loading_pct":0}}`;
}

// ---------------------------------------------------------------------------
// Prediction flow + rendering
// ---------------------------------------------------------------------------
const COMPONENTS = [
    { key: "waste", label: "Recycled waste", color: "#8a8f98" },
    { key: "yellow", label: "Yellow masterbatch", color: "#e8b800" },
    { key: "blue", label: "Blue masterbatch", color: "#2f6fd6" },
    { key: "red", label: "Red masterbatch", color: "#d23b3b" },
    { key: "virgin", label: "Virgin pellet", color: "#d9d5c9" },
    { key: "loading", label: "Filler", color: "#8b5a2b" }
];

async function generateRecipe(method) {
    const targetMass = num($("target-mass").value) || 1000;
    const targetUnit = $("target-unit").value;
    const projectDesc = $("ai-prompt").value.trim();
    if (method === "A" && !projectDesc) { $("ai-prompt").focus(); return setStatus("Describe your project first."); }

    const q = method === "A" ? queryFromText(projectDesc) : queryFromForm();
    const local = predictLocal(q);
    renderResult(local, null, targetMass, targetUnit, "Calculating…", q);

    const basePrompt = method === "A"
        ? `User project description: "${projectDesc}". Recommend the best material characteristics and the ideal virgin polymer base.`
        : `User wants a filament with Color: ${q.color}, Texture: ${q.texture || "none"}, Odor: ${q.odor || "none"}, Resistance: ${q.res}/10, Flexibility: ${q.flex}/10. Choose the most appropriate polymer base (PLA, PETG, TPU, ABS, ASA).`;

    let ai = null;
    try {
        const reply = await callServer({ action: "generateRecipe", prompt: buildPrompt(basePrompt, q, local) }, AI_TIMEOUT_MS);
        if (reply.success) ai = parseAI(reply.data);
    } catch (e) { console.error("AI generation failed, local model only.", e); }

    renderResult(local, ai, targetMass, targetUnit, null, q);
}

function mergeWithAI(local, ai, q) {
    const wAI = 0.65 - 0.4 * local.confidence;
    const base = q.baseHint || (local.confidence > 0.5 ? local.base : ai.base);
    const p = local.fin.pct;
    const mix = (a, b) => wAI * a + (1 - wAI) * b;
    const waste = mix(ai.waste, p.waste), loading = mix(ai.loading, p.loading);
    const color = q.color || ai.color || local.color;
    const fin = finalizeRecipe({ base, waste, virgin: Math.max(0, 100 - waste - loading), loading, color, loadingKey: q.loadingKey });
    return {
        ...local, color, fin, base,
        settings: ai.settings && base === ai.base ? ai.settings : settingsFor(base, q.loadingKey, fin.pct.loading),
        texture: q.texture || ai.texture || local.texture, odor: q.odor || ai.odor || local.odor,
        loadingLabel: fin.pct.loading > 0 ? (ai.loadingType && ai.loadingType !== "none" ? ai.loadingType : local.loadingLabel) : "none"
    };
}

function setStatus(text) { $("res-status").textContent = text; }

function renderResult(local, ai, targetMass, targetUnit, busyText, q) {
    const res = ai ? mergeWithAI(local, ai, q) : local;
    lastResult = res;
    $("result-empty").hidden = true;
    $("result-body").hidden = false;

    const mode = busyText || (ai ? "Local model + AI refinement" : "Local model only (AI unavailable)");
    $("res-mode").textContent = mode;
    $("res-title").textContent = `${res.base} base`;
    $("res-color-target").style.background = res.color;
    $("res-color-achieved").style.background = res.fin.mb.achievedHex;
    const off = res.fin.mb.error > 0.12;
    $("res-color-note").textContent = off
        ? "Right swatch is the colour these masterbatches can actually reach. Dark or white shades need black or white masterbatch, which this recipe does not include."
        : "Left: target colour. Right: expected colour from the masterbatch mix.";

    const parts = res.fin.pct;
    const bar = $("res-bar");
    bar.replaceChildren();
    COMPONENTS.forEach((c) => {
        if (!parts[c.key]) return;
        const seg = document.createElement("span");
        seg.style.flexGrow = parts[c.key]; seg.style.background = c.color; seg.title = `${c.label} ${parts[c.key]}%`;
        bar.appendChild(seg);
    });

    const body = $("res-table-body");
    body.replaceChildren();
    COMPONENTS.forEach((c) => {
        const label = c.key === "virgin" ? `Virgin ${res.base}` : c.key === "loading" && parts.loading > 0 ? `Filler: ${res.loadingLabel}` : c.label;
        const tr = document.createElement("tr");
        const swatch = document.createElement("span"); swatch.className = "swatch"; swatch.style.background = c.color;
        const th = document.createElement("th"); th.scope = "row"; th.append(swatch, document.createTextNode(label));
        const tdPct = document.createElement("td"); tdPct.textContent = `${parts[c.key].toFixed(1)} %`;
        const tdMass = document.createElement("td"); tdMass.textContent = `${((parts[c.key] / 100) * targetMass).toFixed(1)} ${targetUnit}`;
        tr.append(th, tdPct, tdMass);
        if (!parts[c.key]) tr.className = "zero";
        body.appendChild(tr);
    });

    $("res-settings").textContent = res.settings;
    $("res-texture-pred").textContent = res.texture;
    $("res-odor-pred").textContent = res.odor;

    const conf = res.confidence;
    const level = conf >= 0.5 ? "Good" : conf >= 0.2 ? "Moderate" : "Low";
    $("res-confidence").textContent = res.neighbors.length
        ? `${level} confidence: matched ${res.neighbors.length} similar record${res.neighbors.length > 1 ? "s" : ""} (${res.neighbors.slice(0, 3).join("; ")}).`
        : "Low confidence: no similar records yet, so this uses general material rules. Log your results in the Laboratory to improve it.";
    setStatus("");
}

// ---------------------------------------------------------------------------
// Laboratory form
// ---------------------------------------------------------------------------
function toggleField(selectId, divId) { $(divId).hidden = $(selectId).value !== "Yes"; }

function previewImage(event) {
    const file = event.target.files[0];
    if (file) { $("texture-preview").src = URL.createObjectURL(file); $("texture-preview-container").hidden = false; }
}

function addLoadingRow() {
    const row = document.createElement("div");
    row.className = "loading-row";
    row.innerHTML = `
        <label class="field"><span class="sr-only">Mass</span><input type="number" class="loading-mass" min="0" value="0"></label>
        <label class="field grow"><span class="sr-only">Material type</span><input type="text" class="loading-type" placeholder="e.g. Carbon fiber"></label>
        <button type="button" class="btn btn-quiet btn-small" aria-label="Remove row">Remove</button>`;
    row.querySelector("button").addEventListener("click", () => row.remove());
    $("dynamic-loadings-container").appendChild(row);
}

async function processAndSaveToDB() {
    const btn = $("btn-save-db");
    const status = $("save-status");
    status.className = "";

    const hasOdor = $("add-odor").value === "Yes";
    const finalOdorDesc = hasOdor ? $("add-obj-odor").value : "No Odor";
    const virginType = $("mix-virgin-type").value;

    let mLoad = 0;
    const loadingTypes = [];
    if ($("mix-has-loading").value === "Yes") {
        document.querySelectorAll(".loading-row").forEach((row) => {
            const mass = num(row.querySelector(".loading-mass").value);
            const type = row.querySelector(".loading-type").value.trim();
            if (mass > 0 && type) { mLoad += mass; loadingTypes.push(type); }
        });
    }
    const mWaste = num($("mix-waste").value), mYellow = num($("mix-yellow").value), mBlue = num($("mix-blue").value),
          mRed = num($("mix-red").value), mVirgin = num($("mix-virgin").value);
    const totalMass = mWaste + mYellow + mBlue + mRed + mVirgin + mLoad;
    if (totalMass <= 0) { status.textContent = "Total mass cannot be zero."; status.className = "error"; return; }
    const getPct = (v) => ((v / totalMass) * 100).toFixed(2);

    const imgInput = $("add-img-texture");
    const hasTexture = $("add-texture").value === "Yes";
    const newItem = {
        name: `Filament ${cloudDB.length + 1}`, colorHex: $("add-color").value,
        hasTexture, descTexture: hasTexture ? $("add-desc-texture").value : "No Texture",
        imgTexture: imgInput && imgInput.files && imgInput.files.length ? imgInput.files[0].name : "none",
        hasOdor, descOdor: finalOdorDesc,
        resRaw: num($("add-res").value), resUnit: $("add-res-unit").value,
        flexRaw: num($("add-flex").value), flexUnit: $("add-flex-unit").value,
        wastePct: getPct(mWaste), yellowPct: getPct(mYellow), bluePct: getPct(mBlue), redPct: getPct(mRed),
        virginPct: getPct(mVirgin), virginType, loadingPct: getPct(mLoad),
        loadingType: loadingTypes.length ? loadingTypes.join(" + ") : "none"
    };

    btn.disabled = true; btn.textContent = "Saving…";
    try {
        const result = await callServer({ action: "addFilament", filament: newItem }, FETCH_TIMEOUT_MS);
        if (!result.success) throw new Error("Server rejected save.");
        cloudDB.push(newItem);
        try { localStorage.setItem(CACHE_KEY, JSON.stringify(cloudDB)); } catch (e) { /* quota */ }
        rebuildKnowledge();
        status.textContent = "Saved to the shared database.";
        setTimeout(() => { status.textContent = ""; }, 6000);
    } catch (e) {
        status.textContent = "Connection error. The record was not saved.";
        status.className = "error";
    } finally {
        btn.disabled = false; btn.textContent = "Compute percentages and save";
    }
}

function csvCell(v) {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportCSV() {
    const cols = ["name", "colorHex", "hasTexture", "descTexture", "imgTexture", "hasOdor", "descOdor", "resRaw", "resUnit", "flexRaw", "flexUnit", "wastePct", "yellowPct", "bluePct", "redPct", "virginPct", "virginType", "loadingPct", "loadingType"];
    const header = "Name,ColorHEX,HasTexture,TextureDesc,TextureImg,HasOdor,OdorDesc,ResRaw,ResUnit,FlexRaw,FlexUnit,WastePct,YellowMBPct,BlueMBPct,RedMBPct,VirginPct,VirginType,LoadingPct,LoadingType";
    const lines = allRawRows().map((r) => cols.map((c) => csvCell(r[c])).join(","));
    const blob = new Blob([header + "\n" + lines.join("\n") + "\n"], { type: "text/csv;charset=utf-8;" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob); link.download = "matpredict_database.csv";
    document.body.appendChild(link); link.click(); document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}
