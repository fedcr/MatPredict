// --- CONFIGURAZIONE SERVER ---
// Sostituisci questo link con il NUOVO URL del tuo Google Apps Script (dopo aver fatto il Nuovo Deployment)
const APPS_SCRIPT_URL = "https://script.google.com/macros/s/INSERISCI_QUI_IL_TUO_URL/exec"; 

let filamentDB = [];

window.onload = function() {
    if(!sessionStorage.getItem('welcome_seen')) {
        document.getElementById('welcome-popup').style.display = 'flex';
    } else {
        document.getElementById('welcome-popup').style.display = 'none';
    }
    initApp();
};

function closePopup() {
    sessionStorage.setItem('welcome_seen', 'true');
    document.getElementById('welcome-popup').style.opacity = '0';
    setTimeout(() => { document.getElementById('welcome-popup').style.display = 'none'; }, 400);
}

// --- INIZIALIZZAZIONE DELL'APP ---
async function initApp() {
    try {
        const response = await fetch(APPS_SCRIPT_URL, {
            method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, redirect: 'follow',
            body: JSON.stringify({ action: "getDatabase" })
        });
        const result = await response.json();
        if(result.success && result.db) { filamentDB = result.db; }
    } catch (e) { console.error("Cloud DB Error:", e); }

    loadAds();
}

async function loadAds() {
    try {
        const response = await fetch(APPS_SCRIPT_URL, {
            method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, redirect: 'follow',
            body: JSON.stringify({ action: "getAds" })
        });
        const result = await response.json();
        
        if(result.success && result.ads && result.ads.length > 0) {
            const container = document.getElementById('ads-container');
            container.innerHTML = result.ads.map(ad => `
                <div class="ad-card">
                    <img src="${ad.image}" alt="${ad.name}" onerror="this.src='https://via.placeholder.com/150?text=Gear'">
                    <p class="ad-title">${ad.name}</p>
                    <p class="ad-category">${ad.category}</p>
                    <a href="${ad.link}" target="_blank" class="btn btn-outline btn-xs" style="width:100%">Check it out</a>
                </div>
            `).join('');
        }
    } catch(e) { console.error("Error loading ads:", e); }
}

function toggleField(selectId, divId) { document.getElementById(divId).style.display = document.getElementById(selectId).value === 'Yes' ? 'block' : 'none'; }
function previewImage(event) {
    const file = event.target.files[0];
    if(file) { document.getElementById('texture-preview').src = URL.createObjectURL(file); document.getElementById('texture-preview-container').style.display = 'block'; }
}

function addLoadingRow() {
    const container = document.getElementById('dynamic-loadings-container');
    const row = document.createElement('div');
    row.className = 'loading-row';
    row.innerHTML = `
        <div class="form-group" style="margin-bottom:0; flex: 1;"><input type="number" class="loading-mass" value="0"></div>
        <div class="form-group" style="margin-bottom:0; flex: 2;"><input type="text" class="loading-type" placeholder="e.g. Carbon fiber"></div>
        <button class="btn-add btn-outline btn-icon" style="color:var(--text-dim); border-color:var(--text-muted);" onclick="this.parentElement.remove()">-</button>
    `;
    container.appendChild(row);
}

function generateOfflineFallback(manualData, isMethodA) {
    let r = { waste_pct: 10, mb_yellow: 0, mb_blue: 0, mb_red: 0, virgin_pct: 90, virgin_type: "PLA", loading_pct: 0 };
    let color = manualData.color; 
    let texture = manualData.texture === 'Yes' ? manualData.textureDesc : "Smooth"; 
    let odor = manualData.odor === 'Yes' ? manualData.odorDesc : "Odorless";
    let settings = "Nozzle: 205°C | Bed: 60°C | Flow: 100%";
    let loadType = "none";
    
    let query = isMethodA ? document.getElementById('ai-prompt').value.toLowerCase() : "";
    let descCheck = manualData.textureDesc.toLowerCase() + " " + manualData.odorDesc.toLowerCase();

    if(query.includes("tpu") || query.includes("flex") || manualData.flex > 7) {
        r.virgin_type = "TPU"; settings = "Nozzle: 225°C | Bed: 50°C | Flow: 105% | Speed: VERY SLOW";
    } else if (query.includes("petg") || manualData.res > 8) {
        r.virgin_type = "PETG"; settings = "Nozzle: 240°C | Bed: 75°C | Flow: 100% | Low cooling";
    }

    if(query.includes("wood") || descCheck.includes("wood") || query.includes("chestnut")) {
        r.virgin_pct = 60; r.loading_pct = 30; r.waste_pct = 10;
        color = "#8b5a2b"; texture = "Wood/Fibrous"; odor = "Toasted/Coffee"; loadType = "Wood dust";
        settings = "Nozzle: 195°C | Bed: 50°C | Flow: 110% (0.6mm nozzle recommended)";
    }
    
    if(color === "#0b57d0" || query.includes("blue")) { r.mb_blue = 2; r.virgin_pct -= 2; }
    
    return { color_hex: color, settings: settings, texture: texture, odor: odor, loading_type: loadType, recipe_pct: r };
}

