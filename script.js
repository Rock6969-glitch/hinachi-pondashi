let audioCtx = null;
let masterGain = null;
let analyser = null;
let activeSources = [];

// 4×4（16マス）固定配列
const TOTAL_SLOTS = 16;
let slots = new Array(TOTAL_SLOTS).fill(null);
let editingSlotIndex = null;
let draggedSlotIndex = null;

// 4×4のPCキーボード配列に完全対応したショートカットキー
const KEY_MAP = [
  "1", "2", "3", "4",
  "Q", "W", "E", "R",
  "A", "S", "D", "F",
  "Z", "X", "C", "V"
];

// IndexedDB（音源データと16マス配置をPC再起動後も保持）
const DB_NAME = "HinachiPonDB_v2";
const STORE_NAME = "slotsStore";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = (e) => {
      e.target.result.createObjectStore(STORE_NAME, { keyPath: "slotIndex" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// 16マス全体の自動保存
async function saveState() {
  const statusEl = document.getElementById("save-status");
  statusEl.textContent = "⏳ 保存中...";

  const db = await openDB();
  const tx = db.transaction(STORE_NAME, "readwrite");
  const store = tx.objectStore(STORE_NAME);
  store.clear();

  slots.forEach((item, idx) => {
    if (item) {
      const { audioBuffer, ...storable } = item;
      store.put({ slotIndex: idx, data: storable });
    }
  });

  localStorage.setItem(
    "hinachi_settings",
    JSON.stringify({
      volume: document.getElementById("master-volume").value,
      fade: document.getElementById("fade-duration").value,
      overlap: document.getElementById("overlap-toggle").checked
    })
  );

  tx.oncomplete = () => {
    statusEl.textContent = "💾 自動保存済み";
  };
}

// 保存データの復元
async function loadState() {
  const savedSettings = localStorage.getItem("hinachi_settings");
  if (savedSettings) {
    const s = JSON.parse(savedSettings);
    document.getElementById("master-volume").value = s.volume ?? 80;
    document.getElementById("volume-val").textContent = s.volume ?? 80;
    document.getElementById("fade-duration").value = s.fade ?? 1.5;
    document.getElementById("fade-val").textContent = parseFloat(s.fade ?? 1.5).toFixed(1);
    document.getElementById("overlap-toggle").checked = s.overlap ?? true;
  }

  const db = await openDB();
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const req = store.getAll();
    req.onsuccess = () => {
      const records = req.result || [];
      const restored = new Array(TOTAL_SLOTS).fill(null);
      records.forEach((rec) => {
        if (rec.slotIndex >= 0 && rec.slotIndex < TOTAL_SLOTS) {
          restored[rec.slotIndex] = rec.data;
        }
      });
      slots = restored;
      resolve(records.length > 0);
    };
  });
}

async function fetchOfficialConfig() {
  const res = await fetch("pads.json?t=" + Date.now());
  return await res.json();
}

async function initApp() {
  try {
    const official = await fetchOfficialConfig();
    document.getElementById("app-version").textContent = "v" + official.version;
    document.getElementById("app-title").textContent = official.title;
  } catch (_) {}

  await loadState();
  renderGrid();
}

// AudioContext 初期化
function initAudio() {
  if (!audioCtx) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AudioContextClass();
    masterGain = audioCtx.createGain();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;

    const vol = document.getElementById("master-volume").value / 100;
    masterGain.gain.setValueAtTime(vol, audioCtx.currentTime);
    masterGain.connect(analyser);
    analyser.connect(audioCtx.destination);
    startMeterLoop();
  }
  if (audioCtx.state === "suspended") {
    audioCtx.resume();
  }
}

