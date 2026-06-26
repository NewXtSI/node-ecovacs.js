import { buildShapes, transformPoint } from "./mapVisualizerSvg.js";

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function resolveTileProvider(value, options = {}) {
  const key = String(value || "osm").trim().toLowerCase();
  const mapboxToken = String(options.mapboxAccessToken || "").trim();
  const mapboxStyleId = String(options.mapboxStyleId || "mapbox/satellite-v9").trim();

  if (key === "none" || key === "off" || key === "blank") {
    return {
      name: "none",
      url: null,
      maxNativeZoom: 0,
      maxZoom: 23,
      attribution: ""
    };
  }

  if (key === "mapbox" || key === "mapboxsatellite" || key === "satellite") {
    if (mapboxToken) {
      return {
        name: "mapbox-satellite",
        url: `https://api.mapbox.com/styles/v1/mapbox/satellite-v9/tiles/256/{z}/{x}/{y}@2x?access_token=${mapboxToken}`,
        maxNativeZoom: 22,
        maxZoom: 23,
        attribution: "&copy; OpenStreetMap contributors &copy; Mapbox"
      };
    }
  }

  if (key === "mapboxstyle" || key === "mapbox-custom" || key === "mapboxstreets") {
    if (mapboxToken) {
      return {
        name: "mapbox-style",
        url: `https://api.mapbox.com/styles/v1/${mapboxStyleId}/tiles/256/{z}/{x}/{y}@2x?access_token=${mapboxToken}`,
        maxNativeZoom: 22,
        maxZoom: 23,
        attribution: "&copy; OpenStreetMap contributors &copy; Mapbox"
      };
    }
  }

  if (key === "voyager" || key === "cartovoyager") {
    return {
      name: "voyager",
      url: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
      maxNativeZoom: 20,
      maxZoom: 23,
      attribution: "&copy; OpenStreetMap contributors &copy; CARTO"
    };
  }

  if (key === "carto" || key === "cartopositron") {
    return {
      name: "carto",
      url: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
      maxNativeZoom: 20,
      maxZoom: 23,
      attribution: "&copy; OpenStreetMap contributors &copy; CARTO"
    };
  }

  if (key === "opentopo" || key === "opentopomap") {
    return {
      name: "opentopo",
      url: "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
      maxNativeZoom: 17,
      maxZoom: 20,
      attribution: "Map data: &copy; OpenStreetMap contributors, SRTM | Map style: &copy; OpenTopoMap (CC-BY-SA)"
    };
  }

  return {
    name: mapboxToken ? "osm" : "osm (no mapbox token)",
    url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    maxNativeZoom: 19,
    maxZoom: 23,
    attribution: "&copy; OpenStreetMap contributors"
  };
}

function extractAnchor(geolocation, goatPosition) {
  const latitude = Number(geolocation?.geoLocation?.latitude ?? geolocation?.latitude ?? NaN);
  const longitude = Number(geolocation?.geoLocation?.longitude ?? geolocation?.longitude ?? NaN);
  const goatX = Number(goatPosition?.x ?? NaN);
  const goatY = Number(goatPosition?.y ?? NaN);

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }

  if (!Number.isFinite(goatX) || !Number.isFinite(goatY)) {
    return null;
  }

  return {
    latitude,
    longitude,
    localAnchor: transformPoint({ x: goatX, y: goatY })
  };
}

function localToLatLon(point, anchor, metersPerUnit, rotationDeg) {
  const dx = (point.x - anchor.localAnchor.x) * metersPerUnit;
  const dy = (point.y - anchor.localAnchor.y) * metersPerUnit;

  const theta = (rotationDeg * Math.PI) / 180;
  const eastMeters = (dx * Math.cos(theta)) - (dy * Math.sin(theta));
  const northMeters = (dx * Math.sin(theta)) + (dy * Math.cos(theta));

  const latMeters = 111320;
  const lonMeters = 111320 * Math.cos((anchor.latitude * Math.PI) / 180);

  const latitude = anchor.latitude + (northMeters / latMeters);
  const longitude = anchor.longitude + (eastMeters / lonMeters);

  return [latitude, longitude];
}

function shapeToLeaflet(shape, anchor, metersPerUnit, rotationDeg) {
  const latlngs = shape.points.map((point) => {
    return localToLatLon(point, anchor, metersPerUnit, rotationDeg);
  });

  return {
    latlngs,
    color: shape.color,
    fillOpacity: shape.fillOpacity,
    strokeOpacity: shape.strokeOpacity,
    strokeWidth: shape.strokeWidth,
    title: `Entry ${shape.entryId}, Layer ${shape.layerId ?? "-"}, Id ${shape.polygonId ?? "-"}`
  };
}

