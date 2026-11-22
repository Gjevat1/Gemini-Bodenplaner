(() => {
  // --- Konfiguration & Maßstab ---
  // 1 Pixel im Welt-Koordinatensystem = 1 cm (100 Einheiten = 1,00 m)
  const SNAP_STEP = 10; // 10 cm Rasterfang
  const GRID_MAJOR = 100; // 100 cm = 1 m
  const GRID_MINOR = 50;  // 50 cm = 0,5 m
  const STORAGE_KEY = "aufmass_planer_projects_v1";

  const canvas = document.getElementById("planCanvas");
  const ctx = canvas.getContext("2d");
  const wrapper = document.getElementById("canvasWrapper");

  // --- App-Zustand ---
  let state = {
    id: "proj_" + Date.now(),
    name: "Baustelle / Raum 1",
    walls: [],     // { id, x1, y1, x2, y2 } in cm
    openings: [],  // { id, type: 'door'|'window', wallId, t: 0..1, widthCm, flip: 0..3 }
    notes: [],     // { id, x, y, text } in cm
    pattern: "none" // 'none' | 'plank-0' | 'plank-90' | 'plank-45' | 'herringbone'
  };

  let undoStack = [];

  // Kamera / Viewport
  let view = {
    offsetX: 0,
    offsetY: 0,
    scale: 1.0 // px pro cm
  };

  // Interaktions-Status
  let currentTool = "wall";
  let snapEnabled = true;
  let isDrawing = false;
  let drawStart = null;
  let drawCurrent = null;
  let selectedItem = null; // { kind: 'wall'|'opening'|'note', id }
  let draggingOpening = null;
  let draggingNote = null;

  // Pinch-Zoom & Pan
  let activePointers = new Map();
  let lastPinchDist = null;
  let lastPanCenter = null;

  // --- Initialisierung ---
  function init() {
    resizeCanvas();
    centerView();
    bindUI();
    render();
    updateMetrics();
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

  window.addEventListener("resize", resizeCanvas);

  // --- Koordinaten-Transformation ---
  function screenToWorld(sx, sy) {
    return {
      x: (sx - view.offsetX) / view.scale,
      y: (sy - view.offsetY) / view.scale
    };
  }

  function worldToScreen(wx, wy) {
    return {
      x: wx * view.scale + view.offsetX,
      y: wy * view.scale + view.offsetY
    };
  }

  function snapPoint(pt) {
    // 1. Prüfe Magnet-Fang auf vorhandene Wand-Endpunkte (25 cm Radius)
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
      pattern: state.pattern
    }));
    if (undoStack.length > 30) undoStack.shift();
  }

  function undo() {
    if (!undoStack.length) return;
    const prev = JSON.parse(undoStack.pop());
    state.walls = prev.walls;
    state.openings = prev.openings;
    state.notes = prev.notes;
    state.pattern = prev.pattern;
    clearSelection();
    updateMetrics();
    render();
  }

  // --- Geometrie & Berechnungen ---
  function wallLengthCm(w) {
    return Math.hypot(w.x2 - w.x1, w.y2 - w.y1);
  }

  function formatMeters(cm) {
    return (cm / 100).toFixed(2).replace(".", ",");
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

  // Geschlossene Polygon-Schleife aus Wänden erkennen für m²-Berechnung
  function findClosedPolygon() {
    if (state.walls.length < 3) return null;
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

    // Suche Zyklus über DFS
    const visitedEdges = new Set();
    for (const startWall of state.walls) {
      const startKey = key(startWall.x1, startWall.y1);
      const path = [{ x: startWall.x1, y: startWall.y1, k: startKey }];

      function dfs(currKey, prevEdgeId) {
        const neighbors = adj.get(currKey) || [];
        for (const nb of neighbors) {
          if (nb.id === prevEdgeId) continue;
          if (nb.k === startKey && path.length >= 3) {
            return [...path];
          }
          if (!path.some(p => p.k === nb.k) && path.length < 25) {
            path.push({ x: nb.x, y: nb.y, k: nb.k });
            const res = dfs(nb.k, nb.id);
            if (res) return res;
            path.pop();
          }
        }
        return null;
      }

      const poly = dfs(startKey, null);
      if (poly) return poly;
    }
    return null;
  }

  function computePolygonAreaM2(poly) {
    if (!poly || poly.length < 3) return 0;
    let sum = 0;
    for (let i = 0; i < poly.length; i++) {
      const j = (i + 1) % poly.length;
      sum += poly[i].x * poly[j].y - poly[j].x * poly[i].y;
    }
    const areaCm2 = Math.abs(sum) / 2;
    return areaCm2 / 10000; // cm² -> m²
  }

  function updateMetrics() {
    let totalPerimeterCm = 0;
    for (const w of state.walls) {
      totalPerimeterCm += wallLengthCm(w);
    }

    let doorDeductionCm = 0;
    for (const op of state.openings) {
      if (op.type === "door") {
        doorDeductionCm += op.widthCm;
      }
    }

    const skirtingCm = Math.max(0, totalPerimeterCm - doorDeductionCm);
    const poly = findClosedPolygon();
    const areaM2 = computePolygonAreaM2(poly);

    document.getElementById("valArea").textContent = areaM2.toFixed(2).replace(".", ",") + " m²";
    document.getElementById("valPerimeter").textContent = formatMeters(totalPerimeterCm) + " lfm";
    document.getElementById("valSkirting").textContent = formatMeters(skirtingCm) + " lfm";
  }

  // --- Zeichen-Engine ---
  function render() {
    const rect = wrapper.getBoundingClientRect();
    ctx.clearRect(0, 0, rect.width, rect.height);

    // Hintergrund
    ctx.fillStyle = "#f8fafc";
    ctx.fillRect(0, 0, rect.width, rect.height);

    drawGrid(rect.width, rect.height);

    ctx.save();
    ctx.translate(view.offsetX, view.offsetY);
    ctx.scale(view.scale, view.scale);

    // Raumfläche & Verlegemuster
    const poly = findClosedPolygon();
    if (poly) {
      drawRoomFillAndPattern(poly);
    }

    // Wände
    for (const w of state.walls) {
      const isSel = selectedItem && selectedItem.kind === "wall" && selectedItem.id === w.id;
      drawWall(w, isSel);
    }

    // Aktuelle Vorschau-Wand beim Zeichnen
    if (isDrawing && drawStart && drawCurrent) {
      drawPreviewWall(drawStart, drawCurrent);
    }

    // Türen & Fenster
    for (const op of state.openings) {
      const wall = state.walls.find(w => w.id === op.wallId);
      if (!wall) continue;
      const isSel = selectedItem && selectedItem.kind === "opening" && selectedItem.id === op.id;
      drawOpening(op, wall, isSel);
    }

    // Notizen
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

  function drawRoomFillAndPattern(poly) {
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(poly[0].x, poly[0].y);
    for (let i = 1; i < poly.length; i++) {
      ctx.lineTo(poly[i].x, poly[i].y);
    }
    ctx.closePath();

    // Dezente Holz-/Bodenfüllung
    ctx.fillStyle = state.pattern === "none" ? "rgba(56, 189, 248, 0.12)" : "rgba(217, 119, 6, 0.12)";
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

      ctx.strokeStyle = "rgba(180, 83, 9, 0.35)";
      ctx.lineWidth = 1.5 / view.scale;

      if (state.pattern === "plank-0") {
        const plankW = 20; // 20 cm Dielenbreite
        for (let y = minY; y <= maxY; y += plankW) {
          ctx.beginPath();
          ctx.moveTo(minX, y);
          ctx.lineTo(maxX, y);
          ctx.stroke();
        }
      } else if (state.pattern === "plank-90") {
        const plankW = 20;
        for (let x = minX; x <= maxX; x += plankW) {
          ctx.beginPath();
          ctx.moveTo(x, minY);
          ctx.lineTo(x, maxY);
          ctx.stroke();
        }
      } else if (state.pattern === "plank-45") {
        const step = 25;
        const span = (maxX - minX) + (maxY - minY);
        for (let d = -span; d <= span; d += step) {
          ctx.beginPath();
          ctx.moveTo(minX + d, minY);
          ctx.lineTo(minX + d - (maxY - minY), maxY);
          ctx.stroke();
        }
      } else if (state.pattern === "herringbone") {
        // Fischgrät-Muster
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

    // m² Label in Raum-Mitte
    const cx = poly.reduce((acc, p) => acc + p.x, 0) / poly.length;
    const cy = poly.reduce((acc, p) => acc + p.y, 0) / poly.length;
    const areaM2 = computePolygonAreaM2(poly);

    ctx.fillStyle = "#0f172a";
    ctx.font = `bold ${Math.max(13, 15 / view.scale)}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(`${areaM2.toFixed(2).replace(".", ",")} m²`, cx, cy);

    ctx.restore();
  }

  function drawWall(w, isSelected) {
    const thickness = 12; // 12 cm Wandstärke Darstellung
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineWidth = thickness;
    ctx.strokeStyle = isSelected ? "#f97316" : "#1e293b";
    ctx.beginPath();
    ctx.moveTo(w.x1, w.y1);
    ctx.lineTo(w.x2, w.y2);
    ctx.stroke();

    // Endpunkte
    ctx.fillStyle = isSelected ? "#f97316" : "#0f172a";
    const r = 7;
    ctx.beginPath();
    ctx.arc(w.x1, w.y1, r, 0, Math.PI * 2);
    ctx.arc(w.x2, w.y2, r, 0, Math.PI * 2);
    ctx.fill();

    // Maß-Label
    const len = wallLengthCm(w);
    if (len > 15) {
      const mx = (w.x1 + w.x2) / 2;
      const my = (w.y1 + w.y2) / 2;
      const angle = Math.atan2(w.y2 - w.y1, w.x2 - w.x1);
      const nx = -Math.sin(angle) * 20;
      const ny = Math.cos(angle) * 20;

      drawDimensionBadge(`${formatMeters(len)} m`, mx + nx, my + ny, isSelected ? "#f97316" : "#0f172a");
    }
    ctx.restore();
  }

  function drawPreviewWall(p1, p2) {
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineWidth = 10;
    ctx.setLineDash([12, 10]);
    ctx.strokeStyle = "#f97316";
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();

    const len = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    if (len > 5) {
      drawDimensionBadge(`${formatMeters(len)} m`, (p1.x + p2.x) / 2, (p1.y + p2.y) / 2 - 22, "#ea580c");
    }
    ctx.restore();
  }

  function drawOpening(op, wall, isSelected) {
    const dx = wall.x2 - wall.x1;
    const dy = wall.y2 - wall.y1;
    const len = Math.hypot(dx, dy);
    if (len < 10) return;

    const ux = dx / len;
    const uy = dy / len;
    const angle = Math.atan2(dy, dx);

    const cx = wall.x1 + dx * op.t;
    const cy = wall.y1 + dy * op.t;
    const halfW = op.widthCm / 2;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);

    // Wand-Aussparung
    ctx.fillStyle = "#f8fafc";
    ctx.fillRect(-halfW, -8, op.widthCm, 16);

    if (op.type === "door") {
      // Türrahmen & Öffnungsbogen (flip steuert Anschlag links/rechts & innen/außen)
      const dirSide = (op.flip % 2 === 0) ? 1 : -1;
      const hingeSide = (Math.floor(op.flip / 2) % 2 === 0) ? -1 : 1;

      const hingeX = hingeSide * halfW;
      ctx.strokeStyle = isSelected ? "#f97316" : "#0284c7";
      ctx.lineWidth = 3;

      // Türblatt
      ctx.beginPath();
      ctx.moveTo(hingeX, 0);
      ctx.lineTo(hingeX, dirSide * op.widthCm);
      ctx.stroke();

      // Drehkreis
      ctx.setLineDash([5, 5]);
      ctx.lineWidth = 2;
      ctx.beginPath();
      const startAng = dirSide > 0 ? 0 : -Math.PI / 2;
      const endAng = dirSide > 0 ? Math.PI / 2 : 0;
      if (hingeSide < 0) {
        ctx.arc(hingeX, 0, op.widthCm, dirSide > 0 ? 0 : -Math.PI / 2, dirSide > 0 ? Math.PI / 2 : 0);
      } else {
        ctx.arc(hingeX, 0, op.widthCm, dirSide > 0 ? Math.PI / 2 : Math.PI, dirSide > 0 ? Math.PI : 1.5 * Math.PI);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    } else {
      // Fenster-Symbol
      ctx.strokeStyle = isSelected ? "#f97316" : "#0ea5e9";
      ctx.lineWidth = 3;
      ctx.strokeRect(-halfW, -6, op.widthCm, 12);
      ctx.beginPath();
      ctx.moveTo(-halfW, 0);
      ctx.lineTo(halfW, 0);
      ctx.stroke();
    }

    ctx.restore();

    // Breiten-Label
    drawDimensionBadge(`${Math.round(op.widthCm)} cm`, cx, cy - 18, isSelected ? "#f97316" : "#0284c7");
  }

  function drawNote(note, isSelected) {
    ctx.save();
    const fontSize = Math.max(12, 13 / view.scale);
    ctx.font = `600 ${fontSize}px sans-serif`;
    const metrics = ctx.measureText(note.text);
    const padX = 10 / view.scale;
    const padY = 6 / view.scale;
    const boxW = metrics.width + padX * 2;
    const boxH = fontSize + padY * 2;

    ctx.fillStyle = isSelected ? "#f97316" : "#fef08a";
    ctx.strokeStyle = "#ca8a04";
    ctx.lineWidth = 1.5 / view.scale;
    ctx.beginPath();
    ctx.roundRect(note.x - boxW / 2, note.y - boxH / 2, boxW, boxH, 6 / view.scale);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = isSelected ? "#fff" : "#1e293b";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(note.text, note.x, note.y);
    ctx.restore();
  }

  function drawDimensionBadge(text, x, y, bgColor) {
    ctx.save();
    const fontSize = Math.max(11, 12 / view.scale);
    ctx.font = `700 ${fontSize}px sans-serif`;
    const w = ctx.measureText(text).width + 10 / view.scale;
    const h = fontSize + 6 / view.scale;

    ctx.fillStyle = bgColor;
    ctx.beginPath();
    ctx.roundRect(x - w / 2, y - h / 2, w, h, 5 / view.scale);
    ctx.fill();

    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  // --- Hit-Testing & Auswahl ---
  function findElementAt(wx, wy) {
    const hitDist = 24 / view.scale;

    // 1. Notizen prüfen
    for (let i = state.notes.length - 1; i >= 0; i--) {
      const n = state.notes[i];
      if (Math.abs(wx - n.x) < 60 && Math.abs(wy - n.y) < 25) {
        return { kind: "note", id: n.id };
      }
    }

    // 2. Türen & Fenster prüfen
    for (let i = state.openings.length - 1; i >= 0; i--) {
      const op = state.openings[i];
      const wall = state.walls.find(w => w.id === op.wallId);
      if (!wall) continue;
      const ox = wall.x1 + (wall.x2 - wall.x1) * op.t;
      const oy = wall.y1 + (wall.y2 - wall.y1) * op.t;
      if (Math.hypot(wx - ox, wy - oy) < Math.max(hitDist, op.widthCm / 2)) {
        return { kind: "opening", id: op.id };
      }
    }

    // 3. Wände prüfen
    for (let i = state.walls.length - 1; i >= 0; i--) {
      const w = state.walls[i];
      const proj = projectPointOnSegment(wx, wy, w.x1, w.y1, w.x2, w.y2);
      if (proj.dist < hitDist) {
        return { kind: "wall", id: w.id };
      }
    }
    return null;
  }

  function findNearestWall(wx, wy) {
    let best = null;
    let minDist = 35 / view.scale;
    for (const w of state.walls) {
      const proj = projectPointOnSegment(wx, wy, w.x1, w.y1, w.x2, w.y2);
      if (proj.dist < minDist) {
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
    const btnEdit = document.getElementById("btnEditLength");
    const btnFlip = document.getElementById("btnFlipElement");

    if (!item) {
      bar.classList.add("hidden");
      render();
      return;
    }

    bar.classList.remove("hidden");
    if (item.kind === "wall") {
      const w = state.walls.find(x => x.id === item.id);
      label.textContent = `Wand: ${formatMeters(wallLengthCm(w))} m`;
      btnEdit.style.display = "inline-block";
      btnFlip.style.display = "none";
    } else if (item.kind === "opening") {
      const op = state.openings.find(x => x.id === item.id);
      label.textContent = `${op.type === "door" ? "Tür" : "Fenster"}: ${Math.round(op.widthCm)} cm`;
      btnEdit.style.display = "inline-block";
      btnFlip.style.display = op.type === "door" ? "inline-block" : "none";
    } else if (item.kind === "note") {
      label.textContent = "Raum-Notiz";
      btnEdit.style.display = "none";
      btnFlip.style.display = "none";
    }
    render();
  }

  function clearSelection() {
    selectElement(null);
  }

  // --- Pointer Events (Finger & S-Pen) ---
  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    activePointers.set(e.pointerId, { x: sx, y: sy });

    // Zwei Finger -> Zoom / Pan starten
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
      const hit = findNearestWall(worldPt.x, worldPt.y);
      if (hit) {
        pushUndo();
        const newOp = {
          id: "op_" + Date.now(),
          type: currentTool,
          wallId: hit.wall.id,
          t: Math.max(0.1, Math.min(0.9, hit.t)),
          widthCm: currentTool === "door" ? 90 : 120,
          flip: 0
        };
        state.openings.push(newOp);
        selectElement({ kind: "opening", id: newOp.id });
        updateMetrics();
        render();
      }
    } else if (currentTool === "note") {
      openNoteModal(worldPt);
    } else if (currentTool === "select") {
      const hit = findElementAt(worldPt.x, worldPt.y);
      selectElement(hit);
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

    // Multi-Touch Zoom & Pan
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
      // Leichte Orthogonal-Hilfe (waagerecht/senkrecht einrasten innerhalb 6°)
      const dx = snapped.x - drawStart.x;
      const dy = snapped.y - drawStart.y;
      if (Math.abs(dx) > 20 && Math.abs(dy) < Math.abs(dx) * 0.1) snapped.y = drawStart.y;
      if (Math.abs(dy) > 20 && Math.abs(dx) < Math.abs(dy) * 0.1) snapped.x = drawStart.x;

      drawCurrent = snapped;
      render();
    } else if (draggingOpening) {
      const wall = state.walls.find(w => w.id === draggingOpening.wallId);
      if (wall) {
        const proj = projectPointOnSegment(worldPt.x, worldPt.y, wall.x1, wall.y1, wall.x2, wall.y2);
        draggingOpening.t = Math.max(0.08, Math.min(0.92, proj.t));
        render();
      }
    } else if (draggingNote) {
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
          y2: drawCurrent.y
        };
        state.walls.push(newWall);
        updateMetrics();
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

  function bindUI() {
    // Werkzeug-Auswahl
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

    // Topbar Buttons
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
      }
    });

    document.getElementById("projectName").addEventListener("input", (e) => {
      state.name = e.target.value || "Unbenannt";
    });

    // Zoom & Snap
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

    // Auswahl-Aktionen
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
    });

    document.getElementById("btnFlipElement").addEventListener("click", () => {
      if (!selectedItem || selectedItem.kind !== "opening") return;
      const op = state.openings.find(o => o.id === selectedItem.id);
      if (op) {
        pushUndo();
        op.flip = (op.flip + 1) % 4;
        render();
      }
    });

    document.getElementById("btnEditLength").addEventListener("click", () => {
      if (!selectedItem) return;
      const modal = document.getElementById("lengthModal");
      const input = document.getElementById("inputCm");

      if (selectedItem.kind === "wall") {
        const w = state.walls.find(x => x.id === selectedItem.id);
        document.getElementById("lengthModalTitle").textContent = "Wandlänge exakt festlegen";
        input.value = Math.round(wallLengthCm(w));
      } else if (selectedItem.kind === "opening") {
        const op = state.openings.find(x => x.id === selectedItem.id);
        document.getElementById("lengthModalTitle").textContent =
          op.type === "door" ? "Türbreite festlegen" : "Fensterbreite festlegen";
        input.value = Math.round(op.widthCm);
      }
      modal.classList.remove("hidden");
      setTimeout(() => input.focus(), 50);
    });

    document.querySelectorAll("#quickPresets button").forEach(btn => {
      btn.addEventListener("click", () => {
        document.getElementById("inputCm").value = btn.dataset.cm;
      });
    });

    document.getElementById("btnCancelLength").addEventListener("click", () => {
      document.getElementById("lengthModal").classList.add("hidden");
    });

    document.getElementById("btnSaveLength").addEventListener("click", () => {
      const val = parseFloat(document.getElementById("inputCm").value);
      if (!val || val < 10) return;

      pushUndo();
      if (selectedItem.kind === "wall") {
        const w = state.walls.find(x => x.id === selectedItem.id);
        const curLen = wallLengthCm(w);
        if (curLen > 0) {
          const ratio = val / curLen;
          w.x2 = Math.round(w.x1 + (w.x2 - w.x1) * ratio);
          w.y2 = Math.round(w.y1 + (w.y2 - w.y1) * ratio);
        }
      } else if (selectedItem.kind === "opening") {
        const op = state.openings.find(x => x.id === selectedItem.id);
        op.widthCm = val;
      }

      document.getElementById("lengthModal").classList.add("hidden");
      selectElement(selectedItem);
      updateMetrics();
      render();
    });

    // Verlegemuster Modal
    document.querySelectorAll(".pattern-opt").forEach(btn => {
      btn.addEventListener("click", () => {
        pushUndo();
        state.pattern = btn.dataset.pattern;
        document.getElementById("patternModal").classList.add("hidden");
        render();
      });
    });

    document.getElementById("btnClosePattern").addEventListener("click", () => {
      document.getElementById("patternModal").classList.add("hidden");
    });

    // Notiz Modal
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
      }
      document.getElementById("noteModal").classList.add("hidden");
    });

    // Projekte & Export Modal
    document.getElementById("btnProjects").addEventListener("click", () => {
      refreshSavedList();
      document.getElementById("projectsModal").classList.remove("hidden");
    });

    document.getElementById("btnCloseProjects").addEventListener("click", () => {
      document.getElementById("projectsModal").classList.add("hidden");
    });

    document.getElementById("btnSaveLocal").addEventListener("click", () => {
      const list = getSavedProjects();
      const idx = list.findIndex(p => p.id === state.id);
      const copy = JSON.parse(JSON.stringify(state));
      copy.updatedAt = new Date().toLocaleDateString("de-AT");
      if (idx >= 0) list[idx] = copy;
      else list.unshift(copy);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
      refreshSavedList();
      alert("Projekt im Browser gespeichert!");
    });

    document.getElementById("btnNewProject").addEventListener("click", () => {
      state = {
        id: "proj_" + Date.now(),
        name: "Neuer Raum",
        walls: [],
        openings: [],
        notes: [],
        pattern: "none"
      };
      document.getElementById("projectName").value = state.name;
      undoStack = [];
      clearSelection();
      updateMetrics();
      centerView();
      render();
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
            state = data;
            document.getElementById("projectName").value = state.name || "Importierter Raum";
            undoStack = [];
            clearSelection();
            updateMetrics();
            centerView();
            render();
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
      div.innerHTML = `
        <div class="saved-item-info">
          <span class="saved-item-title">${proj.name}</span>
          <span class="saved-item-meta">${proj.walls.length} Wände · ${proj.updatedAt || ""}</span>
        </div>
        <div class="saved-item-actions">
          <button class="load-btn">Laden</button>
          <button class="del">✕</button>
        </div>
      `;
      div.querySelector(".load-btn").addEventListener("click", () => {
        state = JSON.parse(JSON.stringify(proj));
        document.getElementById("projectName").value = state.name;
        undoStack = [];
        clearSelection();
        updateMetrics();
        centerView();
        render();
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