function startMeterLoop() {
  const dataArray = new Uint8Array(analyser.frequencyBinCount);
  const levelBar = document.getElementById("level-bar");
  function update() {
    analyser.getByteTimeDomainData(dataArray);
    let maxVal = 0;
    for (let i = 0; i < dataArray.length; i++) {
      const v = Math.abs(dataArray[i] - 128) / 128;
      if (v > maxVal) maxVal = v;
    }
    levelBar.style.width = Math.min(100, Math.round(maxVal * 180)) + "%";
    requestAnimationFrame(update);
  }
  update();
}

function hexToRgba(hex, alpha) {
  const clean = (hex || "#ff5ca8").replace("#", "");
  const r = parseInt(clean.substring(0, 2), 16) || 255;
  const g = parseInt(clean.substring(2, 4), 16) || 92;
  const b = parseInt(clean.substring(4, 6), 16) || 168;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// スロット再生
async function triggerSlot(index) {
  const pad = slots[index];
  if (!pad) return;

  initAudio();
  if (!document.getElementById("overlap-toggle").checked) {
    stopAllSounds();
  }

  const padEl = document.querySelector(`[data-slot-index="${index}"]`);
  const color = pad.color || "#ff5ca8";
  if (padEl) {
    padEl.classList.add("playing");
    padEl.style.backgroundColor = hexToRgba(color, 0.28);
    padEl.style.boxShadow = `0 0 18px ${hexToRgba(color, 0.65)}`;
  }

  const padGain = audioCtx.createGain();
  padGain.gain.setValueAtTime(1.0, audioCtx.currentTime);
  padGain.connect(masterGain);

  const entry = { slotIndex: index, gainNode: padGain, sourceNode: null };
  activeSources.push(entry);

  const cleanup = () => {
    activeSources = activeSources.filter((s) => s !== entry);
    if (!activeSources.some((s) => s.slotIndex === index) && padEl) {
      padEl.classList.remove("playing");
      padEl.style.backgroundColor = hexToRgba(color, 0.08);
      padEl.style.boxShadow = "none";
    }
  };

  if (pad.type === "file") {
    if (!pad.audioBuffer) {
      const res = await fetch(pad.src);
      const buf = await res.arrayBuffer();
      pad.audioBuffer = await audioCtx.decodeAudioData(buf);
    }
    const source = audioCtx.createBufferSource();
    source.buffer = pad.audioBuffer;
    source.connect(padGain);
    source.start(0);
    entry.sourceNode = source;
    source.onended = cleanup;
  } else if (pad.type === "local" && pad.arrayBuffer) {
    if (!pad.audioBuffer) {
      pad.audioBuffer = await audioCtx.decodeAudioData(pad.arrayBuffer.slice(0));
    }
    const source = audioCtx.createBufferSource();
    source.buffer = pad.audioBuffer;
    source.connect(padGain);
    source.start(0);
    entry.sourceNode = source;
    source.onended = cleanup;
  }
}

function stopAllSounds() {
  if (!audioCtx) return;
  activeSources.forEach((entry) => {
    try {
      entry.gainNode.gain.cancelScheduledValues(audioCtx.currentTime);
      entry.gainNode.gain.setValueAtTime(0, audioCtx.currentTime);
      if (entry.sourceNode) entry.sourceNode.stop();
    } catch (_) {}
  });
  activeSources = [];
  renderGrid();
}

function fadeOutAllSounds() {
  if (!audioCtx || activeSources.length === 0) return;
  const duration = parseFloat(document.getElementById("fade-duration").value);
  const now = audioCtx.currentTime;
  activeSources.forEach((entry) => {
    try {
      entry.gainNode.gain.cancelScheduledValues(now);
      entry.gainNode.gain.setValueAtTime(entry.gainNode.gain.value, now);
      entry.gainNode.gain.linearRampToValueAtTime(0.0001, now + duration);
    } catch (_) {}
  });
  setTimeout(stopAllSounds, duration * 1000 + 50);
}

// 4×4 グリッド描画
function renderGrid() {
  const grid = document.getElementById("pad-grid");
  const isEdit = document.getElementById("edit-mode-toggle").checked;
  grid.innerHTML = "";

  for (let i = 0; i < TOTAL_SLOTS; i++) {
    const pad = slots[i];
    const cell = document.createElement("div");
    cell.dataset.slotIndex = i;

    const keyBadge = `<span class="pad-key">${KEY_MAP[i]}</span>`;

    if (!pad) {
      cell.className = "pad-btn empty" + (isEdit ? " editing" : "");
      cell.innerHTML = `
        ${keyBadge}
        <div class="pad-icon">＋</div>
        <div class="pad-label">空きスロット</div>
      `;
      cell.addEventListener("click", () => {
        pickFileForSlot(i);
      });
    } else {
      const color = pad.color || "#ff5ca8";
      cell.className = "pad-btn" + (isEdit ? " editing" : "");
      cell.style.borderColor = color;
      cell.style.backgroundColor = hexToRgba(color, 0.08);

      const deleteBtn = isEdit ? `<button class="pad-delete" title="スロットを空にする">✕</button>` : "";

      cell.innerHTML = `
        ${keyBadge}
        ${deleteBtn}
        <div class="pad-icon">${pad.icon}</div>
        <div class="pad-label">${pad.label}</div>
      `;

      cell.addEventListener("click", async (e) => {
        if (e.target.classList.contains("pad-delete")) {
          slots[i] = null;
          await saveState();
          renderGrid();
          return;
        }
        if (isEdit) {
          openEditModal(i);
          return;
        }
        triggerSlot(i);
      });
    }

    // ドラッグ＆ドロップ（ボタン位置入れ替え ＆ 音声ファイルの直接ドロップ）
    cell.draggable = isEdit && pad !== null;

    cell.addEventListener("dragstart", (e) => {
      if (!isEdit || !pad) return;
      draggedSlotIndex = i;
      e.dataTransfer.effectAllowed = "move";
    });

    cell.addEventListener("dragover", (e) => {
      e.preventDefault();
      cell.classList.add("drag-over");
    });

    cell.addEventListener("dragleave", () => {
      cell.classList.remove("drag-over");
    });

    cell.addEventListener("drop", async (e) => {
      e.preventDefault();
      cell.classList.remove("drag-over");

      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        await assignFilesFromIndex(e.dataTransfer.files, i);
        return;
      }

      if (draggedSlotIndex !== null && draggedSlotIndex !== i) {
        const temp = slots[i];
        slots[i] = slots[draggedSlotIndex];
        slots[draggedSlotIndex] = temp;
        draggedSlotIndex = null;
        await saveState();
        renderGrid();
      }
    });

    grid.appendChild(cell);
  }
}

