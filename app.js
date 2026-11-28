(() => {
  // --- Konfiguration & Maßstab ---
  const SNAP_STEP = 10; // 10 cm Rasterfang
  const GRID_MAJOR = 100; // 100 cm = 1 m
  const GRID_MINOR = 50;  // 50 cm = 0,5 m
  const STORAGE_KEY = "aufmass_planer_projects_v4";
  const AUTOSAVE_KEY = "aufmass_planer_autosave_v4";

  // Typ-Kataloge für Wände, Türen & Fenster
  const WALL_TYPES = [
    { id: "wall", label: "Massivwand / Außenwand", thickCm: 25, dash: false, isPartition: false },
    { id: "partition", label: "Trennwand (Ständer / Leichtbau)", thickCm: 12, dash: true, isPartition: true }
  ];

  const DOOR_TYPES = [
    { id: "door-in", label: "Innentür", defaultWidth: 90, kind: "single", isExterior: false },
    { id: "door-out", label: "Außentür / Haustür", defaultWidth: 100, kind: "single", isExterior: true },
    { id: "door-double", label: "Doppeltür (2-flügelig)", defaultWidth: 160, kind: "double", isExterior: false },
    { id: "door-sliding", label: "Schiebetür", defaultWidth: 100, kind: "sliding", isExterior: false },
    { id: "door-balcony", label: "Balkontür", defaultWidth: 90, kind: "balcony", isExterior: true }
  ];

  const WINDOW_TYPES = [
    { id: "win-standard", label: "Standardfenster", defaultWidth: 120, kind: "standard" },
    { id: "win-double", label: "Doppelfenster / 2-flügelig", defaultWidth: 160, kind: "double" },
    { id: "win-balcony", label: "Balkontür / Fenstertür", defaultWidth: 90, kind: "balcony" },
    { id: "win-wide", label: "Breites Fenster / Terrassenfront", defaultWidth: 220, kind: "wide" }
  ];

  const canvas = document.getElementById("planCanvas");
  const ctx = canvas.getContext("2d");
  const wrapper = document.getElementById("canvasWrapper");

  // --- App-Zustand ---
  let state = {
    id: "proj_" + Date.now(),
    name: "Baustelle / Raum 1",
    defaultWallThickness: 25,
    defaultWallType: "wall",
    defaultDoorType: "door-in",
    defaultWindowType: "win-standard",
    walls: [],     // { id, x1, y1, x2, y2, thicknessCm, wallType }
    openings: [],  // { id, type: 'door'|'window', subType, wallId, t: 0..1, widthCm, flip: 0..3 }
    notes: [],     // { id, x, y, text } in cm
    pattern: "none"
  };

  let undoStack = [];

  // Kamera / Viewport
  let view = {
    offsetX: 0,
    offsetY: 0,
    scale: 0.85
  };

  // Interaktions-Status
  let currentTool = "wall";
  let snapEnabled = true;
  let showAllDimensions = true;
  let isDrawing = false;
  let drawStart = null;
  let drawCurrent = null;
  let selectedItem = null; // { kind: 'wall'|'opening'|'note', id }
  let draggingOpening = null;
  let draggingNote = null;
  let pointerDownPos = null;
  let pointerMoved = false;

  // Modal-Modus
  let modalMode = null;

  // Pinch-Zoom & Pan
  let activePointers = new Map();
  let lastPinchDist = null;
  let lastPanCenter = null;

  // --- Initialisierung ---
  function init() {
    loadAutosaveIfExists();
    resizeCanvas();
    centerView();
    bindUI();
    updateHeaderInfo();
    render();
    updateMetrics();
  }

  function loadAutosaveIfExists() {
    try {
      const raw = localStorage.getItem(AUTOSAVE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.walls) && parsed.walls.length > 0) {
          state = Object.assign(state, parsed);
          document.getElementById("projectName").value = state.name || "Baustelle / Raum 1";
        }
      }
    } catch {}
  }

  function saveAutosave() {
    try {
      localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(state));
    } catch {}
  }

  function resizeCanvas() {
    const rect = wrapper.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    render();
  }

  function centerView() {
    const rect = wrapper.getBoundingClientRect();
    view.offsetX = rect.width / 2;
    view.offsetY = rect.height / 2;
    view.scale = 0.85;
  }

  function updateHeaderInfo() {
    document.getElementById("headerWallThick").textContent = `${state.defaultWallThickness} cm`;
  }

  window.addEventListener("resize", resizeCanvas);

  // --- Koordinaten-Transformation ---
  function screenToWorld(sx, sy) {
    return {
      x: (sx - view.offsetX) / view.scale,
      y: (sy - view.offsetY) / view.scale
    };
  }

  function snapPoint(pt) {
    const endpointSnapRadius = 22 / view.scale;
    for (const w of state.walls) {
      if (Math.hypot(pt.x - w.x1, pt.y - w.y1) < endpointSnapRadius) {
        return { x: w.x1, y: w.y1 };
      }
      if (Math.hypot(pt.x - w.x2, pt.y - w.y2) < endpointSnapRadius) {
        return { x: w.x2, y: w.y2 };
      }
    }
    if (!snapEnabled) return { x: Math.round(pt.x), y: Math.round(pt.y) };
    return {
      x: Math.round(pt.x / SNAP_STEP) * SNAP_STEP,
      y: Math.round(pt.y / SNAP_STEP) * SNAP_STEP
    };
  }

  function pushUndo() {
    undoStack.push(JSON.stringify({
      walls: state.walls,
      openings: state.openings,
      notes: state.notes,
      pattern: state.pattern,
      defaultWallThickness: state.defaultWallThickness,
      defaultWallType: state.defaultWallType,
      defaultDoorType: state.defaultDoorType,
      defaultWindowType: state.defaultWindowType
    }));
    if (undoStack.length > 35) undoStack.shift();
    saveAutosave();
  }

  function undo() {
    if (!undoStack.length) return;
    const prev = JSON.parse(undoStack.pop());
    state.walls = prev.walls;
    state.openings = prev.openings;
    state.notes = prev.notes;
    state.pattern = prev.pattern;
    state.defaultWallThickness = prev.defaultWallThickness || 25;
    state.defaultWallType = prev.defaultWallType || "wall";
    state.defaultDoorType = prev.defaultDoorType || "door-in";
    state.defaultWindowType = prev.defaultWindowType || "win-standard";
    updateHeaderInfo();
    clearSelection();
    updateMetrics();
    render();
    saveAutosave();
  }

  // --- Typ-Helfer ---
  function getWallTypeMeta(w) {
    const id = w.wallType || (getWallThickness(w) <= 15 ? "partition" : "wall");
    return WALL_TYPES.find(t => t.id === id) || WALL_TYPES[0];
  }

  function getOpeningMeta(op) {
    if (op.type === "door") {
      return DOOR_TYPES.find(t => t.id === op.subType) || DOOR_TYPES[0];
    }
    return WINDOW_TYPES.find(t => t.id === op.subType) || WINDOW_TYPES[0];
  }

  function wallLengthCm(w) {
    return Math.hypot(w.x2 - w.x1, w.y2 - w.y1);
  }

  function getWallThickness(w) {
    return w.thicknessCm || state.defaultWallThickness || 25;
  }

  function formatMeters(cm) {
    return (cm / 100).toFixed(2).replace(".", ",");
  }

  function getDoorSwingLabel(flip) {
    const labels = [
      "Links · Innen",
      "Links · Außen",
      "Rechts · Innen",
      "Rechts · Außen"
    ];
    return labels[flip % 4];
  }

  function projectPointOnSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return { t: 0, x: x1, y: y1, dist: Math.hypot(px - x1, py - y1) };
    let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const projX = x1 + t * dx;
    const projY = y1 + t * dy;
    return {
      t,
      x: projX,
      y: projY,
      dist: Math.hypot(px - projX, py - projY)
    };
  }

  // --- Automatische Raumerkennung: Alle geschlossenen Räume (auch abgetrennte!) finden ---
  function findAllClosedRooms() {
    if (state.walls.length < 3) return [];
    const key = (x, y) => `${Math.round(x)},${Math.round(y)}`;
    const adj = new Map();

    for (const w of state.walls) {
      const k1 = key(w.x1, w.y1);
      const k2 = key(w.x2, w.y2);
      if (k1 === k2) continue;
      if (!adj.has(k1)) adj.set(k1, []);
      if (!adj.has(k2)) adj.set(k2, []);
      adj.get(k1).push({ x: w.x2, y: w.y2, k: k2, id: w.id });
      adj.get(k2).push({ x: w.x1, y: w.y1, k: k1, id: w.id });
    }

    const foundPolys = [];
    const seenSignatures = new Set();

    function canonicalSignature(poly) {
      const pts = poly.map(p => `${Math.round(p.x)},${Math.round(p.y)}`);
      const fwd = [...pts].sort().join("|");
      return fwd;
    }

    for (const startWall of state.walls) {
      const startKey = key(startWall.x1, startWall.y1);
      const path = [{ x: startWall.x1, y: startWall.y1, k: startKey }];

      function dfs(currKey, prevEdgeId) {
        const neighbors = adj.get(currKey) || [];
        for (const nb of neighbors) {
          if (nb.id === prevEdgeId) continue;
          if (nb.k === startKey && path.length >= 3) {
            const candidate = [...path];
            const area = computePolygonAreaM2(candidate);
            if (area >= 0.25) {
              const sig = canonicalSignature(candidate);
              if (!seenSignatures.has(sig)) {
                seenSignatures.add(sig);
                foundPolys.push(candidate);
              }
            }
            continue;
          }
          if (!path.some(p => p.k === nb.k) && path.length < 18) {
            path.push({ x: nb.x, y: nb.y, k: nb.k });
            dfs(nb.k, nb.id);
            path.pop();
          }
        }
      }

      dfs(startKey, null);
    }

    // Falls ein großer äußerer Ring zwei kleinere abgetrennte Räume umschließt,
    // nur die kleinsten/inneren Zellen behalten, damit nicht ein "Gesamtring" doppelt zählt
    return foundPolys.map((poly, idx) => {
      const areaM2 = computePolygonAreaM2(poly);
      const perimCm = computePolygonPerimeterCm(poly);
      const cx = poly.reduce((s, p) => s + p.x, 0) / poly.length;
      const cy = poly.reduce((s, p) => s + p.y, 0) / poly.length;
      return {
        index: idx + 1,
        name: `Raum ${idx + 1}`,
        poly,
        areaM2,
        perimCm,
        cx,
        cy
      };
    });
  }

  function computePolygonPerimeterCm(poly) {
    if (!poly || poly.length < 2) return 0;
    let sum = 0;
    for (let i = 0; i < poly.length; i++) {
      const j = (i + 1) % poly.length;
      sum += Math.hypot(poly[j].x - poly[i].x, poly[j].y - poly[i].y);
    }
    return sum;
  }

  function computePolygonAreaM2(poly) {
    if (!poly || poly.length < 3) return 0;
    let sum = 0;
    for (let i = 0; i < poly.length; i++) {
      const j = (i + 1) % poly.length;
      sum += poly[i].x * poly[j].y - poly[j].x * poly[i].y;
    }
    return (Math.abs(sum) / 2) / 10000;
  }

  function isPointInPolygon(x, y, poly) {
    if (!poly || poly.length < 3) return false;
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].x, yi = poly[i].y;
      const xj = poly[j].x, yj = poly[j].y;
      const intersect = ((yi > y) !== (yj > y)) &&
        (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-9) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  function updateMetrics() {
    const rooms = findAllClosedRooms();
    document.getElementById("roomCountInfo").textContent =
      rooms.length === 1 ? "1 Raum" : `${rooms.length} Räume`;

    let totalPerimeterCm = 0;
    for (const w of state.walls) {
      totalPerimeterCm += wallLengthCm(w);
    }

    let doorDeductionCm = 0;
    for (const op of state.openings) {
      if (op.type === "door" && op.subType !== "door-balcony") {
        doorDeductionCm += op.widthCm;
      }
    }

    const skirtingCm = Math.max(0, totalPerimeterCm - doorDeductionCm);
    const totalAreaM2 = rooms.reduce((acc, r) => acc + r.areaM2, 0);

    document.getElementById("valArea").textContent = totalAreaM2.toFixed(2).replace(".", ",") + " m²";
    document.getElementById("valPerimeter").textContent = formatMeters(totalPerimeterCm) + " lfm";
    document.getElementById("valSkirting").textContent = formatMeters(skirtingCm) + " lfm";
  }

  // --- Zeichen-Engine ---
  function render() {
    const rect = wrapper.getBoundingClientRect();
    ctx.clearRect(0, 0, rect.width, rect.height);

    ctx.fillStyle = "#f8fafc";
    ctx.fillRect(0, 0, rect.width, rect.height);

    drawGrid(rect.width, rect.height);

    ctx.save();
    ctx.translate(view.offsetX, view.offsetY);
    ctx.scale(view.scale, view.scale);

    const rooms = findAllClosedRooms();
    const combinedPoly = rooms.length > 0 ? rooms[0].poly : null;

    // 1. Alle erkannten Räume (inkl. abgetrennter Räume!) mit eigenen m² & m zeichnen
    for (const room of rooms) {
      drawSingleRoom(room);
    }

    // 2. Wände & Trennwände
    for (const w of state.walls) {
      drawWallInterior(w);
    }
    for (const w of state.walls) {
      const isSel = selectedItem && selectedItem.kind === "wall" && selectedItem.id === w.id;
      drawWallOutline(w, isSel);
    }

    // Aktuelle Vorschau-Wand
    if (isDrawing && drawStart && drawCurrent) {
      drawPreviewWall(drawStart, drawCurrent);
    }

    // 3. Türen & Fenster (Innen-, Außen-, Doppel-, Schiebe-, Balkontüren & Fenstervarianten)
    for (const op of state.openings) {
      const wall = state.walls.find(w => w.id === op.wallId);
      if (!wall) continue;
      const isSel = selectedItem && selectedItem.kind === "opening" && selectedItem.id === op.id;
      drawOpeningWithReveal(op, wall, isSel);
    }

    // 4. Feine, gedrehte Architektur-Maßzahlen
    for (const w of state.walls) {
      const isSel = selectedItem && selectedItem.kind === "wall" && selectedItem.id === w.id;
      if (showAllDimensions || isSel) {
        drawFineWallDimension(w, isSel, combinedPoly);
      }
    }

    // 5. Notizen
    for (const note of state.notes) {
      const isSel = selectedItem && selectedItem.kind === "note" && selectedItem.id === note.id;
      drawNote(note, isSel);
    }

    ctx.restore();
  }

  function drawGrid(width, height) {
    const topLeft = screenToWorld(0, 0);
    const bottomRight = screenToWorld(width, height);

    const startX = Math.floor(topLeft.x / GRID_MINOR) * GRID_MINOR;
    const endX = Math.ceil(bottomRight.x / GRID_MINOR) * GRID_MINOR;
    const startY = Math.floor(topLeft.y / GRID_MINOR) * GRID_MINOR;
    const endY = Math.ceil(bottomRight.y / GRID_MINOR) * GRID_MINOR;

    ctx.lineWidth = 1;
    for (let x = startX; x <= endX; x += GRID_MINOR) {
      const sx = x * view.scale + view.offsetX;
      ctx.strokeStyle = x % GRID_MAJOR === 0 ? "#cbd5e1" : "#e2e8f0";
      ctx.beginPath();
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, height);
      ctx.stroke();
    }

    for (let y = startY; y <= endY; y += GRID_MINOR) {
      const sy = y * view.scale + view.offsetY;
      ctx.strokeStyle = y % GRID_MAJOR === 0 ? "#cbd5e1" : "#e2e8f0";
      ctx.beginPath();
      ctx.moveTo(0, sy);
      ctx.lineTo(width, sy);
      ctx.stroke();
    }
  }

  function drawSingleRoom(room) {
    const { poly, name, areaM2, perimCm, cx, cy } = room;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(poly[0].x, poly[0].y);
    for (let i = 1; i < poly.length; i++) {
      ctx.lineTo(poly[i].x, poly[i].y);
    }
    ctx.closePath();

    const palette = [
      "rgba(56, 189, 248, 0.09)",
      "rgba(249, 115, 22, 0.09)",
      "rgba(16, 185, 129, 0.09)",
      "rgba(139, 92, 246, 0.09)"
    ];
    ctx.fillStyle = state.pattern !== "none"
      ? "rgba(217, 119, 6, 0.10)"
      : palette[(room.index - 1) % palette.length];
    ctx.fill();

    if (state.pattern !== "none") {
      ctx.clip();
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of poly) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }

      ctx.strokeStyle = "rgba(180, 83, 9, 0.30)";
      ctx.lineWidth = 1.1 / view.scale;

      if (state.pattern === "plank-0") {
        for (let y = minY; y <= maxY; y += 20) {
          ctx.beginPath();
          ctx.moveTo(minX, y);
          ctx.lineTo(maxX, y);
          ctx.stroke();
        }
      } else if (state.pattern === "plank-90") {
        for (let x = minX; x <= maxX; x += 20) {
          ctx.beginPath();
          ctx.moveTo(x, minY);
          ctx.lineTo(x, maxY);
          ctx.stroke();
        }
      } else if (state.pattern === "plank-45") {
        const span = (maxX - minX) + (maxY - minY);
        for (let d = -span; d <= span; d += 25) {
          ctx.beginPath();
          ctx.moveTo(minX + d, minY);
          ctx.lineTo(minX + d - (maxY - minY), maxY);
          ctx.stroke();
        }
      } else if (state.pattern === "herringbone") {
        const size = 28;
        for (let y = minY - size * 2; y <= maxY + size * 2; y += size) {
          for (let x = minX - size * 2; x <= maxX + size * 2; x += size * 2) {
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(x + size, y - size);
            ctx.lineTo(x + size * 2, y);
            ctx.stroke();
          }
        }
      }
    }

    // Raumname + m² + lfm (Umfang) fein in jeder abgetrennten Raumzelle darstellen
    const titleSize = Math.max(10.5, 11.5 / view.scale);
    const valSize = Math.max(11.5, 13 / view.scale);
    const subSize = Math.max(9.5, 10.5 / view.scale);

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    ctx.font = `700 ${titleSize}px sans-serif`;
    drawCleanHaloText(name, cx, cy - 14 / view.scale, "#475569", 3.5 / view.scale);

    ctx.font = `800 ${valSize}px sans-serif`;
    drawCleanHaloText(`${areaM2.toFixed(2).replace(".", ",")} m²`, cx, cy, "#0f172a", 3.8 / view.scale);

    ctx.font = `600 ${subSize}px sans-serif`;
    drawCleanHaloText(`${formatMeters(perimCm)} m`, cx, cy + 14 / view.scale, "#334155", 3.5 / view.scale);

    ctx.restore();
  }

  function isEndpointConnected(x, y, excludeWallId) {
    const eps = 2;
    for (const other of state.walls) {
      if (other.id === excludeWallId) continue;
      if (Math.hypot(other.x1 - x, other.y1 - y) < eps || Math.hypot(other.x2 - x, other.y2 - y) < eps) {
        return true;
      }
    }
    return false;
  }

  function drawWallInterior(w) {
    const len = wallLengthCm(w);
    if (len < 1) return;
    const thick = getWallThickness(w);
    const meta = getWallTypeMeta(w);
    const angle = Math.atan2(w.y2 - w.y1, w.x2 - w.x1);

    ctx.save();
    ctx.translate(w.x1, w.y1);
    ctx.rotate(angle);
    ctx.fillStyle = meta.isPartition ? "#f1f5f9" : "#ffffff";
    ctx.fillRect(0, -thick / 2, len, thick);
    ctx.restore();
  }

  function drawWallOutline(w, isSelected) {
    const len = wallLengthCm(w);
    if (len < 1) return;
    const thick = getWallThickness(w);
    const halfT = thick / 2;
    const meta = getWallTypeMeta(w);
    const angle = Math.atan2(w.y2 - w.y1, w.x2 - w.x1);
    const lineW = isSelected ? Math.max(2, 2.2 / view.scale) : Math.max(1.3, 1.6 / view.scale);

    ctx.save();
    ctx.translate(w.x1, w.y1);
    ctx.rotate(angle);

    ctx.strokeStyle = isSelected ? "#f97316" : (meta.isPartition ? "#475569" : "#1e293b");
    ctx.lineWidth = lineW;
    ctx.lineCap = "square";

    if (meta.isPartition && !isSelected) {
      ctx.setLineDash([6 / view.scale, 3 / view.scale]);
    }

    ctx.beginPath();
    ctx.moveTo(0, -halfT);
    ctx.lineTo(len, -halfT);
    ctx.moveTo(0, halfT);
    ctx.lineTo(len, halfT);
    ctx.stroke();
    ctx.setLineDash([]);

    const connStart = isEndpointConnected(w.x1, w.y1, w.id);
    const connEnd = isEndpointConnected(w.x2, w.y2, w.id);

    ctx.beginPath();
    if (!connStart) {
      ctx.moveTo(0, -halfT);
      ctx.lineTo(0, halfT);
    }
    if (!connEnd) {
      ctx.moveTo(len, -halfT);
      ctx.lineTo(len, halfT);
    }
    ctx.stroke();

    if (isSelected) {
      ctx.fillStyle = "#f97316";
      const r = 4.5 / view.scale;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.arc(len, 0, r, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  function drawCleanHaloText(text, x, y, color, haloWidth) {
    ctx.save();
    ctx.lineJoin = "round";
    ctx.miterLimit = 2;
    ctx.strokeStyle = "rgba(248, 250, 252, 0.94)";
    ctx.lineWidth = haloWidth;
    ctx.strokeText(text, x, y);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  function drawFineWallDimension(w, isSelected, poly) {
    const len = wallLengthCm(w);
    if (len <= 12) return;
    const thick = getWallThickness(w);
    const meta = getWallTypeMeta(w);
    const mx = (w.x1 + w.x2) / 2;
    const my = (w.y1 + w.y2) / 2;
    let angle = Math.atan2(w.y2 - w.y1, w.x2 - w.x1);

    const nx1 = -Math.sin(angle);
    const ny1 = Math.cos(angle);
    const testDist = thick / 2 + 15;

    let side = 1;
    if (poly && isPointInPolygon(mx + nx1 * testDist, my + ny1 * testDist, poly)) {
      side = -1;
    }

    const wallOpenings = state.openings.filter(o => o.wallId === w.id && o.type === "door");
    for (const op of wallOpenings) {
      const dirSide = (op.flip % 2 === 0) ? 1 : -1;
      if (dirSide === side) {
        side = -side;
        break;
      }
    }

    const offsetDist = thick / 2 + 11 / view.scale;
    const tx = mx + nx1 * offsetDist * side;
    const ty = my + ny1 * offsetDist * side;

    if (angle > Math.PI / 2 || angle <= -Math.PI / 2) {
      angle += Math.PI;
    }

    ctx.save();
    ctx.translate(tx, ty);
    ctx.rotate(angle);

    const fontSize = Math.max(10.5, 11.5 / view.scale);
    ctx.font = `${isSelected ? "700" : "600"} ${fontSize}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    const tagPrefix = meta.isPartition ? "TW " : "";
    const label = isSelected
      ? `${tagPrefix}${formatMeters(len)} m (${thick} cm)`
      : `${tagPrefix}${formatMeters(len)} m`;

    drawCleanHaloText(label, 0, 0, isSelected ? "#ea580c" : "#334155", 3.5 / view.scale);
    ctx.restore();
  }

  function drawPreviewWall(p1, p2) {
    const len = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    if (len < 2) return;
    const thick = state.defaultWallThickness || 25;
    const halfT = thick / 2;
    let angle = Math.atan2(p2.y - p1.y, p2.x - p1.x);

    ctx.save();
    ctx.translate(p1.x, p1.y);
    ctx.rotate(angle);

    ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
    ctx.fillRect(0, -halfT, len, thick);

    ctx.strokeStyle = "#f97316";
    ctx.lineWidth = Math.max(1.5, 1.8 / view.scale);
    ctx.setLineDash([7 / view.scale, 5 / view.scale]);

    ctx.beginPath();
    ctx.moveTo(0, -halfT);
    ctx.lineTo(len, -halfT);
    ctx.moveTo(0, halfT);
    ctx.lineTo(len, halfT);
    ctx.moveTo(0, -halfT);
    ctx.lineTo(0, halfT);
    ctx.moveTo(len, -halfT);
    ctx.lineTo(len, halfT);
    ctx.stroke();

    ctx.restore();

    const mx = (p1.x + p2.x) / 2;
    const my = (p1.y + p2.y) / 2;
    const nx = -Math.sin(angle) * (halfT + 13 / view.scale);
    const ny = Math.cos(angle) * (halfT + 13 / view.scale);
    if (angle > Math.PI / 2 || angle <= -Math.PI / 2) angle += Math.PI;

    ctx.save();
    ctx.translate(mx - nx, my - ny);
    ctx.rotate(angle);
    const fontSize = Math.max(11, 12 / view.scale);
    ctx.font = `700 ${fontSize}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    drawCleanHaloText(`${formatMeters(len)} m · ${thick} cm`, 0, 0, "#ea580c", 4 / view.scale);
    ctx.restore();
  }

  // Zeichnet Türen (Innen, Außen, Doppel, Schiebe, Balkon) & Fenster (Standard, Doppel, Balkon, Breit)
  function drawOpeningWithReveal(op, wall, isSelected) {
    const dx = wall.x2 - wall.x1;
    const dy = wall.y2 - wall.y1;
    const len = Math.hypot(dx, dy);
    if (len < 10) return;

    const thick = getWallThickness(wall);
    const halfT = thick / 2;
    const angle = Math.atan2(dy, dx);
    const meta = getOpeningMeta(op);

    const cx = wall.x1 + dx * op.t;
    const cy = wall.y1 + dy * op.t;
    const halfW = op.widthCm / 2;
    const lineW = isSelected ? Math.max(2, 2.2 / view.scale) : Math.max(1.3, 1.6 / view.scale);
    const activeColor = isSelected ? "#f97316" : (meta.isExterior ? "#0369a1" : "#0284c7");

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);

    // 1. Wandlinien im Bereich der Öffnung freischneiden
    ctx.fillStyle = "#f8fafc";
    ctx.fillRect(-halfW, -halfT - 2.5 / view.scale, op.widthCm, thick + 5 / view.scale);

    // 2. Laibungs-Linien
    ctx.strokeStyle = isSelected ? "#f97316" : "#1e293b";
    ctx.lineWidth = lineW;
    ctx.beginPath();
    ctx.moveTo(-halfW, -halfT);
    ctx.lineTo(-halfW, halfT);
    ctx.moveTo(halfW, -halfT);
    ctx.lineTo(halfW, halfT);
    ctx.stroke();

    if (op.type === "door") {
      const dirSide = (op.flip % 2 === 0) ? 1 : -1;
      const hingeSide = (Math.floor(op.flip / 2) % 2 === 0) ? -1 : 1;
      const hingeX = hingeSide * halfW;
      const hingeY = dirSide * halfT;

      if (meta.kind === "sliding") {
        // Schiebetür: Laufschiene + Türblatt parallel zur Wand
        ctx.strokeStyle = "#64748b";
        ctx.lineWidth = 1.2 / view.scale;
        ctx.beginPath();
        ctx.moveTo(-halfW * 1.15, dirSide * (halfT + 3 / view.scale));
        ctx.lineTo(halfW * 1.15, dirSide * (halfT + 3 / view.scale));
        ctx.stroke();

        ctx.strokeStyle = activeColor;
        ctx.lineWidth = Math.max(2.2, 2.5 / view.scale);
        ctx.beginPath();
        ctx.moveTo(-halfW, dirSide * (halfT + 3 / view.scale));
        ctx.lineTo(halfW * 0.85, dirSide * (halfT + 3 / view.scale));
        ctx.stroke();
      } else if (meta.kind === "double") {
        // Doppeltür: zwei gegenläufige Flügel (je halbe Breite)
        const leafLen = op.widthCm / 2;
        ctx.strokeStyle = activeColor;
        ctx.lineWidth = Math.max(2, 2.3 / view.scale);

        // Linker Flügel
        ctx.beginPath();
        ctx.moveTo(-halfW, hingeY);
        ctx.lineTo(-halfW, hingeY + dirSide * leafLen);
        // Rechter Flügel
        ctx.moveTo(halfW, hingeY);
        ctx.lineTo(halfW, hingeY + dirSide * leafLen);
        ctx.stroke();

        ctx.setLineDash([3.5 / view.scale, 3.5 / view.scale]);
        ctx.lineWidth = 1.1 / view.scale;
        ctx.beginPath();
        ctx.arc(-halfW, hingeY, leafLen, dirSide > 0 ? 0 : -Math.PI / 2, dirSide > 0 ? Math.PI / 2 : 0);
        ctx.moveTo(halfW + leafLen, hingeY);
        ctx.arc(halfW, hingeY, leafLen, dirSide > 0 ? Math.PI / 2 : Math.PI, dirSide > 0 ? Math.PI : 1.5 * Math.PI);
        ctx.stroke();
        ctx.setLineDash([]);
      } else {
        // Einzel-, Außen- oder Balkontür
        ctx.strokeStyle = activeColor;
        ctx.lineWidth = Math.max(2, 2.4 / view.scale);
        ctx.beginPath();
        ctx.moveTo(hingeX, hingeY);
        ctx.lineTo(hingeX, hingeY + dirSide * op.widthCm);
        ctx.stroke();

        ctx.setLineDash([4 / view.scale, 4 / view.scale]);
        ctx.lineWidth = 1.2 / view.scale;
        ctx.beginPath();
        if (hingeSide < 0) {
          ctx.arc(hingeX, hingeY, op.widthCm, dirSide > 0 ? 0 : -Math.PI / 2, dirSide > 0 ? Math.PI / 2 : 0);
        } else {
          ctx.arc(hingeX, hingeY, op.widthCm, dirSide > 0 ? Math.PI / 2 : Math.PI, dirSide > 0 ? Math.PI : 1.5 * Math.PI);
        }
        ctx.stroke();
        ctx.setLineDash([]);

        if (meta.kind === "balcony") {
          // Balkontür: zusätzlicher Brüstungs-/Festteil-Strich neben dem Flügel
          ctx.strokeStyle = "#0ea5e9";
          ctx.lineWidth = 1.4 / view.scale;
          ctx.beginPath();
          ctx.moveTo(-halfW, 0);
          ctx.lineTo(halfW, 0);
          ctx.stroke();
        }
      }

      if (showAllDimensions || isSelected) {
        ctx.save();
        const labelX = 0;
        const labelY = hingeY + dirSide * (op.widthCm * 0.42);
        ctx.translate(labelX, labelY);
        ctx.rotate(-angle);
        const fontSize = Math.max(9.5, 10.5 / view.scale);
        ctx.font = `700 ${fontSize}px sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        drawCleanHaloText(`${Math.round(op.widthCm)}`, 0, 0, isSelected ? "#ea580c" : "#0284c7", 3 / view.scale);
        ctx.restore();
      }
    } else {
      // Fenster-Varianten: Standard, Doppelfenster, Balkontür, Breit
      ctx.strokeStyle = "#94a3b8";
      ctx.lineWidth = 1 / view.scale;
      ctx.beginPath();
      ctx.moveTo(-halfW, -halfT);
      ctx.lineTo(halfW, -halfT);
      ctx.moveTo(-halfW, halfT);
      ctx.lineTo(halfW, halfT);
      ctx.stroke();

      const frameH = Math.min(8, thick * 0.34);
      ctx.strokeStyle = activeColor;
      ctx.lineWidth = Math.max(1.5, 1.7 / view.scale);
      ctx.strokeRect(-halfW, -frameH / 2, op.widthCm, frameH);

      ctx.beginPath();
      ctx.moveTo(-halfW, 0);
      ctx.lineTo(halfW, 0);
      if (meta.kind === "double" || meta.kind === "wide") {
        ctx.moveTo(0, -frameH / 2);
        ctx.lineTo(0, frameH / 2);
      }
      ctx.stroke();

      if (showAllDimensions || isSelected) {
        ctx.save();
        ctx.translate(0, -(halfT + 10 / view.scale));
        let textAng = 0;
        if (angle > Math.PI / 2 || angle <= -Math.PI / 2) textAng = Math.PI;
        ctx.rotate(textAng);
        const fontSize = Math.max(9.5, 10.5 / view.scale);
        ctx.font = `700 ${fontSize}px sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        drawCleanHaloText(`${Math.round(op.widthCm)}`, 0, 0, isSelected ? "#ea580c" : "#0284c7", 3 / view.scale);
        ctx.restore();
      }
    }

    ctx.restore();
  }

  function drawNote(note, isSelected) {
    ctx.save();
    const fontSize = Math.max(11, 12 / view.scale);
    ctx.font = `600 ${fontSize}px sans-serif`;
    const metrics = ctx.measureText(note.text);
    const padX = 8 / view.scale;
    const padY = 5 / view.scale;
    const boxW = metrics.width + padX * 2;
    const boxH = fontSize + padY * 2;

    ctx.fillStyle = isSelected ? "#f97316" : "rgba(254, 240, 138, 0.92)";
    ctx.strokeStyle = "#ca8a04";
    ctx.lineWidth = 1.2 / view.scale;
    ctx.beginPath();
    ctx.roundRect(note.x - boxW / 2, note.y - boxH / 2, boxW, boxH, 5 / view.scale);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = isSelected ? "#fff" : "#1e293b";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(note.text, note.x, note.y);
    ctx.restore();
  }

  // --- Hit-Testing & Auswahl ---
  function findElementAt(wx, wy) {
    const baseHit = 22 / view.scale;

    for (let i = state.notes.length - 1; i >= 0; i--) {
      const n = state.notes[i];
      if (Math.abs(wx - n.x) < 60 && Math.abs(wy - n.y) < 25) {
        return { kind: "note", id: n.id };
      }
    }

    for (let i = state.openings.length - 1; i >= 0; i--) {
      const op = state.openings[i];
      const wall = state.walls.find(w => w.id === op.wallId);
      if (!wall) continue;
      const ox = wall.x1 + (wall.x2 - wall.x1) * op.t;
      const oy = wall.y1 + (wall.y2 - wall.y1) * op.t;
      const hitRadius = Math.max(baseHit, op.widthCm * 0.55, getWallThickness(wall) / 2 + 8);
      if (Math.hypot(wx - ox, wy - oy) < hitRadius) {
        return { kind: "opening", id: op.id };
      }
    }

    for (let i = state.walls.length - 1; i >= 0; i--) {
      const w = state.walls[i];
      const proj = projectPointOnSegment(wx, wy, w.x1, w.y1, w.x2, w.y2);
      const wallHitDist = Math.max(baseHit, getWallThickness(w) / 2 + 8 / view.scale);
      if (proj.dist < wallHitDist) {
        return { kind: "wall", id: w.id };
      }
    }
    return null;
  }

  function findNearestWall(wx, wy) {
    let best = null;
    let minDist = 45 / view.scale;
    for (const w of state.walls) {
      const proj = projectPointOnSegment(wx, wy, w.x1, w.y1, w.x2, w.y2);
      const maxReach = Math.max(minDist, getWallThickness(w) / 2 + 18 / view.scale);
      if (proj.dist < maxReach) {
        minDist = proj.dist;
        best = { wall: w, t: proj.t };
      }
    }
    return best;
  }

  function selectElement(item) {
    selectedItem = item;
    const bar = document.getElementById("selectionBar");
    const label = document.getElementById("selectionLabel");
    const btnTypeMenu = document.getElementById("btnTypeMenu");
    const btnEditLen = document.getElementById("btnEditLength");
    const btnEditThick = document.getElementById("btnEditThickness");
    const btnFlip = document.getElementById("btnFlipElement");

    if (!item) {
      bar.classList.add("hidden");
      render();
      return;
    }

    bar.classList.remove("hidden");
    if (item.kind === "wall") {
      const w = state.walls.find(x => x.id === item.id);
      const thick = getWallThickness(w);
      const meta = getWallTypeMeta(w);
      label.textContent = `${meta.isPartition ? "Trennwand" : "Wand"}: ${formatMeters(wallLengthCm(w))} m · ${thick} cm`;
      btnTypeMenu.style.display = "inline-block";
      btnEditLen.textContent = "📏 Länge";
      btnEditLen.style.display = "inline-block";
      btnEditThick.style.display = "inline-block";
      btnFlip.style.display = "none";
    } else if (item.kind === "opening") {
      const op = state.openings.find(x => x.id === item.id);
      const meta = getOpeningMeta(op);
      if (op.type === "door") {
        label.textContent = `${meta.label} ${Math.round(op.widthCm)} cm (${getDoorSwingLabel(op.flip)})`;
        btnFlip.style.display = "inline-block";
      } else {
        label.textContent = `${meta.label}: ${Math.round(op.widthCm)} cm`;
        btnFlip.style.display = "none";
      }
      btnTypeMenu.style.display = "inline-block";
      btnEditLen.textContent = "📏 Breite";
      btnEditLen.style.display = "inline-block";
      btnEditThick.style.display = "none";
    } else if (item.kind === "note") {
      label.textContent = "Raum-Notiz";
      btnTypeMenu.style.display = "none";
      btnEditLen.style.display = "none";
      btnEditThick.style.display = "none";
      btnFlip.style.display = "none";
    }
    render();
  }

  function clearSelection() {
    selectElement(null);
  }

  function openTypeModalForSelection() {
    if (!selectedItem) return;
    const listEl = document.getElementById("typeOptionsList");
    listEl.innerHTML = "";

    if (selectedItem.kind === "wall") {
      const w = state.walls.find(x => x.id === selectedItem.id);
      const curMeta = getWallTypeMeta(w);
      document.getElementById("typeModalTitle").textContent = "Wand- oder Trennwand-Typ";
      document.getElementById("typeModalHint").textContent = "Ausführung für diese Wand wählen:";

      WALL_TYPES.forEach(wt => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "pattern-opt" + (curMeta.id === wt.id ? " selected" : "");
        btn.innerHTML = `<span>${wt.label}</span><small>${wt.thickCm} cm</small>`;
        btn.addEventListener("click", () => {
          pushUndo();
          w.wallType = wt.id;
          w.thicknessCm = wt.thickCm;
          document.getElementById("typeModal").classList.add("hidden");
          selectElement(selectedItem);
          render();
        });
        listEl.appendChild(btn);
      });
    } else if (selectedItem.kind === "opening") {
      const op = state.openings.find(x => x.id === selectedItem.id);
      const curMeta = getOpeningMeta(op);
      const catalog = op.type === "door" ? DOOR_TYPES : WINDOW_TYPES;
      document.getElementById("typeModalTitle").textContent =
        op.type === "door" ? "Tür-Ausführung wählen" : "Fenster-Ausführung wählen";
      document.getElementById("typeModalHint").textContent = "Typ & Standardbreite übernehmen:";

      catalog.forEach(item => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "pattern-opt" + (curMeta.id === item.id ? " selected" : "");
        btn.innerHTML = `<span>${item.label}</span><small>${item.defaultWidth} cm</small>`;
        btn.addEventListener("click", () => {
          pushUndo();
          op.subType = item.id;
          op.widthCm = item.defaultWidth;
          document.getElementById("typeModal").classList.add("hidden");
          selectElement(selectedItem);
          updateMetrics();
          render();
        });
        listEl.appendChild(btn);
      });
    }

    document.getElementById("typeModal").classList.remove("hidden");
  }

  // --- Pointer Events (Finger & S-Pen) ---
  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    activePointers.set(e.pointerId, { x: sx, y: sy });
    pointerDownPos = { x: sx, y: sy };
    pointerMoved = false;

    if (activePointers.size === 2) {
      isDrawing = false;
      drawStart = null;
      const pts = Array.from(activePointers.values());
      lastPinchDist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
      lastPanCenter = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      return;
    }

    const worldPt = screenToWorld(sx, sy);

    if (currentTool === "wall") {
      isDrawing = true;
      drawStart = snapPoint(worldPt);
      drawCurrent = drawStart;
      clearSelection();
    } else if (currentTool === "door" || currentTool === "window") {
      const existing = findElementAt(worldPt.x, worldPt.y);
      if (existing && existing.kind === "opening") {
        const op = state.openings.find(o => o.id === existing.id);
        if (op && op.type === "door") {
          pushUndo();
          op.flip = (op.flip + 1) % 4;
          selectElement(existing);
          render();
          saveAutosave();
          return;
        }
      }

      const hit = findNearestWall(worldPt.x, worldPt.y);
      if (hit) {
        pushUndo();
        const subId = currentTool === "door" ? state.defaultDoorType : state.defaultWindowType;
        const catalog = currentTool === "door" ? DOOR_TYPES : WINDOW_TYPES;
        const subMeta = catalog.find(c => c.id === subId) || catalog[0];
        const newOp = {
          id: "op_" + Date.now(),
          type: currentTool,
          subType: subMeta.id,
          wallId: hit.wall.id,
          t: Math.max(0.1, Math.min(0.9, hit.t)),
          widthCm: subMeta.defaultWidth,
          flip: 0
        };
        state.openings.push(newOp);
        selectElement({ kind: "opening", id: newOp.id });
        updateMetrics();
        render();
        saveAutosave();
      }
    } else if (currentTool === "note") {
      openNoteModal(worldPt);
    } else if (currentTool === "select") {
      const hit = findElementAt(worldPt.x, worldPt.y);
      if (hit && hit.kind === "opening" && selectedItem && selectedItem.kind === "opening" && selectedItem.id === hit.id) {
        const op = state.openings.find(o => o.id === hit.id);
        if (op && op.type === "door") {
          pushUndo();
          op.flip = (op.flip + 1) % 4;
          selectElement(hit);
          saveAutosave();
        }
      } else {
        selectElement(hit);
      }

      if (hit && hit.kind === "opening") {
        draggingOpening = state.openings.find(o => o.id === hit.id);
      } else if (hit && hit.kind === "note") {
        draggingNote = state.notes.find(n => n.id === hit.id);
      }
    }
  });

  canvas.addEventListener("pointermove", (e) => {
    if (!activePointers.has(e.pointerId)) return;
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    activePointers.set(e.pointerId, { x: sx, y: sy });

    if (pointerDownPos && Math.hypot(sx - pointerDownPos.x, sy - pointerDownPos.y) > 6) {
      pointerMoved = true;
    }

    if (activePointers.size === 2) {
      const pts = Array.from(activePointers.values());
      const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
      const center = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };

      if (lastPinchDist && lastPanCenter) {
        const scaleFactor = dist / lastPinchDist;
        const newScale = Math.max(0.25, Math.min(3.5, view.scale * scaleFactor));
        view.offsetX = center.x - (center.x - view.offsetX) * (newScale / view.scale) + (center.x - lastPanCenter.x);
        view.offsetY = center.y - (center.y - view.offsetY) * (newScale / view.scale) + (center.y - lastPanCenter.y);
        view.scale = newScale;
        render();
      }
      lastPinchDist = dist;
      lastPanCenter = center;
      return;
    }

    const worldPt = screenToWorld(sx, sy);

    if (isDrawing && currentTool === "wall") {
      let snapped = snapPoint(worldPt);
      const dx = snapped.x - drawStart.x;
      const dy = snapped.y - drawStart.y;
      if (Math.abs(dx) > 20 && Math.abs(dy) < Math.abs(dx) * 0.1) snapped.y = drawStart.y;
      if (Math.abs(dy) > 20 && Math.abs(dx) < Math.abs(dy) * 0.1) snapped.x = drawStart.x;

      drawCurrent = snapped;
      render();
    } else if (draggingOpening && pointerMoved) {
      const wall = state.walls.find(w => w.id === draggingOpening.wallId);
      if (wall) {
        const proj = projectPointOnSegment(worldPt.x, worldPt.y, wall.x1, wall.y1, wall.x2, wall.y2);
        draggingOpening.t = Math.max(0.08, Math.min(0.92, proj.t));
        render();
      }
    } else if (draggingNote && pointerMoved) {
      draggingNote.x = worldPt.x;
      draggingNote.y = worldPt.y;
      render();
    }
  });

  function endPointer(e) {
    activePointers.delete(e.pointerId);
    if (activePointers.size < 2) {
      lastPinchDist = null;
      lastPanCenter = null;
    }

    if (isDrawing && drawStart && drawCurrent) {
      const len = Math.hypot(drawCurrent.x - drawStart.x, drawCurrent.y - drawStart.y);
      if (len >= 15) {
        pushUndo();
        const newWall = {
          id: "w_" + Date.now(),
          x1: drawStart.x,
          y1: drawStart.y,
          x2: drawCurrent.x,
          y2: drawCurrent.y,
          thicknessCm: state.defaultWallThickness,
          wallType: state.defaultWallType
        };
        state.walls.push(newWall);
        updateMetrics();
        saveAutosave();
      }
    }

    isDrawing = false;
    drawStart = null;
    drawCurrent = null;
    draggingOpening = null;
    draggingNote = null;
    render();
  }

  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);

  // --- UI & Modals ---
  let pendingNotePos = null;

  function openNoteModal(pos) {
    pendingNotePos = pos;
    document.getElementById("inputNoteText").value = "";
    document.getElementById("noteModal").classList.remove("hidden");
    setTimeout(() => document.getElementById("inputNoteText").focus(), 50);
  }

  function openNumberModal({ mode, title, hint, currentVal, presets }) {
    modalMode = mode;
    document.getElementById("lengthModalTitle").textContent = title;
    document.getElementById("lengthModalHint").textContent = hint;
    const input = document.getElementById("inputCm");
    input.value = Math.round(currentVal);

    const presetContainer = document.getElementById("quickPresets");
    presetContainer.innerHTML = "";
    presets.forEach(cm => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = `${cm} cm`;
      btn.addEventListener("click", () => {
        input.value = cm;
      });
      presetContainer.appendChild(btn);
    });

    document.getElementById("lengthModal").classList.remove("hidden");
    setTimeout(() => input.focus(), 50);
  }

  function bindUI() {
    document.querySelectorAll(".tool-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const tool = btn.dataset.tool;
        if (tool === "pattern") {
          document.getElementById("patternModal").classList.remove("hidden");
          return;
        }
        document.querySelectorAll(".tool-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        currentTool = tool;
        if (tool !== "select") clearSelection();
      });
    });

    document.getElementById("btnWallSettings").addEventListener("click", () => {
      openNumberModal({
        mode: "defaultWallThickness",
        title: "Standard-Wandstärke",
        hint: "Wandstärke für neu gezeichnete Wände (cm):",
        currentVal: state.defaultWallThickness,
        presets: [10, 12, 15, 20, 25, 30, 38]
      });
    });

    document.getElementById("btnUndo").addEventListener("click", undo);

    document.getElementById("btnClear").addEventListener("click", () => {
      if (!state.walls.length && !state.notes.length) return;
      if (confirm("Aktuelle Zeichnung wirklich komplett leeren?")) {
        pushUndo();
        state.walls = [];
        state.openings = [];
        state.notes = [];
        clearSelection();
        updateMetrics();
        render();
        saveAutosave();
      }
    });

    document.getElementById("projectName").addEventListener("input", (e) => {
      state.name = e.target.value || "Unbenannt";
      saveAutosave();
    });

    document.getElementById("btnZoomIn").addEventListener("click", () => {
      view.scale = Math.min(3.5, view.scale * 1.2);
      render();
    });
    document.getElementById("btnZoomOut").addEventListener("click", () => {
      view.scale = Math.max(0.25, view.scale / 1.2);
      render();
    });
    document.getElementById("btnResetView").addEventListener("click", () => {
      centerView();
      render();
    });
    document.getElementById("btnSnap").addEventListener("click", (e) => {
      snapEnabled = !snapEnabled;
      e.currentTarget.classList.toggle("toggle-active", snapEnabled);
    });
    document.getElementById("btnToggleDims").addEventListener("click", (e) => {
      showAllDimensions = !showAllDimensions;
      e.currentTarget.classList.toggle("toggle-active", showAllDimensions);
      render();
    });

    document.getElementById("btnTypeMenu").addEventListener("click", openTypeModalForSelection);
    document.getElementById("btnCloseTypeModal").addEventListener("click", () => {
      document.getElementById("typeModal").classList.add("hidden");
    });

    document.getElementById("btnDeleteSelected").addEventListener("click", () => {
      if (!selectedItem) return;
      pushUndo();
      if (selectedItem.kind === "wall") {
        state.walls = state.walls.filter(w => w.id !== selectedItem.id);
        state.openings = state.openings.filter(o => o.wallId !== selectedItem.id);
      } else if (selectedItem.kind === "opening") {
        state.openings = state.openings.filter(o => o.id !== selectedItem.id);
      } else if (selectedItem.kind === "note") {
        state.notes = state.notes.filter(n => n.id !== selectedItem.id);
      }
      clearSelection();
      updateMetrics();
      render();
      saveAutosave();
    });

    document.getElementById("btnFlipElement").addEventListener("click", () => {
      if (!selectedItem || selectedItem.kind !== "opening") return;
      const op = state.openings.find(o => o.id === selectedItem.id);
      if (op) {
        pushUndo();
        op.flip = (op.flip + 1) % 4;
        selectElement(selectedItem);
        render();
        saveAutosave();
      }
    });

    document.getElementById("btnEditLength").addEventListener("click", () => {
      if (!selectedItem) return;
      if (selectedItem.kind === "wall") {
        const w = state.walls.find(x => x.id === selectedItem.id);
        openNumberModal({
          mode: "wallLength",
          title: "Wandlänge exakt festlegen",
          hint: "Wandlänge in Zentimetern (cm):",
          currentVal: wallLengthCm(w),
          presets: [100, 200, 300, 400, 500, 600]
        });
      } else if (selectedItem.kind === "opening") {
        const op = state.openings.find(x => x.id === selectedItem.id);
        openNumberModal({
          mode: "openingWidth",
          title: op.type === "door" ? "Türbreite festlegen" : "Fensterbreite festlegen",
          hint: "Öffnungsbreite in Zentimetern (cm):",
          currentVal: op.widthCm,
          presets: [70, 80, 90, 100, 120, 160, 220]
        });
      }
    });

    document.getElementById("btnEditThickness").addEventListener("click", () => {
      if (!selectedItem || selectedItem.kind !== "wall") return;
      const w = state.walls.find(x => x.id === selectedItem.id);
      openNumberModal({
        mode: "wallThickness",
        title: "Wandstärke dieser Wand",
        hint: "Wandstärke in Zentimetern (cm):",
        currentVal: getWallThickness(w),
        presets: [10, 12, 15, 20, 25, 30, 38]
      });
    });

    document.getElementById("btnCancelLength").addEventListener("click", () => {
      document.getElementById("lengthModal").classList.add("hidden");
    });

    document.getElementById("btnSaveLength").addEventListener("click", () => {
      const val = parseFloat(document.getElementById("inputCm").value);
      if (!val || val < 5) return;

      pushUndo();
      if (modalMode === "defaultWallThickness") {
        state.defaultWallThickness = val;
        updateHeaderInfo();
      } else if (modalMode === "wallThickness" && selectedItem && selectedItem.kind === "wall") {
        const w = state.walls.find(x => x.id === selectedItem.id);
        if (w) w.thicknessCm = val;
        selectElement(selectedItem);
      } else if (modalMode === "wallLength" && selectedItem && selectedItem.kind === "wall") {
        const w = state.walls.find(x => x.id === selectedItem.id);
        const curLen = wallLengthCm(w);
        if (w && curLen > 0) {
          const ratio = val / curLen;
          w.x2 = Math.round(w.x1 + (w.x2 - w.x1) * ratio);
          w.y2 = Math.round(w.y1 + (w.y2 - w.y1) * ratio);
        }
        selectElement(selectedItem);
        updateMetrics();
      } else if (modalMode === "openingWidth" && selectedItem && selectedItem.kind === "opening") {
        const op = state.openings.find(x => x.id === selectedItem.id);
        if (op) op.widthCm = val;
        selectElement(selectedItem);
        updateMetrics();
      }

      document.getElementById("lengthModal").classList.add("hidden");
      render();
      saveAutosave();
    });

    document.querySelectorAll(".pattern-opt").forEach(btn => {
      btn.addEventListener("click", () => {
        pushUndo();
        state.pattern = btn.dataset.pattern;
        document.getElementById("patternModal").classList.add("hidden");
        render();
        saveAutosave();
      });
    });

    document.getElementById("btnClosePattern").addEventListener("click", () => {
      document.getElementById("patternModal").classList.add("hidden");
    });

    document.getElementById("btnCancelNote").addEventListener("click", () => {
      document.getElementById("noteModal").classList.add("hidden");
    });

    document.getElementById("btnSaveNote").addEventListener("click", () => {
      const text = document.getElementById("inputNoteText").value.trim();
      if (text && pendingNotePos) {
        pushUndo();
        state.notes.push({
          id: "n_" + Date.now(),
          x: pendingNotePos.x,
          y: pendingNotePos.y,
          text
        });
        render();
        saveAutosave();
      }
      document.getElementById("noteModal").classList.add("hidden");
    });

    // Projekte speichern, laden & verwalten
    document.getElementById("btnProjects").addEventListener("click", () => {
      document.getElementById("saveProjectNameInput").value = state.name || "Baustelle / Raum 1";
      refreshSavedList();
      document.getElementById("projectsModal").classList.remove("hidden");
    });

    document.getElementById("btnCloseProjects").addEventListener("click", () => {
      document.getElementById("projectsModal").classList.add("hidden");
    });

    document.getElementById("btnSaveLocal").addEventListener("click", () => {
      const customName = document.getElementById("saveProjectNameInput").value.trim() || state.name || "Projekt";
      state.name = customName;
      document.getElementById("projectName").value = customName;

      const list = getSavedProjects();
      const idx = list.findIndex(p => p.id === state.id);
      const rooms = findAllClosedRooms();
      const totalArea = rooms.reduce((s, r) => s + r.areaM2, 0).toFixed(2).replace(".", ",");

      const copy = JSON.parse(JSON.stringify(state));
      copy.updatedAt = new Date().toLocaleString("de-AT", { dateStyle: "short", timeStyle: "short" });
      copy.summaryArea = `${totalArea} m²`;
      copy.summaryRooms = rooms.length;

      if (idx >= 0) list[idx] = copy;
      else list.unshift(copy);

      localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
      saveAutosave();
      refreshSavedList();
      alert(`Projekt „${customName}“ gespeichert!`);
    });

    document.getElementById("btnNewProject").addEventListener("click", () => {
      state = {
        id: "proj_" + Date.now(),
        name: "Neues Projekt",
        defaultWallThickness: state.defaultWallThickness || 25,
        defaultWallType: "wall",
        defaultDoorType: "door-in",
        defaultWindowType: "win-standard",
        walls: [],
        openings: [],
        notes: [],
        pattern: "none"
      };
      document.getElementById("projectName").value = state.name;
      document.getElementById("saveProjectNameInput").value = state.name;
      undoStack = [];
      clearSelection();
      updateMetrics();
      centerView();
      render();
      saveAutosave();
      document.getElementById("projectsModal").classList.add("hidden");
    });

    document.getElementById("btnExportPNG").addEventListener("click", () => {
      clearSelection();
      const link = document.createElement("a");
      link.download = `${state.name.replace(/[^a-z0-9äöüß_-]/gi, "_")}.png`;
      link.href = canvas.toDataURL("image/png");
      link.click();
    });

    document.getElementById("btnPrintPDF").addEventListener("click", () => {
      document.getElementById("projectsModal").classList.add("hidden");
      clearSelection();
      setTimeout(() => window.print(), 150);
    });

    document.getElementById("btnExportJSON").addEventListener("click", () => {
      const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${state.name.replace(/[^a-z0-9äöüß_-]/gi, "_")}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });

    document.getElementById("inputImportJSON").addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const data = JSON.parse(ev.target.result);
          if (Array.isArray(data.walls)) {
            state = Object.assign({
              id: "proj_" + Date.now(),
              name: "Importiertes Projekt",
              defaultWallThickness: 25,
              walls: [],
              openings: [],
              notes: [],
              pattern: "none"
            }, data);
            document.getElementById("projectName").value = state.name;
            updateHeaderInfo();
            undoStack = [];
            clearSelection();
            updateMetrics();
            centerView();
            render();
            saveAutosave();
            document.getElementById("projectsModal").classList.add("hidden");
          }
        } catch {
          alert("Ungültige JSON-Datei.");
        }
      };
      reader.readAsText(file);
    });
  }

  function getSavedProjects() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    } catch {
      return [];
    }
  }

  function refreshSavedList() {
    const container = document.getElementById("savedProjectsList");
    const list = getSavedProjects();
    if (!list.length) {
      container.innerHTML = `<div class="modal-hint">Noch keine gespeicherten Projekte vorhanden.</div>`;
      return;
    }
    container.innerHTML = "";
    list.forEach(proj => {
      const div = document.createElement("div");
      div.className = "saved-item";
      const metaParts = [`${proj.walls.length} Wände`];
      if (proj.summaryArea) metaParts.push(proj.summaryArea);
      if (proj.updatedAt) metaParts.push(proj.updatedAt);

      div.innerHTML = `
        <div class="saved-item-info">
          <span class="saved-item-title">${proj.name}</span>
          <span class="saved-item-meta">${metaParts.join(" · ")}</span>
        </div>
        <div class="saved-item-actions">
          <button class="load-btn">Laden</button>
          <button class="del">✕</button>
        </div>
      `;
      div.querySelector(".load-btn").addEventListener("click", () => {
        state = JSON.parse(JSON.stringify(proj));
        if (!state.defaultWallThickness) state.defaultWallThickness = 25;
        document.getElementById("projectName").value = state.name;
        updateHeaderInfo();
        undoStack = [];
        clearSelection();
        updateMetrics();
        centerView();
        render();
        saveAutosave();
        document.getElementById("projectsModal").classList.add("hidden");
      });
      div.querySelector(".del").addEventListener("click", () => {
        const filtered = getSavedProjects().filter(p => p.id !== proj.id);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(filtered));
        refreshSavedList();
      });
      container.appendChild(div);
    });
  }

  init();
})();
