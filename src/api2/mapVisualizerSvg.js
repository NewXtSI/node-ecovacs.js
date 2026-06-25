/**
 * SVG Visualizer for Map Coordinates
 * Converts room/area coordinate data to SVG polygon visualization
 */

/**
 * Parse coordinate string format: "id;x1,y1;x2,y2;x3,y3;..."
 * @param {string} coordStr - Raw coordinate string
 * @returns {{id: string, points: Array<{x: number, y: number}>} | null}
 */
function parseCoordinates(coordStr) {
  if (!coordStr || typeof coordStr !== "string") return null;
  
  const parts = coordStr.split(";").filter(p => p.trim());
  if (parts.length < 2) return null;
  
  const id = parts[0];
  const points = [];
  
  for (let i = 1; i < parts.length; i++) {
    const [x, y] = parts[i].split(",").map(v => parseInt(v, 10));
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    points.push({ x, y });
  }
  
  return points.length > 0 ? { id, points } : null;
}

function getCoordinateSets(room, fallbackId) {
  if (!Array.isArray(room)) return [];

  const roomId = String(room[0] ?? fallbackId);
  const coordinateSets = [];

  for (let index = 1; index < room.length; index += 1) {
    const value = String(room[index] ?? "");
    const parsed = parseCoordinates(value);
    if (!parsed) continue;

    coordinateSets.push({
      roomId,
      coordinateType: parsed.id,
      sourceIndex: index,
      points: parsed.points,
      raw: value
    });
  }

  return coordinateSets;
}

function transformPoint(point) {
  return {
    x: point.x,
    y: -point.y
  };
}

function normalizeLayerEntries(entries, fallbackPrefix, color, fillOpacity, strokeOpacity, strokeWidth, labelPrefix = "") {
  if (!Array.isArray(entries)) return [];

  const shapes = [];

  entries.forEach((entry, entryIndex) => {
    if (!Array.isArray(entry)) return;

    const entryId = String(entry[0] ?? `${fallbackPrefix}-${entryIndex}`);
    const coordinateSets = getCoordinateSets(entry, `${fallbackPrefix}-${entryIndex}`);

    coordinateSets.forEach(({ points, sourceIndex, coordinateType }, setIndex) => {
      shapes.push({
        entryId,
        coordinateType,
        sourceIndex,
        setIndex,
        points: points.map(transformPoint),
        color,
        fillOpacity,
        strokeOpacity,
        strokeWidth,
        label: labelPrefix ? `${labelPrefix}${entryId}` : entryId
      });
    });
  });

  return shapes;
}

function parseArInfoEntries(arInfoEntries = []) {
  if (!Array.isArray(arInfoEntries)) return [];

  return arInfoEntries
    .map((entry, entryIndex) => {
      if (!Array.isArray(entry)) return null;

      const areaId = String(entry[0] ?? `area-${entryIndex}`);
      const layerId = String(entry[1] ?? "");
      const coordinateSets = getCoordinateSets(entry, `area-${entryIndex}`);

      return {
        areaId,
        layerId,
        polygons: coordinateSets.map(set => ({
          polygonId: String(set.coordinateType ?? ""),
          sourceIndex: set.sourceIndex,
          points: set.points.map(transformPoint)
        }))
      };
    })
    .filter(Boolean);
}

function buildShapes(mapInfoEntries, arInfoEntries = []) {
  const mapShapes = normalizeLayerEntries(mapInfoEntries, "room", getColorForId, 0.35, 1, 24);
  const resolvedMapShapes = mapShapes.map(shape => ({
    ...shape,
    color: typeof shape.color === "function" ? shape.color(shape.entryId) : shape.color
  }));

  // ArI layout inferred from logs: [areaId, layerId, polyA, polyB, ...]
  // layerId "1" contains mowing-area geometry (already covered by MI),
  // layerId "2"/"3" contain forbidden zones + obstacle polygons.
  const arShapes = parseArInfoEntries(arInfoEntries)
    .filter(entry => entry.layerId === "2" || entry.layerId === "3")
    .flatMap(entry => entry.polygons.map((polygon, polygonIndex) => ({
      entryId: entry.areaId,
      layerId: entry.layerId,
      polygonId: polygon.polygonId,
      sourceIndex: polygon.sourceIndex,
      setIndex: polygonIndex,
      points: polygon.points,
      color: "#ffd400",
      fillOpacity: 0.5,
      strokeOpacity: 0.95,
      strokeWidth: 18,
      label: ""
    })));

  return [...resolvedMapShapes, ...arShapes];
}

/**
 * Generate color for room ID (HSL-based, consistent per ID)
 * @param {string|number} roomId 
 * @returns {string} CSS color
 */