function pickFileForSlot(targetIndex) {
  const tempInput = document.createElement("input");
  tempInput.type = "file";
  tempInput.accept = "audio/*";
  tempInput.onchange = async (e) => {
    if (e.target.files.length > 0) {
      await assignFilesFromIndex(e.target.files, targetIndex);
    }
  };
  tempInput.click();
}

async function assignFilesFromIndex(files, startIndex) {
  let cursor = startIndex;
  for (const file of files) {
    if (!file.type.startsWith("audio/")) continue;
    while (cursor < TOTAL_SLOTS && slots[cursor] !== null && cursor !== startIndex) {
      cursor++;
    }
    if (cursor >= TOTAL_SLOTS) break;

    const arrayBuffer = await file.arrayBuffer();
    const cleanName = file.name.replace(/\.[^/.]+$/, "");
    slots[cursor] = {
      id: "local_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6),
      label: cleanName,
      icon: "🎧",
      type: "local",
      color: "#ff5ca8",
      arrayBuffer
    };
    cursor++;
  }
  await saveState();
  renderGrid();
}

function openEditModal(index) {
  const pad = slots[index];
  if (!pad) return;
  editingSlotIndex = index;
  document.getElementById("edit-label").value = pad.label;
  document.getElementById("edit-icon").value = pad.icon;
  document.getElementById("edit-color").value = pad.color || "#ff5ca8";
  document.getElementById("edit-modal").classList.remove("hidden");
}