// --- FUNZIONE GENERAZIONE RAG (Retrieval-Augmented Generation) ---
async function generateRecipe(method) {
    const targetMass = parseFloat(document.getElementById('target-mass').value) || 1000;
    const targetUnit = document.getElementById('target-unit').value;
    
    const projectDesc = document.getElementById('ai-prompt').value;
    const manualData = {
        color: document.getElementById('calc-color').value,
        texture: document.getElementById('calc-texture').value,
        textureDesc: document.getElementById('calc-texture-desc').value,
        odor: document.getElementById('calc-odor').value,
        odorDesc: document.getElementById('calc-odor-desc').value,
        res: document.getElementById('calc-res').value,
        flex: document.getElementById('calc-flex').value
    };

    if(method === 'A' && !projectDesc) return alert("Please describe your project in Method A.");

    document.getElementById('result-box').classList.add('active');
    document.getElementById('res-settings').innerText = "Analyzing Cloud Database & Generating AI recipe...";
    document.getElementById('res-recipe-grid').innerHTML = '';
    document.getElementById('res-loading-type').innerText = '';

    let resultJSON;
    let modeText = `AI Engine (Method ${method})`;

    let basePrompt = method === 'A' 
        ? `User project description: "${projectDesc}". Recommend the best material characteristics and the ideal virgin polymer base.` 
        : `User wants a filament with Color: ${manualData.color}, Texture: ${manualData.texture} (Type: ${manualData.textureDesc}), Odor: ${manualData.odor} (Type: ${manualData.odorDesc}), Resistance: ${manualData.res}/10, Flexibility: ${manualData.flex}/10. Choose the most appropriate polymer base (PLA, PETG, TPU, ABS, ASA).`;
        
    const finalPrompt = `You are a specialized materials engineer for 3D printing and polymer extrusion. 
    ${basePrompt}
    
    INSTRUCTIONS:
    1. Calculate the exact percentage mixture (waste, masterbatches, virgin polymer, loadings).
    2. The total sum of percentages MUST be exactly 100.
    3. You will receive an EMPIRICAL DATABASE below. You MUST use those past successful recipes as a reference. If a similar material goal exists in the database, prioritize mimicking its ratios.
    
    Output ONLY a valid JSON object with this exact structure, without markdown formatting:
    {"color_hex":"#hex", "settings":"...", "texture":"...", "odor":"...", "loading_type":"specify comma separated types or none", "recipe_pct":{"waste_pct":0, "mb_yellow":0, "mb_blue":0, "mb_red":0, "virgin_pct":0, "virgin_type":"PLA/PETG/TPU/ABS/ASA", "loading_pct":0}}`;
    
    try {
        const response = await fetch(APPS_SCRIPT_URL, {
            method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify({ action: "generateRecipe", prompt: finalPrompt })
        });
        
        const serverResult = await response.json();
        
        if (serverResult.success) {
            resultJSON = serverResult.data;
        } else {
            console.error("Server API Error:", serverResult.error);
            throw new Error("Server or Gemini error");
        }
    } catch (error) {
        console.error("AI Generation failed, using offline fallback.", error);
        modeText = `Offline Fallback (Method ${method})`;
        resultJSON = generateOfflineFallback(manualData, method === 'A');
    }

    document.getElementById('res-mode').innerText = modeText;
    document.getElementById('res-color-preview').style.backgroundColor = resultJSON.color_hex;
    document.getElementById('res-settings').innerHTML = `<strong>Print Settings:</strong><br>${resultJSON.settings}`;
    document.getElementById('res-texture-pred').innerHTML = `<strong>Texture:</strong> ${resultJSON.texture}`;
    document.getElementById('res-odor-pred').innerHTML = `<strong>Odor:</strong> ${resultJSON.odor}`;
    
    const r = resultJSON.recipe_pct;
    const calcMass = (pct) => ((pct / 100) * targetMass).toFixed(1);

    document.getElementById('res-recipe-grid').innerHTML = `
        <div class="recipe-box"><label>Waste</label><span>${calcMass(r.waste_pct)} ${targetUnit}</span></div>
        <div class="recipe-box"><label>Yellow MB</label><span>${calcMass(r.mb_yellow)} ${targetUnit}</span></div>
        <div class="recipe-box"><label>Blue MB</label><span>${calcMass(r.mb_blue)} ${targetUnit}</span></div>
        <div class="recipe-box"><label>Red MB</label><span>${calcMass(r.mb_red)} ${targetUnit}</span></div>
        <div class="recipe-box"><label>Virgin ${r.virgin_type}</label><span>${calcMass(r.virgin_pct)} ${targetUnit}</span></div>
        <div class="recipe-box"><label>Loadings</label><span>${calcMass(r.loading_pct)} ${targetUnit}</span></div>
    `;

    if(r.loading_pct > 0 && resultJSON.loading_type && resultJSON.loading_type !== "none") {
        document.getElementById('res-loading-type').innerText = `Specific Loadings Suggested: ${resultJSON.loading_type.toUpperCase()}`;
    }
}

