import { readFile } from "node:fs/promises";
import { Api2Factory } from "./src/api2/index.js";
import { writeFile } from "node:fs/promises";
import { getCoordinateSets } from "./src/api2/mapVisualizerSvg.js";
import { generateMapOsmHtml } from "./src/api2/mapVisualizerOsmHtml.js";

let runtimeFactory = null;

const RUN_SETTER_TESTS = ["1", "true", "yes", "on"].includes(
  String(process.env.API2_RUN_SETTER_TESTS || "").trim().toLowerCase()
);

const RUN_MOW_FLOW_TEST = ["1", "true", "yes", "on"].includes(
  String(process.env.API2_RUN_MOW_FLOW_TEST || "").trim().toLowerCase()
);

const MOW_FLOW_WAIT_SECONDS = (() => {
  const parsed = Number(process.env.API2_MOW_FLOW_WAIT_SECONDS);
  if (!Number.isFinite(parsed)) return 5;
  return Math.max(0, parsed);
})();

const LOG_POS_PAYLOADS = !["0", "false", "no", "off"].includes(
  String(process.env.API2_LOG_POS_PAYLOADS || "1").trim().toLowerCase()
);

const LOG_AREASET_PAYLOADS = !["0", "false", "no", "off"].includes(
  String(process.env.API2_LOG_AREASET_PAYLOADS || "1").trim().toLowerCase()
);

const LOG_MAPAR_PAYLOADS = !["0", "false", "no", "off"].includes(
  String(process.env.API2_LOG_MAPAR_PAYLOADS || "1").trim().toLowerCase()
);

const LOG_MAPINFO_PAYLOADS = !["0", "false", "no", "off"].includes(
  String(process.env.API2_LOG_MAPINFO_PAYLOADS || "1").trim().toLowerCase()
);
const LOG_MAP_DETAILS = ["1", "true", "yes", "on"].includes(
  String(process.env.API2_LOG_MAP_DETAILS || "0").trim().toLowerCase()
);
const LOG_STATE_DETAILS = ["1", "true", "yes", "on"].includes(
  String(process.env.API2_LOG_STATE_DETAILS || "0").trim().toLowerCase()
);
const LOG_STATE_SUMMARY = !LOG_STATE_DETAILS && !["0", "false", "no", "off"].includes(
  String(process.env.API2_LOG_STATE_SUMMARY || "1").trim().toLowerCase()
);

const LISTEN_SECONDS = (() => {
  const parsed = Number(process.env.API2_LISTEN_SECONDS);
  if (!Number.isFinite(parsed)) return 30;
  return Math.max(0, parsed);
})();

const REQUEST_ARINFO = ["1", "true", "yes", "on"].includes(
  String(process.env.API2_REQUEST_ARINFO || process.env.API2_REQUEST_MAPINFO || "1").trim().toLowerCase()
);

const REQUEST_MAPINFO = ["1", "true", "yes", "on"].includes(
  String(process.env.API2_REQUEST_MAPINFO || "1").trim().toLowerCase()
);

const MAPINFO_REQUEST_TYPE = String(process.env.API2_REQUEST_MAPINFO_TYPE || "0").trim() || "0";
const ARINFO_REQUEST_TYPE = String(process.env.API2_REQUEST_ARINFO_TYPE || "0").trim() || "0";
const EXPORT_OSM_HTML = ["1", "true", "yes", "on"].includes(
  String(process.env.API2_EXPORT_OSM_HTML || "0").trim().toLowerCase()
);
const OSM_METERS_PER_UNIT = Number(process.env.API2_OSM_METERS_PER_UNIT || "0.001");
const OSM_ROTATION_DEG = Number(process.env.API2_OSM_ROTATION_DEG || "75");
const OSM_TILE_PROVIDER = String(process.env.API2_OSM_TILE_PROVIDER || "osm").trim().toLowerCase();
const MAPBOX_ACCESS_TOKEN = String(process.env.API2_MAPBOX_ACCESS_TOKEN || "").trim();
const MAPBOX_STYLE_ID = String(process.env.API2_MAPBOX_STYLE_ID || "mapbox/satellite-v9").trim();
const OSM_DISABLE_BASEMAP = ["1", "true", "yes", "on"].includes(
  String(process.env.API2_OSM_DISABLE_BASEMAP || "0").trim().toLowerCase()
);
const OSM_DISABLE_INTERACTION = ["1", "true", "yes", "on"].includes(
  String(process.env.API2_OSM_DISABLE_INTERACTION || "0").trim().toLowerCase()
);