document.addEventListener("DOMContentLoaded", () => {
  initApp();

  document.getElementById("master-volume").addEventListener("input", (e) => {
    document.getElementById("volume-val").textContent = e.target.value;
    if (masterGain && audioCtx) {
      masterGain.gain.setValueAtTime(e.target.value / 100, audioCtx.currentTime);
    }
    saveState();
  });

  document.getElementById("fade-duration").addEventListener("input", (e) => {
    document.getElementById("fade-val").textContent = parseFloat(e.target.value).toFixed(1);
    saveState();
  });

  document.getElementById("overlap-toggle").addEventListener("change", saveState);

  document.getElementById("edit-mode-toggle").addEventListener("change", (e) => {
    document.getElementById("edit-hint").classList.toggle("hidden", !e.target.checked);
    renderGrid();
  });

  document.getElementById("stop-all-btn").addEventListener("click", stopAllSounds);
  document.getElementById("fade-all-btn").addEventListener("click", fadeOutAllSounds);

  // 全スロットを空にする
  document.getElementById("clear-all-btn").addEventListener("click", async () => {
    if (!confirm("16マスすべての音源と設定を消去して空にしますか？")) return;
    stopAllSounds();
    slots = new Array(TOTAL_SLOTS).fill(null);
    await saveState();
    renderGrid();
  });

  // 設定JSON書き出し
  document.getElementById("export-json-btn").addEventListener("click", () => {
    const cleanSlots = slots.map((item) => {
      if (!item) return null;
      const { audioBuffer, arrayBuffer, ...rest } = item;
      return rest;
    });
    const jsonStr = JSON.stringify(
      { version: "2.1.0", title: "🎀 ひなち専用ポン出しサンプラー", slots: cleanSlots },
      null,
      2
    );
    const blob = new Blob([jsonStr], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "pads.json";
    a.click();
  });

  document.querySelectorAll(".color-dot").forEach((dot) => {
    dot.addEventListener("click", () => {
      document.getElementById("edit-color").value = dot.dataset.color;
    });
  });

  document.getElementById("modal-cancel").addEventListener("click", () => {
    document.getElementById("edit-modal").classList.add("hidden");
  });
  document.getElementById("modal-save").addEventListener("click", async () => {
    const target = slots[editingSlotIndex];
    if (target) {
      target.label = document.getElementById("edit-label").value || target.label;
      target.icon = document.getElementById("edit-icon").value || target.icon;
      target.color = document.getElementById("edit-color").value;
      await saveState();
      renderGrid();
    }
    document.getElementById("edit-modal").classList.add("hidden");
  });

  const dropZone = document.getElementById("drop-zone");
  const fileInput = document.getElementById("file-input");
  dropZone.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async (e) => {
    const firstEmpty = slots.findIndex((s) => s === null);
    if (firstEmpty !== -1) await assignFilesFromIndex(e.target.files, firstEmpty);
  });
  dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropZone.classList.add("dragover");
  });
  dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
  dropZone.addEventListener("drop", async (e) => {
    e.preventDefault();
    dropZone.classList.remove("dragover");
    const firstEmpty = slots.findIndex((s) => s === null);
    if (firstEmpty !== -1) await assignFilesFromIndex(e.dataTransfer.files, firstEmpty);
  });

  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT") return;
    if (e.key === "Escape") {
      e.preventDefault();
      stopAllSounds();
      return;
    }
    if (e.code === "Space") {
      e.preventDefault();
      fadeOutAllSounds();
      return;
    }
    const idx = KEY_MAP.indexOf(e.key.toUpperCase());
    if (idx !== -1 && slots[idx]) {
      triggerSlot(idx);
    }
  });
});