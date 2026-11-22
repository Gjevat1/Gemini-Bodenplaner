(() => {
  // --- Konfiguration & Maßstab ---
  // 1 Einheit im Welt-Koordinatensystem = 1 cm (100 Einheiten = 1,00 m)
  const SNAP_STEP = 10; // 10 cm Rasterfang
  const GRID_MAJOR = 100; // 100 cm = 1 m
  const GRID_MINOR = 50;  // 50 cm = 0,5 m
  const STORAGE_KEY = "aufmass_planer_projects_v2";

  const canvas = document.getElementById("planCanvas");
  const ctx = canvas.getContext("2d");
  const wrapper = document.getElementById("canvasWrapper");

  // --- App-Zustand ---
  let state = {
    id: "proj_" + Date.now(),
    name: "Baustelle / Raum 1",
    defaultWallThickness: 25, // Standard-Wandstärke in cm (z. B. 12 cm Innenwand, 25/30/38 cm Außenwand)
    walls: [],     // { id, x1, y1, x2, y2, thicknessCm }
    openings: [],  // { id, type: 'door'|'window', wallId, t: 0..1, widthCm, flip: 0..3 }
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
  let isDrawing = false;
  let drawStart = null;
  let drawCurrent = null;
  let selectedItem = null; // { kind: 'wall'|'opening'|'note', id }
  let draggingOpening = null;
  let draggingNote = null;

  // Modal-Modus ('wallLength' | 'wallThickness' | 'defaultWallThickness' | 'openingWidth')
  let modalMode = null;

  // Pinch-Zoom & Pan
  let activePointers = new Map();
  let lastPinchDist = null;
  let lastPanCenter = null;

  // --- Initialisierung ---
  function init() {
    resizeCanvas();
    centerView();
    bindUI();
    updateHeaderInfo();
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
      defaultWallThickness: state.defaultWallThickness
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
    state.defaultWallThickness = prev.defaultWallThickness || 25;
    updateHeaderInfo();
    clearSelection();
    updateMetrics();
    render();
  }

  // --- Geometrie & Berechnungen ---
  function wallLengthCm(w) {
    return Math.hypot(w.x2 - w.x1, w.y2 - w.y1);
  }

  function getWallThickness(w) {
    return w.thicknessCm || state.defaultWallThickness || 25;
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

  // Geschlossene Polygon-Schleife aus Wänden erkennen
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
    return areaCm2 / 10000;
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

  // --- Zeichen-Engine (Doppellinien-Wände mit leerer Mitte & echten Laibungen/Nischen) ---
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

    // 1. Raumfläche & Verlegemuster
    const poly = findClosedPolygon();
    if (poly) {
      drawRoomFillAndPattern(poly);
    }

    // 2. Wände als hohle Doppellinien-Körper zeichnen
    // Zuerst das helle Wand-Innere aller Wände füllen (damit Ecken sauber verschmelzen),
    // danach die Außenkonturen (zwei parallele Linien) und Abschlusskappen zeichnen!
    for (const w of state.walls) {
      drawWallInterior(w);
    }
    for (const w of state.walls) {
      const isSel = selectedItem && selectedItem.kind === "wall" && selectedItem.id === w.id;
      drawWallOutline(w, isSel);
    }

    // Aktuelle Vorschau-Wand beim Zeichnen (ebenfalls als Doppellinie)
    if (isDrawing && drawStart && drawCurrent) {
      drawPreviewWall(drawStart, drawCurrent);
    }

    // 3. Türen & Fenster inkl. Wand-Laibungen (Nischen)
    for (const op of state.openings) {
      const wall = state.walls.find(w => w.id === op.wallId);
      if (!wall) continue;
      const isSel = selectedItem && selectedItem.kind === "opening" && selectedItem.id === op.id;
      drawOpeningWithReveal(op, wall, isSel);
    }

    // 4. Wand-Maß-Badges (über Wänden und Öffnungen lesbar)
    for (const w of state.walls) {
      const isSel = selectedItem && selectedItem.kind === "wall" && selectedItem.id === w.id;
      drawWallDimensionLabel(w, isSel);
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

  function drawRoomFillAndPattern(poly) {
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(poly[0].x, poly[0].y);
    for (let i = 1; i < poly.length; i++) {
      ctx.lineTo(poly[i].x, poly[i].y);
    }
    ctx.closePath();

    ctx.fillStyle = state.pattern === "none" ? "rgba(56, 189, 248, 0.10)" : "rgba(217, 119, 6, 0.11)";
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
        const plankW = 20;
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

  // Prüft, ob an einem Wand-Endpunkt eine weitere Wand anschließt (für saubere Ecken ohne Querstrich)
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

  // Füllt das Innere der Wand hell (weiß), damit der Zwischenraum zwischen den zwei Linien sauber leer bleibt
  function drawWallInterior(w) {
    const len = wallLengthCm(w);
    if (len < 1) return;
    const thick = getWallThickness(w);
    const angle = Math.atan2(w.y2 - w.y1, w.x2 - w.x1);

    ctx.save();
    ctx.translate(w.x1, w.y1);
    ctx.rotate(angle);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, -thick / 2, len, thick);
    ctx.restore();
  }

  // Zeichnet die zwei parallelen Wandlinien (leer in der Mitte) + Stirnseiten bei freien Wandenden
  function drawWallOutline(w, isSelected) {
    const len = wallLengthCm(w);
    if (len < 1) return;
    const thick = getWallThickness(w);
    const halfT = thick / 2;
    const angle = Math.atan2(w.y2 - w.y1, w.x2 - w.x1);
    const lineW = Math.max(2, 2.4 / view.scale);

    ctx.save();
    ctx.translate(w.x1, w.y1);
    ctx.rotate(angle);

    ctx.strokeStyle = isSelected ? "#f97316" : "#0f172a";
    ctx.lineWidth = lineW;
    ctx.lineCap = "square";

    // Die zwei parallelen Linien (oben und unten entlang der Wand)
    ctx.beginPath();
    ctx.moveTo(0, -halfT);
    ctx.lineTo(len, -halfT);
    ctx.moveTo(0, halfT);
    ctx.lineTo(len, halfT);
    ctx.stroke();

    // Stirnseite links/rechts nur schließen, wenn dort keine andere Wand anschließt
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

    // Bei ausgewählter Wand: dezente Fangpunkte an den Enden anzeigen
    if (isSelected) {
      ctx.fillStyle = "#f97316";
      const r = 5 / view.scale;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.arc(len, 0, r, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  function drawWallDimensionLabel(w, isSelected) {
    const len = wallLengthCm(w);
    if (len <= 15) return;
    const thick = getWallThickness(w);
    const mx = (w.x1 + w.x2) / 2;
    const my = (w.y1 + w.y2) / 2;
    const angle = Math.atan2(w.y2 - w.y1, w.x2 - w.x1);
    const offsetDist = thick / 2 + 16 / view.scale;
    const nx = -Math.sin(angle) * offsetDist;
    const ny = Math.cos(angle) * offsetDist;

    const label = isSelected
      ? `${formatMeters(len)} m (${thick} cm)`
      : `${formatMeters(len)} m`;

    drawDimensionBadge(label, mx + nx, my + ny, isSelected ? "#f97316" : "#1e293b");
  }

  function drawPreviewWall(p1, p2) {
    const len = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    if (len < 2) return;
    const thick = state.defaultWallThickness || 25;
    const halfT = thick / 2;
    const angle = Math.atan2(p2.y - p1.y, p2.x - p1.x);

    ctx.save();
    ctx.translate(p1.x, p1.y);
    ctx.rotate(angle);

    ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
    ctx.fillRect(0, -halfT, len, thick);

    ctx.strokeStyle = "#f97316";
    ctx.lineWidth = Math.max(2, 2.2 / view.scale);
    ctx.setLineDash([8 / view.scale, 6 / view.scale]);

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

    drawDimensionBadge(
      `${formatMeters(len)} m · ${thick} cm`,
      (p1.x + p2.x) / 2,
      (p1.y + p2.y) / 2 - (halfT + 18 / view.scale),
      "#ea580c"
    );
  }

  // Zeichnet Türen und Fenster mit klaren Laibungs-Linien (Nischen-Tiefe = Wandstärke!)
  function drawOpeningWithReveal(op, wall, isSelected) {
    const dx = wall.x2 - wall.x1;
    const dy = wall.y2 - wall.y1;
    const len = Math.hypot(dx, dy);
    if (len < 10) return;

    const thick = getWallThickness(wall);
    const halfT = thick / 2;
    const angle = Math.atan2(dy, dx);

    const cx = wall.x1 + dx * op.t;
    const cy = wall.y1 + dy * op.t;
    const halfW = op.widthCm / 2;
    const lineW = Math.max(2, 2.2 / view.scale);

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);

    // 1. Wandlinien im Bereich der Öffnung sauber unterbrechen (Nische freischneiden)
    ctx.fillStyle = "#f8fafc";
    ctx.fillRect(-halfW, -halfT - 3 / view.scale, op.widthCm, thick + 6 / view.scale);

    // 2. Laibungs-Linien (links und rechts die Nischentiefe über die volle Wandstärke schließen!)
    ctx.strokeStyle = isSelected ? "#f97316" : "#0f172a";
    ctx.lineWidth = lineW;
    ctx.beginPath();
    ctx.moveTo(-halfW, -halfT);
    ctx.lineTo(-halfW, halfT);
    ctx.moveTo(halfW, -halfT);
    ctx.lineTo(halfW, halfT);
    ctx.stroke();

    if (op.type === "door") {
      // Tür (oder Balkontür): Anschlag sitzt an der Innen- oder Außenkante der Wandnische!
      // flip: 0..3 steuert Bandseite (-halfW / +halfW) und Öffnungsrichtung (-halfT / +halfT)
      const dirSide = (op.flip % 2 === 0) ? 1 : -1; // +1 = öffnet nach +Y, -1 = öffnet nach -Y
      const hingeSide = (Math.floor(op.flip / 2) % 2 === 0) ? -1 : 1; // -1 = links, +1 = rechts

      const hingeX = hingeSide * halfW;
      const hingeY = dirSide * halfT; // Band sitzt direkt an der Nischen-Kante!

      // Dezente Boden-Linie der Türschwelle/Nische
      ctx.strokeStyle = "#cbd5e1";
      ctx.lineWidth = 1.2 / view.scale;
      ctx.setLineDash([4 / view.scale, 4 / view.scale]);
      ctx.beginPath();
      ctx.moveTo(-halfW, -hingeY);
      ctx.lineTo(halfW, -hingeY);
      ctx.stroke();
      ctx.setLineDash([]);

      // Türblatt
      ctx.strokeStyle = isSelected ? "#f97316" : "#0284c7";
      ctx.lineWidth = Math.max(2.5, 3 / view.scale);
      ctx.beginPath();
      ctx.moveTo(hingeX, hingeY);
      ctx.lineTo(hingeX, hingeY + dirSide * op.widthCm);
      ctx.stroke();

      // Drehkreis (90° Bogen)
      ctx.setLineDash([5 / view.scale, 5 / view.scale]);
      ctx.lineWidth = 1.6 / view.scale;
      ctx.beginPath();
      if (hingeSide < 0) {
        ctx.arc(hingeX, hingeY, op.widthCm, dirSide > 0 ? 0 : -Math.PI / 2, dirSide > 0 ? Math.PI / 2 : 0);
      } else {
        ctx.arc(hingeX, hingeY, op.widthCm, dirSide > 0 ? Math.PI / 2 : Math.PI, dirSide > 0 ? Math.PI : 1.5 * Math.PI);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    } else {
      // Fenster / Balkon-Fixverglasung mit sichtbarer Fensterbank/Nische innen & außen
      // Außenkanten-Linie der Fensterbank (dünn)
      ctx.strokeStyle = "#94a3b8";
      ctx.lineWidth = 1.2 / view.scale;
      ctx.beginPath();
      ctx.moveTo(-halfW, -halfT);
      ctx.lineTo(halfW, -halfT);
      ctx.moveTo(-halfW, halfT);
      ctx.lineTo(halfW, halfT);
      ctx.stroke();

      // Fensterrahmen & Glasscheibe in der Mitte der Nische
      const frameH = Math.min(10, thick * 0.35);
      ctx.strokeStyle = isSelected ? "#f97316" : "#0284c7";
      ctx.lineWidth = Math.max(1.8, 2 / view.scale);
      ctx.strokeRect(-halfW, -frameH / 2, op.widthCm, frameH);

      // Glaslinie mittig
      ctx.beginPath();
      ctx.moveTo(-halfW, 0);
      ctx.lineTo(halfW, 0);
      ctx.stroke();
    }

    ctx.restore();

    // Breiten-Label
    drawDimensionBadge(`${Math.round(op.widthCm)} cm`, cx, cy - (halfT + 16 / view.scale), isSelected ? "#f97316" : "#0284c7");
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
    const baseHit = 22 / view.scale;

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
      const hitRadius = Math.max(baseHit, op.widthCm / 2, getWallThickness(wall) / 2 + 8);
      if (Math.hypot(wx - ox, wy - oy) < hitRadius) {
        return { kind: "opening", id: op.id };
      }
    }

    // 3. Wände prüfen (berücksichtigt die jeweilige Wandstärke)
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
      label.textContent = `Wand: ${formatMeters(wallLengthCm(w))} m · ${thick} cm`;
      btnEditLen.textContent = "📏 Länge";
      btnEditLen.style.display = "inline-block";
      btnEditThick.style.display = "inline-block";
      btnFlip.style.display = "none";
    } else if (item.kind === "opening") {
      const op = state.openings.find(x => x.id === item.id);
      label.textContent = `${op.type === "door" ? "Tür" : "Fenster"}: ${Math.round(op.widthCm)} cm`;
      btnEditLen.textContent = "📏 Breite";
      btnEditLen.style.display = "inline-block";
      btnEditThick.style.display = "none";
      btnFlip.style.display = op.type === "door" ? "inline-block" : "none";
    } else if (item.kind === "note") {
      label.textContent = "Raum-Notiz";
      btnEditLen.style.display = "none";
      btnEditThick.style.display = "none";
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
          y2: drawCurrent.y,
          thicknessCm: state.defaultWallThickness
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

    // Standard-Wandstärke einstellen (oben in der Leiste)
    document.getElementById("btnWallSettings").addEventListener("click", () => {
      openNumberModal({
        mode: "defaultWallThickness",
        title: "Standard-Wandstärke",
        hint: "Wandstärke für neu gezeichnete Wände (cm):",
        currentVal: state.defaultWallThickness,
        presets: [10, 12, 15, 20, 25, 30, 38]
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
          presets: [70, 80, 90, 100, 120, 160, 200]
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
        defaultWallThickness: state.defaultWallThickness || 25,
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
            if (!state.defaultWallThickness) state.defaultWallThickness = 25;
            document.getElementById("projectName").value = state.name || "Importierter Raum";
            updateHeaderInfo();
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
        if (!state.defaultWallThickness) state.defaultWallThickness = 25;
        document.getElementById("projectName").value = state.name;
        updateHeaderInfo();
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