function generateMapOsmHtml(mapInfoEntries, options = {}) {
  const arInfoEntries = Array.isArray(options.arInfo) ? options.arInfo : [];
  const geolocation = options.geolocation ?? null;
  const goatPosition = options.goatPosition ?? null;
  const metersPerUnit = toNumber(options.metersPerUnit, 0.001);
  const rotationDeg = toNumber(options.rotationDeg, 75);
  const disableBasemap = Boolean(options.disableBasemap);
  const disableInteraction = Boolean(options.disableInteraction);
  const tileProvider = resolveTileProvider(options.tileProvider, {
    mapboxAccessToken: options.mapboxAccessToken,
    mapboxStyleId: options.mapboxStyleId
  });

  const anchor = extractAnchor(geolocation, goatPosition);
  if (!anchor) {
    throw new Error("Cannot generate OSM map: missing geolocation or goatPosition anchor.");
  }

  const shapes = buildShapes(mapInfoEntries, arInfoEntries);
  const leafletShapes = shapes.map((shape) => {
    return shapeToLeaflet(shape, anchor, metersPerUnit, rotationDeg);
  });

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>GOAT Map (OSM)</title>
  <link
    rel="stylesheet"
    href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
    integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY="
    crossorigin=""
  />
  <style>
    html, body, #map { height: 100%; margin: 0; }
    .meta {
      position: absolute;
      top: 10px;
      right: 10px;
      z-index: 1000;
      background: rgba(255,255,255,0.9);
      border: 1px solid #ddd;
      padding: 8px;
      font: 12px/1.4 Arial, sans-serif;
    }
  </style>
</head>
<body>
  <div id="map"></div>
  <div class="meta">
    <div><strong>Anchor:</strong> ${anchor.latitude.toFixed(7)}, ${anchor.longitude.toFixed(7)}</div>
    <div><strong>Meters per unit:</strong> ${metersPerUnit}</div>
    <div><strong>Rotation:</strong> ${rotationDeg} deg</div>
    <div><strong>Tiles:</strong> ${tileProvider.name}</div>
    <div><strong>Shapes:</strong> ${leafletShapes.length}</div>
  </div>
  <script
    src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
    integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo="
    crossorigin=""
  ></script>
  <script>
    const map = L.map("map", {
      dragging: ${disableInteraction ? "false" : "true"},
      scrollWheelZoom: ${disableInteraction ? "false" : "true"},
      doubleClickZoom: ${disableInteraction ? "false" : "true"},
      boxZoom: ${disableInteraction ? "false" : "true"},
      keyboard: ${disableInteraction ? "false" : "true"},
      zoomControl: ${disableInteraction ? "false" : "true"},
      touchZoom: ${disableInteraction ? "false" : "true"}
    }).setView([${anchor.latitude}, ${anchor.longitude}], 20);

    if (!${disableBasemap ? "true" : "false"} && ${tileProvider.url ? "true" : "false"}) {
      L.tileLayer(${JSON.stringify(tileProvider.url)}, {
        maxNativeZoom: ${tileProvider.maxNativeZoom},
        maxZoom: ${tileProvider.maxZoom},
        attribution: ${JSON.stringify(tileProvider.attribution)}
      }).addTo(map);
    }

    const shapes = ${JSON.stringify(leafletShapes)};
    const layers = [];

    shapes.forEach((shape) => {
      const polygon = L.polygon(shape.latlngs, {
        color: shape.color,
        fillColor: shape.color,
        fillOpacity: shape.fillOpacity,
        opacity: shape.strokeOpacity,
        weight: Math.max(1, shape.strokeWidth / 8)
      }).bindTooltip(shape.title);
      polygon.addTo(map);
      layers.push(polygon);
    });

    const botMarker = L.circleMarker([${anchor.latitude}, ${anchor.longitude}], {
      radius: 6,
      color: "#0057ff",
      fillColor: "#0057ff",
      fillOpacity: 0.9,
      weight: 2
    }).bindTooltip("Bot anchor (geolocation + goatPosition)");
    botMarker.addTo(map);
    layers.push(botMarker);

    if (layers.length > 0) {
      const group = L.featureGroup(layers);
      map.fitBounds(group.getBounds().pad(0.1));
    }
  </script>
</body>
</html>
`;
}

export { generateMapOsmHtml };