async function loadCredentials() {
  const raw = await readFile("./credentials.json", "utf8");
  const parsed = JSON.parse(raw);

  const user = parsed.email || parsed.accountId || parsed.user;
  const password = parsed.password || null;
  const passwordHash = parsed.passwordHash || null;

  if (!user || (!password && !passwordHash)) {
    throw new Error("credentials.json requires email/accountId/user and password or passwordHash.");
  }

  return {
    user,
    password,
    passwordHash,
    country: parsed.country || "DE",
    continent: parsed.continent || null,
    deviceId: parsed.deviceId || null,
    overrideMqttUrl: parsed.overrideMqttUrl || null
  };
}

function waitForEvent(target, eventName, timeoutMs = 7000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      target.off(eventName, onEvent);
      reject(new Error(`Timeout waiting for event '${eventName}'`));
    }, timeoutMs);

    const onEvent = (data) => {
      clearTimeout(timeout);
      resolve(data);
    };

    target.once(eventName, onEvent);
  });
}

function deepEqual(a, b) {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function toNumberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function summarizeStateValue(value) {
  if (value === null || typeof value === "undefined") return "null";
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value !== "object") return String(value);

  const preferredKeys = [
    "state", "status", "mode", "trigger", "type", "progress", "enable", "result",
    "online", "isCharging", "value", "level", "volume", "left", "tm", "isSet", "expandState"
  ];
  const parts = preferredKeys
    .filter((key) => Object.prototype.hasOwnProperty.call(value, key))
    .slice(0, 5)
    .map((key) => `${key}=${value[key]}`);

  if (parts.length > 0) {
    return `{${parts.join(", ")}}`;
  }

  const keys = Object.keys(value);
  return `object(${keys.length} keys)`;
}

function logStateEvent(deviceName, stateName, data) {
  if (LOG_STATE_DETAILS) {
    console.log(`[${deviceName}] ${stateName}:`, data);
    return;
  }

  if (LOG_STATE_SUMMARY) {
    console.log(`[${deviceName}] ${stateName}: ${summarizeStateValue(data)}`);
  }
}