async function processAndSaveToDB() {
    const btn = document.getElementById('btn-save-db');
    const status = document.getElementById('save-status');
    
    const hasOdor = document.getElementById('add-odor').value === 'Yes';
    const finalOdorDesc = hasOdor ? document.getElementById('add-obj-odor').value : "No Odor";
    const virginType = document.getElementById('mix-virgin-type').value;

    let mLoad = 0;
    let loadingTypesArr = [];
    if(document.getElementById('mix-has-loading').value === 'Yes') {
        const rows = document.querySelectorAll('.loading-row');
        rows.forEach(row => {
            const mass = parseFloat(row.querySelector('.loading-mass').value) || 0;
            const type = row.querySelector('.loading-type').value.trim();
            if(mass > 0 && type) { mLoad += mass; loadingTypesArr.push(type); }
        });
    }
    const loadTypeString = loadingTypesArr.length > 0 ? loadingTypesArr.join(" + ") : "none";

    const mWaste = parseFloat(document.getElementById('mix-waste').value) || 0;
    const mYellow = parseFloat(document.getElementById('mix-yellow').value) || 0;
    const mBlue = parseFloat(document.getElementById('mix-blue').value) || 0;
    const mRed = parseFloat(document.getElementById('mix-red').value) || 0;
    const mVirgin = parseFloat(document.getElementById('mix-virgin').value) || 0;

    const totalMass = mWaste + mYellow + mBlue + mRed + mVirgin + mLoad;
    if(totalMass <= 0) return alert("Total mass cannot be zero!");

    const getPct = (val) => ((val / totalMass) * 100).toFixed(2);

    let textureImgName = "none";
    const imgInput = document.getElementById('add-img-texture');
    if(imgInput && imgInput.files && imgInput.files.length > 0) textureImgName = imgInput.files[0].name;

    const newName = `Filament ${filamentDB.length + 1}`;
    const newItem = {
        name: newName, colorHex: document.getElementById('add-color').value,
        hasTexture: document.getElementById('add-texture').value === 'Yes', 
        descTexture: document.getElementById('add-texture').value === 'Yes' ? document.getElementById('add-desc-texture').value : 'No Texture',
        imgTexture: textureImgName, hasOdor: hasOdor, descOdor: finalOdorDesc,
        resRaw: parseFloat(document.getElementById('add-res').value) || 0, resUnit: document.getElementById('add-res-unit').value,
        flexRaw: parseFloat(document.getElementById('add-flex').value) || 0, flexUnit: document.getElementById('add-flex-unit').value,
        wastePct: getPct(mWaste), yellowPct: getPct(mYellow), bluePct: getPct(mBlue), 
        redPct: getPct(mRed), virginPct: getPct(mVirgin), virginType: virginType, loadingPct: getPct(mLoad), loadingType: loadTypeString
    };

    btn.innerHTML = `<span class="btn-icon">◈</span> Saving to Cloud...`;
    
    try {
        const response = await fetch(APPS_SCRIPT_URL, {
            method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, redirect: 'follow',
            body: JSON.stringify({ action: "addFilament", filament: newItem })
        });
        const result = await response.json();
        
        if(result.success) {
            filamentDB.push(newItem);
            btn.innerHTML = `<span class="btn-icon">◈</span> Compute % & Save`;
            status.innerText = `✅ Success! Saved to Cloud Database.`;
            setTimeout(() => status.innerText = "", 6000);
        } else throw new Error("Server rejected save.");
    } catch(e) {
        btn.innerHTML = `<span class="btn-icon">◈</span> Compute % & Save`;
        status.innerText = "❌ Connection Error. Could not save to Cloud."; status.style.color = "#d93025";
    }
}

function exportCSV() {
    let csvContent = "Name,ColorHEX,HasTexture,TextureDesc,TextureImg,HasOdor,OdorDesc,ResRaw,ResUnit,FlexRaw,FlexUnit,WastePct,YellowMBPct,BlueMBPct,RedMBPct,VirginPct,VirginType,LoadingPct,LoadingType\n";
    filamentDB.forEach(r => {
        csvContent += `${r.name},${r.colorHex},${r.hasTexture},${r.descTexture},${r.imgTexture},${r.hasOdor},${r.descOdor},${r.resRaw},${r.resUnit},${r.flexRaw},${r.flexUnit},${r.wastePct},${r.yellowPct},${r.bluePct},${r.redPct},${r.virginPct},${r.virginType},${r.loadingPct},${r.loadingType}\n`;
    });
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob); link.download = "matpredict_cloud_database.csv";
    document.body.appendChild(link); link.click(); document.body.removeChild(link);
}
