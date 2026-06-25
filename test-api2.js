import { readFile } from "node:fs/promises";
import { Api2Factory } from "./src/api2/index.js";
import { writeFile } from "node:fs/promises";
import { generateMapSvg, getCoordinateSets } from "./src/api2/mapVisualizerSvg.js";

const RUN_SETTER_TESTS = ["1", "true", "yes", "on"].includes(
  String(process.env.API2_RUN_SETTER_TESTS || "").trim().toLowerCase()
);

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

  await factory.connect();

  const goatDevices = await factory.getGoatDevices();
  console.log(`Found ${goatDevices.length} GOATBOT device(s):`);

  for (const device of goatDevices) {
    let latestArInfo = null;
    let latestMapInfo = null;

    const writeMapVisualization = (mapInfoEntries = latestMapInfo, arInfoEntries = latestArInfo) => {
      if (!Array.isArray(mapInfoEntries) || mapInfoEntries.length === 0) {
        return;
      }

      (async () => {
        try {
          const svg = generateMapSvg(mapInfoEntries, { arInfo: arInfoEntries });
          const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, -5);
          const filename = `map_visualization_${timestamp}.svg`;
          await writeFile(filename, svg, "utf8");
          console.log(`[${device.name}] SVG saved: ${filename}`);
        } catch (err) {
          console.error(`[${device.name}] SVG generation failed:`, err.message);
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
      console.log(`[${device.name}] stats:`, data);
    });

    device.on("lastTimeStats", (data) => {
      console.log(`[${device.name}] lastTimeStats:`, data);
    });

    device.on("totalStats", (data) => {
      console.log(`[${device.name}] totalStats:`, data);
    });

    device.on("battery", (data) => {
      console.log(`[${device.name}] battery:`, data);
    });

    device.on("goatPosition", (data) => {
      console.log(`[${device.name}] goatPosition:`, data);
    });

    device.on("chargePosition", (data) => {
      console.log(`[${device.name}] chargePosition:`, data);
    });

    device.on("rtkPosition", (data) => {
      console.log(`[${device.name}] rtkPosition:`, data);
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
      console.log(`[${device.name}] chargeState:`, data);
    });

    device.on("chargeInfo", (data) => {
      console.log(`[${device.name}] chargeInfo:`, data);
    });

    device.on("mowInfo", (data) => {
      console.log(`[${device.name}] mowInfo:`, data);
    });

    device.on("geolocation", (data) => {
      console.log(`[${device.name}] geolocation:`, data);
    });

    device.on("protectState", (data) => {
      console.log(`[${device.name}] protectState:`, data);
    });

    device.on("netInfo", (data) => {
      console.log(`[${device.name}] netInfo:`, data);
    });

    device.on("sleep", (data) => {
      console.log(`[${device.name}] sleep:`, data);
    });

    device.on("error", (data) => {
      console.log(`[${device.name}] error:`, data);
    });

    device.on("lifeSpan", (data) => {
      console.log(`[${device.name}] lifeSpan:`, data);
    });

    device.on("cutDirection", (data) => {
      console.log(`[${device.name}] cutDirection:`, data);
    });

    device.on("cutHeight", (data) => {
      console.log(`[${device.name}] cutHeight:`, data);
    });

    device.on("obstacleHeight", (data) => {
      console.log(`[${device.name}] obstacleHeight:`, data);
    });

    device.on("cutEfficiency", (data) => {
      console.log(`[${device.name}] cutEfficiency:`, data);
    });

    device.on("autoCutDirection", (data) => {
      console.log(`[${device.name}] autoCutDirection:`, data);
    });

    device.on("rainDelay", (data) => {
      console.log(`[${device.name}] rainDelay:`, data);
    });

    device.on("animProtect", (data) => {
      console.log(`[${device.name}] animProtect:`, data);
    });

    device.on("timeZone", (data) => {
      console.log(`[${device.name}] timeZone:`, data);
    });

    device.on("customCutMode", (data) => {
      console.log(`[${device.name}] customCutMode:`, data);
    });

    device.on("borderSwitch", (data) => {
      console.log(`[${device.name}] borderSwitch:`, data);
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
        writeMapVisualization(latestMapInfo, latestArInfo);
      } else {
        console.log(`[${device.name}] arInfo:`, decoded ?? data);
      }
    });

    device.on("mapInfo", (data) => {
      const decoded = data?.decoded;
      if (Array.isArray(decoded)) {
        latestMapInfo = decoded;
        console.log(`[${device.name}] mapInfo: ${decoded.length} room(s)/zone(s)`);
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
        writeMapVisualization(latestMapInfo, latestArInfo);
      } else {
        console.log(`[${device.name}] mapInfo:`, decoded ?? data);
      }
    });

    device.on("unknownTopic", ({ topicName, data, error }) => {
      console.log(`[${device.name}] unknownTopic: ${topicName}`);
      if (error) {
        console.log(`  error: ${error}`);
      }
      console.log(`  data: ${JSON.stringify(data, null, 2)}`);
    });

    // Explicitly call all getters.
    console.log("getStats() =", device.getStats());
    console.log("getLastTimeStats() =", device.getLastTimeStats());
    console.log("getTotalStats() =", device.getTotalStats());
    console.log("getBattery() =", device.getBattery());
    console.log("getGoatPosition() =", device.getGoatPosition());
    console.log("getChargePosition() =", device.getChargePosition());
    console.log("getRtkPosition() =", device.getRtkPosition());
    console.log("getChargeState() =", device.getChargeState());
    console.log("getChargeInfo() =", device.getChargeInfo());
    console.log("getMowInfo() =", device.getMowInfo());
    console.log("getMowState() =", device.getMowState());
    console.log("getGeolocation() =", device.getGeolocation());
    console.log("getProtectState() =", device.getProtectState());
    console.log("getNetInfo() =", device.getNetInfo());
    console.log("getSleep() =", device.getSleep());
    console.log("getError() =", device.getError());
    console.log("getLifeSpan() =", device.getLifeSpan());
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
  }

  if (LISTEN_SECONDS > 0) {
    console.log(`Listening for live events for ${LISTEN_SECONDS}s (set API2_LISTEN_SECONDS=0 to skip wait)...`);
    await new Promise((resolve) => setTimeout(resolve, LISTEN_SECONDS * 1000));
  }

  await factory.disconnect();
}

main().catch((error) => {
  console.error("API 2.0 test failed:", error.message);
  process.exit(1);
});