async function ensureCurrentState(device, getter, eventName, requestCommand = null) {
  let value = getter();
  if (value && typeof value === "object") {
    return value;
  }

  if (requestCommand) {
    await device.sendCommand(requestCommand);
  }

  value = await waitForEvent(device, eventName, 7000);
  return value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runSetterRoundtrip({
  device,
  label,
  eventName,
  getter,
  requestCommand,
  setter,
  buildTarget,
  timeoutMs = 7000
}) {
  const before = await ensureCurrentState(device, getter, eventName, requestCommand);
  const target = buildTarget(before);

  if (!target || typeof target !== "object") {
    throw new Error(`${label}: target payload is invalid (${JSON.stringify(target)})`);
  }

  if (deepEqual(before, target)) {
    throw new Error(`${label}: target equals current value, no effective change to test.`);
  }

  console.log(`[setter:${label}] before:`, before);
  console.log(`[setter:${label}] target:`, target);

  await setter(target);
  const afterSet = await waitForEvent(device, eventName, timeoutMs);
  console.log(`[setter:${label}] after set:`, afterSet);

  await setter(before);
  const afterRestore = await waitForEvent(device, eventName, timeoutMs);
  console.log(`[setter:${label}] after restore:`, afterRestore);
}

async function main() {
  const credentials = await loadCredentials();

  const factory = new Api2Factory({
    user: credentials.user,
    password: credentials.password,
    passwordHash: credentials.passwordHash,
    country: credentials.country,
    continent: credentials.continent,
    deviceId: credentials.deviceId,
    overrideMqttUrl: credentials.overrideMqttUrl,
    debugFlags: {
      connection: true,
      auth: true,
      devices: true
    }
  });
  runtimeFactory = factory;

  await factory.connect();
  console.log("Factory status after connect =", factory.getConnectionStatus());

  let goatDevices;
  try {
    goatDevices = await factory.getGoatDevices();
  } catch (error) {
    console.error("Factory status after getGoatDevices failure =", factory.getConnectionStatus());
    throw error;
  }
  console.log(`Found ${goatDevices.length} GOATBOT device(s):`);

  for (const device of goatDevices) {
    let latestArInfo = null;
    let latestMapInfo = null;
    let latestGeoLocation = null;
    let latestGoatPosition = null;
    let latestValidGoatPosition = null;
    let lastSavedGoatMapFingerprint = null;
    let lastSavedDeviceMapFingerprint = null;
    const snapshotTimestampByFingerprint = new Map();

    const timestampForFingerprint = (fingerprint) => {
      if (!fingerprint) {
        return new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
      }
      const known = snapshotTimestampByFingerprint.get(fingerprint);
      if (known) return known;
      const created = new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
      snapshotTimestampByFingerprint.set(fingerprint, created);
      return created;
    };
    const writeGoatMapSnapshot = (goatMapPayload) => {
      if (!goatMapPayload || typeof goatMapPayload.svg !== "string" || goatMapPayload.svg.length === 0) {
        return;
      }

      if (goatMapPayload.fingerprint && goatMapPayload.fingerprint === lastSavedGoatMapFingerprint) {
        return;
      }

      (async () => {
        try {
          const timestamp = timestampForFingerprint(goatMapPayload.fingerprint);
          const filename = `map_visualization_${timestamp}.svg`;
          await writeFile(filename, goatMapPayload.svg, "utf8");
          if (goatMapPayload.fingerprint) {
            lastSavedGoatMapFingerprint = goatMapPayload.fingerprint;
          }
          console.log(`[${device.name}] SVG saved: ${filename}`);

          if (EXPORT_OSM_HTML) {
            const anchorGoatPosition = latestValidGoatPosition ?? latestGoatPosition;
            if (latestGeoLocation && anchorGoatPosition) {
              const osmHtml = generateMapOsmHtml(goatMapPayload.mapInfo, {
                arInfo: goatMapPayload.arInfo,
                geolocation: latestGeoLocation,
                goatPosition: anchorGoatPosition,
                metersPerUnit: Number.isFinite(OSM_METERS_PER_UNIT) ? OSM_METERS_PER_UNIT : 0.001,
                rotationDeg: Number.isFinite(OSM_ROTATION_DEG) ? OSM_ROTATION_DEG : 75,
                tileProvider: OSM_TILE_PROVIDER,
                mapboxAccessToken: MAPBOX_ACCESS_TOKEN,
                mapboxStyleId: MAPBOX_STYLE_ID,
                disableBasemap: OSM_DISABLE_BASEMAP,
                disableInteraction: OSM_DISABLE_INTERACTION
              });
              const htmlFile = `map_visualization_${timestamp}.html`;
              await writeFile(htmlFile, osmHtml, "utf8");
              console.log(`[${device.name}] OSM HTML saved: ${htmlFile}`);
            } else {
              console.log(`[${device.name}] OSM HTML pending: waiting for geolocation and/or goatPosition anchor.`);
            }
          }
        } catch (err) {
          console.error(`[${device.name}] SVG generation failed:`, err.message);
        }
      })();
    };

    const writeDeviceMapSnapshot = (deviceMapPayload, goatMapFingerprint = null) => {
      if (!deviceMapPayload || typeof deviceMapPayload.svg !== "string" || deviceMapPayload.svg.length === 0) {
        return;
      }

      if (deviceMapPayload.fingerprint && deviceMapPayload.fingerprint === lastSavedDeviceMapFingerprint) {
        return;
      }

      (async () => {
        try {
          const timestamp = timestampForFingerprint(goatMapFingerprint || deviceMapPayload.fingerprint);
          const filename = `deviceMap_visualization_${timestamp}.svg`;
          await writeFile(filename, deviceMapPayload.svg, "utf8");
          if (deviceMapPayload.fingerprint) {
            lastSavedDeviceMapFingerprint = deviceMapPayload.fingerprint;
          }
          console.log(`[${device.name}] deviceMap SVG saved: ${filename}`);
        } catch (err) {
          console.error(`[${device.name}] deviceMap SVG generation failed:`, err.message);
        }
      })();
    };

    console.log({
      id: device.id,
      name: device.name,
      nickName: device.nickName,
      className: device.className,
      productCategory: device.productCategory,
      isConnected: device.isConnected
    });

    // Connect first — wires _requestData → DeviceCommander and subscribes MQTT.
    await factory.connectDevice(device);

    // Subscribe after connecting so the lazy-load request has a commander to use.
    device.on("stats", (data) => {
      logStateEvent(device.name, "stats", data);
    });

    device.on("lastTimeStats", (data) => {
      logStateEvent(device.name, "lastTimeStats", data);
    });

    device.on("totalStats", (data) => {
      logStateEvent(device.name, "totalStats", data);
    });

    device.on("battery", (data) => {
      logStateEvent(device.name, "battery", data);
    });

    device.on("goatPosition", (data) => {
      latestGoatPosition = data;
      if (data && Number(data.invalid) === 0) {
        latestValidGoatPosition = data;
      }
      logStateEvent(device.name, "goatPosition", data);
    });

    device.on("chargePosition", (data) => {
      logStateEvent(device.name, "chargePosition", data);
    });

    device.on("rtkPosition", (data) => {
      logStateEvent(device.name, "rtkPosition", data);
    });

    device.on("rtk", (data) => {
      logStateEvent(device.name, "rtk", data);
    });

    if (LOG_POS_PAYLOADS) {
      device.on("_rawPosPayload", ({ topicName, data }) => {
        console.log(`[${device.name}] POS RAW ${topicName}:`, data);
      });

      device.on("_rawAreaParameterPayload", ({ topicName, data }) => {
        console.log(`[${device.name}] AREA PARAM RAW ${topicName}:`, JSON.stringify(data, null, 2));
      });
    }

    if (LOG_AREASET_PAYLOADS) {
      device.on("_rawAreaSetPayload", ({ topicName, direction, fullTopic, rawPayload }) => {
        console.log(`[${device.name}] AREASET RAW [${direction}] ${topicName}`);
        console.log(`  topic: ${fullTopic}`);
        console.log(`  payload: ${JSON.stringify(rawPayload?.body ?? rawPayload, null, 2)}`);
      });
    }

    if (LOG_MAPAR_PAYLOADS) {
      device.on("_rawMapArPayload", ({ topicName, direction, fullTopic, rawPayload }) => {
        console.log(`[${device.name}] MAPAR RAW [${direction}] ${topicName}`);
        console.log(`  topic: ${fullTopic}`);
        console.log(`  payload: ${JSON.stringify(rawPayload?.body ?? rawPayload, null, 2)}`);
      });
    }



    device.on("chargeState", (data) => {
      logStateEvent(device.name, "chargeState", data);
    });

    device.on("chargeInfo", (data) => {
      logStateEvent(device.name, "chargeInfo", data);
    });

    device.on("charge", (event) => {
      const command = event?.command ?? null;
      const payload = event?.data ?? null;
      if (LOG_STATE_DETAILS) {
        console.log(`[${device.name}] charge command:`, { command });
        console.log(`  payload: ${JSON.stringify(payload, null, 2)}`);
      } else if (LOG_STATE_SUMMARY) {
        console.log(`[${device.name}] charge command: ${command ?? "unknown"}`);
      }
    });

    device.on("mowInfo", (data) => {
      logStateEvent(device.name, "mowInfo", data);
    });

    device.on("mowCommand", (data) => {
      console.log(`[${device.name}] mowCommand:`, {
        command: data?.command ?? null,
        type: data?.type ?? null,
        value: data?.value ?? null
      });
      console.log(`  payload: ${JSON.stringify(data?.data ?? data, null, 2)}`);
    });

    device.on("geolocation", (data) => {
      latestGeoLocation = data;
      logStateEvent(device.name, "geolocation", data);
    });

    device.on("goatMap", (payload) => {
      const mapInfoCount = Array.isArray(payload?.mapInfo) ? payload.mapInfo.length : 0;
      const arInfoCount = Array.isArray(payload?.arInfo) ? payload.arInfo.length : 0;
      console.log(`[${device.name}] goatMap ready: mapInfo=${mapInfoCount}, arInfo=${arInfoCount}`);
      writeGoatMapSnapshot(payload);

      // When goatMap updates, try writing deviceMap too (same bbox/timestamp group).
      const deviceMap = device.getDeviceMap();
      if (deviceMap) {
        writeDeviceMapSnapshot(deviceMap, payload?.fingerprint ?? null);
      }
    });

    // Alias event for explicit internal hook naming requested by user.
    device.on("onGoatMap", (payload) => {
      const mapInfoCount = Array.isArray(payload?.mapInfo) ? payload.mapInfo.length : 0;
      const arInfoCount = Array.isArray(payload?.arInfo) ? payload.arInfo.length : 0;
      console.log(`[${device.name}] onGoatMap: mapInfo=${mapInfoCount}, arInfo=${arInfoCount}`);
    });

    device.on("deviceMap", (payload) => {
      console.log(`[${device.name}] deviceMap ready`);
      writeDeviceMapSnapshot(payload, device.getGoatMap()?.fingerprint ?? null);
    });

    device.on("onDeviceMap", (payload) => {
      const hasViewBox = payload?.viewBox ? "yes" : "no";
      console.log(`[${device.name}] onDeviceMap: viewBox=${hasViewBox}`);
    });

    device.on("protectState", (data) => {
      logStateEvent(device.name, "protectState", data);
    });

    device.on("netInfo", (data) => {
      logStateEvent(device.name, "netInfo", data);
    });

    device.on("networkSwitch", (data) => {
      logStateEvent(device.name, "networkSwitch", data);
    });

    device.on("ota", (data) => {
      logStateEvent(device.name, "ota", data);
    });

    device.on("rtkOta", (data) => {
      logStateEvent(device.name, "rtkOta", data);
    });

    device.on("mapState", (data) => {
      logStateEvent(device.name, "mapState", data);
    });

    device.on("pin", (data) => {
      logStateEvent(device.name, "pin", data);
    });

    device.on("breakPointStatus", (data) => {
      logStateEvent(device.name, "breakPointStatus", data);
    });

    device.on("moveCtrlState", (data) => {
      logStateEvent(device.name, "moveCtrlState", data);
    });

    device.on("robotFeature", (data) => {
      logStateEvent(device.name, "robotFeature", data);
    });

    device.on("moveupWarning", (data) => {
      logStateEvent(device.name, "moveupWarning", data);
    });

    device.on("crossMapBorderWarning", (data) => {
      logStateEvent(device.name, "crossMapBorderWarning", data);
    });

    device.on("relocationState", (data) => {
      logStateEvent(device.name, "relocationState", data);
    });

    device.on("scheduleTaskInfo", (data) => {
      logStateEvent(device.name, "scheduleTaskInfo", data);
    });

    device.on("scheduleLatestTask", (data) => {
      logStateEvent(device.name, "scheduleLatestTask", data);
    });

    device.on("sleep", (data) => {
      logStateEvent(device.name, "sleep", data);
    });

    device.on("error", (data) => {
      logStateEvent(device.name, "error", data);
    });

    device.on("lifeSpan", (data) => {
      logStateEvent(device.name, "lifeSpan", data);
    });

    device.on("volume", (data) => {
      logStateEvent(device.name, "volume", data);
    });

    device.on("cutDirection", (data) => {
      logStateEvent(device.name, "cutDirection", data);
    });

    device.on("cutHeight", (data) => {
      logStateEvent(device.name, "cutHeight", data);
    });

    device.on("obstacleHeight", (data) => {
      logStateEvent(device.name, "obstacleHeight", data);
    });

    device.on("cutEfficiency", (data) => {
      logStateEvent(device.name, "cutEfficiency", data);
    });

    device.on("autoCutDirection", (data) => {
      logStateEvent(device.name, "autoCutDirection", data);
    });

    device.on("rainDelay", (data) => {
      logStateEvent(device.name, "rainDelay", data);
    });

    device.on("animProtect", (data) => {
      logStateEvent(device.name, "animProtect", data);
    });

    device.on("timeZone", (data) => {
      logStateEvent(device.name, "timeZone", data);
    });

    device.on("customCutMode", (data) => {
      logStateEvent(device.name, "customCutMode", data);
    });

    device.on("borderSwitch", (data) => {
      logStateEvent(device.name, "borderSwitch", data);
    });

    device.on("areaParameters", (data) => {
      console.log(`[${device.name}] areaParameters (${data?.length ?? 0} areas):`, data);
    });

    device.on("areaSet", (data) => {
      console.log(`[${device.name}] areaSet:`);
      console.log(`  ar (${data?.ar?.length ?? 0} areas):`, data?.ar);
      console.log(`  vw (${data?.vw?.length ?? 0} virtual walls):`, data?.vw);
      console.log(`  nc (${data?.nc?.length ?? 0} no-go zones):`, data?.nc);
    });

    device.on("mapAr", (data) => {
      const decoded = data?.decoded;
      const decodedKind = Array.isArray(decoded) ? "array" : typeof decoded;
      const decodedCount = Array.isArray(decoded) ? decoded.length : null;
      console.log(`[${device.name}] mapAr:`, {
        mapSetType: data?.mapSetType ?? null,
        serial: data?.serial ?? null,
        infoSize: data?.infoSize ?? null,
        decodedKind,
        decodedCount
      });
      console.log(`[${device.name}] mapAr decoded:`, decoded);
    });

    device.on("arInfo", (data) => {
      const decoded = data?.decoded;
      if (Array.isArray(decoded)) {
        latestArInfo = decoded;
        console.log(`[${device.name}] arInfo: ${decoded.length} area(s)`);
        if (LOG_MAP_DETAILS) {
          decoded.forEach((area, idx) => {
            if (Array.isArray(area)) {
              const coordinateSets = getCoordinateSets(area, `area-${idx}`);
              const areaId = String(area[0] ?? "?");
              const layer = String(area[1] ?? "?");
              const ids = [...new Set(coordinateSets.map(set => set.coordinateType))].join(",");
              const areaStr = area.map(s => String(s).substring(0, 30)).join(" | ");
              console.log(`  [${idx}] areaId=${areaId}, layer=${layer}, polygons=${coordinateSets.length}, ids=[${ids}], ${areaStr}...`);
            } else {
              console.log(`  [${idx}] ${String(area).substring(0, 30)}...`);
            }
          });
        }
      } else {
        console.log(`[${device.name}] arInfo:`, decoded ?? data);
      }
    });

    device.on("mapInfo", (data) => {
      const decoded = data?.decoded;
      if (Array.isArray(decoded)) {
        latestMapInfo = decoded;
        console.log(`[${device.name}] mapInfo: ${decoded.length} room(s)/zone(s)`);
        if (LOG_MAP_DETAILS) {
          decoded.forEach((room, idx) => {
            if (Array.isArray(room)) {
              const roomId = room[0];
              const coordinateSets = getCoordinateSets(room, `room-${idx}`);
              const fieldPreview = room
                .slice(1)
                .map((value, fieldIdx) => `f${fieldIdx + 1}=${String(value).substring(0, 40)}`)
                .join(" | ");
              console.log(`  [${idx}] id=${roomId}, polygons=${coordinateSets.length}, ${fieldPreview}...`);
            } else {
              console.log(`  [${idx}] ${String(room).substring(0, 80)}...`);
            }
          });
        }
      } else {
        console.log(`[${device.name}] mapInfo:`, decoded ?? data);
      }
    });

    device.on("fwBuryPoint", ({ substate, payload, meta }) => {
      if (LOG_STATE_DETAILS) {
        console.log(`[${device.name}] fwBuryPoint: ${substate}`);
        if (meta) {
          console.log(`  meta: ${JSON.stringify(meta)}`);
        }
        console.log(`  payload: ${JSON.stringify(payload, null, 2)}`);
      } else if (LOG_STATE_SUMMARY) {
        console.log(`[${device.name}] fwBuryPoint: ${substate} ${meta ? `(meta gid=${meta.gid ?? "-"}, idx=${meta.index ?? "-"})` : ""}`);
      }
    });

    device.on("topicBacklog", ({ topicName, data }) => {
      if (LOG_STATE_DETAILS) {
        console.log(`[${device.name}] topicBacklog: ${topicName}`);
        console.log(`  data: ${JSON.stringify(data, null, 2)}`);
      } else if (LOG_STATE_SUMMARY) {
        console.log(`[${device.name}] topicBacklog: ${topicName} ${summarizeStateValue(data)}`);
      }
    });

    device.on("unknownTopic", ({ topicName, data, error }) => {
      if (LOG_STATE_DETAILS) {
        console.log(`[${device.name}] unknownTopic: ${topicName}`);
        if (error) {
          console.log(`  error: ${error}`);
        }
        console.log(`  data: ${JSON.stringify(data, null, 2)}`);
      } else if (LOG_STATE_SUMMARY) {
        console.log(`[${device.name}] unknownTopic: ${topicName} ${summarizeStateValue(data)}${error ? ` error=${error}` : ""}`);
      }
    });

    // Explicitly call all getters.
    console.log("getStats() =", device.getStats());
    console.log("getLastTimeStats() =", device.getLastTimeStats());
    console.log("getTotalStats() =", device.getTotalStats());
    console.log("getBattery() =", device.getBattery());
    console.log("getGoatPosition() =", device.getGoatPosition());
    console.log("getChargePosition() =", device.getChargePosition());
    console.log("getRtkPosition() =", device.getRtkPosition());
    console.log("getRtk() =", device.getRtk());
    console.log("getChargeState() =", device.getChargeState());
    console.log("getChargeInfo() =", device.getChargeInfo());
    console.log("getMowInfo() =", device.getMowInfo());
    console.log("getMowState() =", device.getMowState());
    console.log("getMowCommand() =", device.getMowCommand());
    console.log("getGeolocation() =", device.getGeolocation());
    console.log("getProtectState() =", device.getProtectState());
    console.log("getNetInfo() =", device.getNetInfo());
    console.log("getNetworkSwitch() =", device.getNetworkSwitch());
    console.log("getOta() =", device.getOta());
    console.log("getRtkOta() =", device.getRtkOta());
    console.log("getMapState() =", device.getMapState());
    console.log("getPin() =", device.getPin());
    console.log("getBreakPointStatus() =", device.getBreakPointStatus());
    console.log("getMoveCtrlState() =", device.getMoveCtrlState());
    console.log("getRobotFeature() =", device.getRobotFeature());
    console.log("getMoveupWarning() =", device.getMoveupWarning());
    console.log("getCrossMapBorderWarning() =", device.getCrossMapBorderWarning());
    console.log("getRelocationState() =", device.getRelocationState());
    console.log("getScheduleTaskInfo() =", device.getScheduleTaskInfo());
    console.log("getScheduleLatestTask() =", device.getScheduleLatestTask());
    console.log("getSleep() =", device.getSleep());
    console.log("getError() =", device.getError());
    console.log("getLifeSpan() =", device.getLifeSpan());
    console.log("getVolume() =", device.getVolume());
    console.log("getCutDirection() =", device.getCutDirection());
    console.log("getCutHeight() =", device.getCutHeight());
    console.log("getObstacleHeight() =", device.getObstacleHeight());
    console.log("getCutEfficiency() =", device.getCutEfficiency());
    console.log("getAutoCutDirection() =", device.getAutoCutDirection());
    console.log("getRainDelay() =", device.getRainDelay());
    console.log("getAnimProtect() =", device.getAnimProtect());
    console.log("getTimeZone() =", device.getTimeZone());
    console.log("getCustomCutMode() =", device.getCustomCutMode());
    console.log("getBorderSwitch() =", device.getBorderSwitch());
    console.log("getAreaParameters() =", device.getAreaParameters());
    console.log("getAreaSet() =", device.getAreaSet());
    console.log("getAreas() =", device.getAreas());
    console.log("getVirtualWalls() =", device.getVirtualWalls());
    console.log("getNoCrossZones() =", device.getNoCrossZones());
    console.log("getMapAr() =", device.getMapAr());
    console.log("getArInfo() =", device.getArInfo());
    console.log("getMapInfo() =", device.getMapInfo());
    console.log("getFwBuryPoints() =", device.getFwBuryPoints());
    console.log("getFwBuryPoint('bd_setting') =", device.getFwBuryPoint("bd_setting"));
    console.log("getGoatMap() =", device.getGoatMap());
    console.log("getDeviceMap() =", device.getDeviceMap());
    console.log("Map request config =", {
      requestArInfo: REQUEST_ARINFO,
      requestMapInfo: REQUEST_MAPINFO,
      arInfoType: ARINFO_REQUEST_TYPE,
      mapInfoType: MAPINFO_REQUEST_TYPE
    });
    if (REQUEST_ARINFO) {
      console.log(`requestArInfo(type=${ARINFO_REQUEST_TYPE}) ...`);
      await device.requestArInfo(ARINFO_REQUEST_TYPE);
    } else {
      console.log("ArInfo request skipped (set API2_REQUEST_ARINFO=1 or API2_REQUEST_MAPINFO=1).");
    }
    if (REQUEST_MAPINFO) {
      console.log(`requestMapInfo(type=${MAPINFO_REQUEST_TYPE}) ...`);
      await device.requestMapInfo(MAPINFO_REQUEST_TYPE);
    } else {
      console.log("MapInfo request skipped (set API2_REQUEST_MAPINFO=1 to send getMI).");
    }

    if (RUN_SETTER_TESTS) {
      // Wait 5s after script start before setter test.
      console.log("Waiting 5s before obstacleHeight setter test…");
      await new Promise((resolve) => setTimeout(resolve, 5000));

      // 1) Read current obstacleHeight (or fetch if still null)
      let before = device.getObstacleHeight();
      if (!before || typeof before.level === "undefined") {
        await device.sendCommand("getObstacleHeight");
        before = await waitForEvent(device, "obstacleHeight", 7000);
      }

      const beforeLevel = Number(before?.level);
      if (!Number.isFinite(beforeLevel)) {
        throw new Error(`obstacleHeight.level is not numeric: ${JSON.stringify(before)}`);
      }

      const lowerLevel = Math.max(0, beforeLevel - 1);
      console.log(`Setter test obstacleHeight: before=${beforeLevel}, lower=${lowerLevel}`);

      // 2) Set lower value, then read back
      await device.setObstacleHeight(lowerLevel);
      const afterLower = await waitForEvent(device, "obstacleHeight", 7000);
      console.log("obstacleHeight after lower set:", afterLower);

      // 3) Restore original value, then read back again
      await device.setObstacleHeight(beforeLevel);
      const afterRestore = await waitForEvent(device, "obstacleHeight", 7000);
      console.log("obstacleHeight after restore:", afterRestore);

      console.log("Setter test completed.");

      // Additional setter roundtrips for newly implemented API2 setters.
      // Each block is isolated so one failing setter does not stop the others.
      const setterTests = [
        {
          label: "volume",
          eventName: "volume",
          getter: () => device.getVolume(),
          requestCommand: "getVolume",
          setter: (value) => device.setVolume(value),
          buildTarget: (before) => {
            const current = [before?.volume, before?.level, before?.value]
              .map((value) => toNumberOrNull(value))
              .find((value) => value !== null);
            if (current === undefined || current === null) {
              throw new Error(`volume payload invalid: ${JSON.stringify(before)}`);
            }

            // Keep values in a sane range while still forcing an actual state change.
            const nextVolume = current >= 10 ? current - 5 : current + 5;
            return { volume: Math.max(0, Math.min(100, nextVolume)) };
          }
        },
        {
          label: "cutHeight",
          eventName: "cutHeight",
          getter: () => device.getCutHeight(),
          requestCommand: "getCutHeight",
          setter: (value) => device.setCutHeight(value.level),
          buildTarget: (before) => {
            const level = toNumberOrNull(before?.level);
            if (level === null) {
              throw new Error(`cutHeight.level is not numeric: ${JSON.stringify(before)}`);
            }
            return { level: Math.max(0, level - 1) };
          }
        },
        {
          label: "cutDirection",
          eventName: "cutDirection",
          getter: () => device.getCutDirection(),
          requestCommand: "getCutDirection",
          setter: (value) => device.setCutDirection(value),
          buildTarget: (before) => {
            const angle = toNumberOrNull(before?.angle);
            const set = toNumberOrNull(before?.set);
            if (angle === null || set === null) {
              throw new Error(`cutDirection payload invalid: ${JSON.stringify(before)}`);
            }
            return { angle: (angle + 1) % 360, set };
          }
        },
        {
          label: "rainDelay",
          eventName: "rainDelay",
          getter: () => device.getRainDelay(),
          requestCommand: "getRainDelay",
          setter: (value) => device.setRainDelay(value),
          buildTarget: (before) => {
            const delay = toNumberOrNull(before?.delay);
            const enable = toNumberOrNull(before?.enable);
            if (delay === null || enable === null) {
              throw new Error(`rainDelay payload invalid: ${JSON.stringify(before)}`);
            }
            const nextDelay = delay >= 10 ? delay - 10 : delay + 10;
            return { delay: nextDelay, enable };
          }
        },
        {
          label: "borderSwitch",
          eventName: "borderSwitch",
          getter: () => device.getBorderSwitch(),
          requestCommand: "getBorderSwitch",
          setter: (value) => device.setBorderSwitch(value),
          buildTarget: (before) => {
            const mode = toNumberOrNull(before?.mode);
            const enable = toNumberOrNull(before?.enable);
            if (mode === null || enable === null) {
              throw new Error(`borderSwitch payload invalid: ${JSON.stringify(before)}`);
            }

            // Commonly observed modes are 1 and 2. Flip between them for a minimal roundtrip.
            const nextMode = mode === 2 ? 1 : 2;
            return { mode: nextMode, enable };
          }
        }
      ];

      for (const spec of setterTests) {
        try {
          console.log(`\n--- Setter roundtrip: ${spec.label} ---`);
          await runSetterRoundtrip({
            device,
            label: spec.label,
            eventName: spec.eventName,
            getter: spec.getter,
            requestCommand: spec.requestCommand,
            setter: spec.setter,
            buildTarget: spec.buildTarget,
            timeoutMs: 9000
          });
          console.log(`[setter:${spec.label}] roundtrip successful`);
        } catch (error) {
          console.error(`[setter:${spec.label}] roundtrip FAILED:`, error.message);
        }
      }
    } else {
      console.log("Setter tests skipped (set API2_RUN_SETTER_TESTS=1 to enable).");
    }

    if (RUN_MOW_FLOW_TEST) {
      const waitMs = MOW_FLOW_WAIT_SECONDS * 1000;
      console.log(`Mow flow test started (pause -> wait ${MOW_FLOW_WAIT_SECONDS}s -> resume -> wait ${MOW_FLOW_WAIT_SECONDS}s -> stop -> dock).`);

      try {
        await device.pauseMow();
        console.log(`[${device.name}] mow flow: pause command sent`);

        await sleep(waitMs);

        await device.resumeMow();
        console.log(`[${device.name}] mow flow: resume command sent`);

        await sleep(waitMs);

        await device.stopMow();
        console.log(`[${device.name}] mow flow: stop command sent`);

        await device.dock();
        console.log(`[${device.name}] mow flow: dock command sent`);
      } catch (error) {
        console.error(`[${device.name}] mow flow test failed:`, error.message);
      }
    } else {
      console.log("Mow flow test skipped (set API2_RUN_MOW_FLOW_TEST=1 to enable).");
    }
  }

  if (LISTEN_SECONDS > 0) {
    console.log(`Listening for live events for ${LISTEN_SECONDS}s (set API2_LISTEN_SECONDS=0 to skip wait)...`);
    await new Promise((resolve) => setTimeout(resolve, LISTEN_SECONDS * 1000));
  }

  await factory.disconnect();
  runtimeFactory = null;
}

main().catch((error) => {
  console.error("API 2.0 test failed:", error.message);
  if (runtimeFactory?.getConnectionStatus) {
    console.error("Factory status at failure =", runtimeFactory.getConnectionStatus());
  }
  process.exit(1);
});