function getColorForId(roomId) {
  const idNum = parseInt(String(roomId), 10);
  if (!Number.isFinite(idNum)) {
    return "#808080"; // grey fallback
  }
  
  // Distribute hue across spectrum: 0=red, 120=green, 240=blue, 360=red
  const hue = (idNum * 137.5) % 360; // golden angle for nice distribution
  const saturation = 70;
  const lightness = 50;
  
  return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
}

/**
 * Calculate SVG viewBox and scaling
 * @param {Array<Array>} rooms - Decoded mapInfo rooms
 * @returns {{minX: number, maxX: number, minY: number, maxY: number, scale: number}}
 */
function calculateBounds(mapInfoEntries, arInfoEntries = []) {
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;

  buildShapes(mapInfoEntries, arInfoEntries).forEach(({ points }) => {
    points.forEach(pt => {
      minX = Math.min(minX, pt.x);
      maxX = Math.max(maxX, pt.x);
      minY = Math.min(minY, pt.y);
      maxY = Math.max(maxY, pt.y);
    });
  });
  
  if (!Number.isFinite(minX)) {
    return { minX: 0, maxX: 1000, minY: 0, maxY: 1000, scale: 1 };
  }
  
  const padding = 200;
  const width = maxX - minX + padding * 2;
  const height = maxY - minY + padding * 2;
  
  return {
    minX: minX - padding,
    maxX: maxX + padding,
    minY: minY - padding,
    maxY: maxY + padding,
    scale: 1
  };
}

/**
 * Generate SVG markup for room polygons
 * @param {Array<Array>} rooms - Decoded mapInfo rooms [[id, ...], ...]
 * @param {{ arInfo?: Array<Array> }} [options] - Optional overlay data
 * @returns {string} SVG markup
 */
function generateMapSvg(rooms, options = {}) {
  if (!Array.isArray(rooms) || rooms.length === 0) {
    return '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><text x="50" y="50" text-anchor="middle" fill="#999">No data</text></svg>';
  }

  const arInfo = Array.isArray(options.arInfo) ? options.arInfo : [];
  
  const bounds = calculateBounds(rooms, arInfo);
  const viewBoxWidth = bounds.maxX - bounds.minX;
  const viewBoxHeight = bounds.maxY - bounds.minY;
  
  let polygons = [];
  const shapes = buildShapes(rooms, arInfo);
  const polygonCount = shapes.length;

  shapes.forEach(({ entryId, layerId, polygonId, coordinateType, sourceIndex, setIndex, points, color, fillOpacity, strokeOpacity, strokeWidth, label }) => {
    const pointsStr = points.map(pt => `${pt.x},${pt.y}`).join(" ");
    const typeLabel = polygonId ?? coordinateType ?? "-";
    const layerLabel = layerId ?? "-";
    const labelText = String(label ?? "").trim();
    const textElement = labelText
      ? `    <text x="${points[0]?.x || 0}" y="${points[0]?.y || 0}" fill="black" font-size="160" font-weight="bold">${labelText}</text>\n`
      : "";
    polygons.push(
      `  <g>\n` +
      `    <title>Entry ID: ${entryId}, Layer: ${layerLabel}, Id: ${typeLabel}, Field: ${sourceIndex}, Polygon: ${setIndex + 1}</title>\n` +
      `    <polygon points="${pointsStr}" fill="${color}" fill-opacity="${fillOpacity}" stroke="${color}" stroke-opacity="${strokeOpacity}" stroke-width="${strokeWidth}" stroke-linejoin="round"/>\n` +
      `    <polyline points="${pointsStr}" fill="none" stroke="${color}" stroke-opacity="${strokeOpacity}" stroke-width="${strokeWidth + 8}" stroke-linejoin="round" stroke-linecap="round"/>\n` +
      textElement +
      `  </g>`
    );
  });
  
  const svg = 
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg viewBox="${bounds.minX} ${bounds.minY} ${viewBoxWidth} ${viewBoxHeight}" xmlns="http://www.w3.org/2000/svg" width="1200" height="900">\n` +
    `  <defs>\n` +
    `    <style>\n` +
    `      polygon { cursor: pointer; }\n` +
    `      polygon:hover { fill-opacity: 0.9; }\n` +
    `      text { pointer-events: none; font-family: Arial, sans-serif; }\n` +
    `    </style>\n` +
    `  </defs>\n` +
    `  <g id="rooms">\n` +
    polygons.join("\n") +
    `\n  </g>\n` +
    `  <text x="${bounds.minX + 50}" y="${bounds.minY + 150}" fill="#999" font-size="120">Map View (${rooms.length} MI entr${rooms.length === 1 ? "y" : "ies"}, ${arInfo.length} ArI entr${arInfo.length === 1 ? "y" : "ies"}, ${polygonCount} polygon${polygonCount === 1 ? "" : "s"})</text>\n` +
    `</svg>`;
  
  return svg;
}

export { parseCoordinates, getCoordinateSets, transformPoint, getColorForId, calculateBounds, generateMapSvg, buildShapes, parseArInfoEntries };
