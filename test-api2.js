import { readFile } from "node:fs/promises";
import { Api2Factory } from "./src/api2/index.js";

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
      connection: false,
      auth: false,
      devices: false
    }
  });

  await factory.connect();

  const goatDevices = await factory.getGoatDevices();
  console.log(`Found ${goatDevices.length} GOATBOT device(s):`);

  for (const device of goatDevices) {
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

    device.on("chargeState", (data) => {
      console.log(`[${device.name}] chargeState:`, data);
    });

    device.on("chargeInfo", (data) => {
      console.log(`[${device.name}] chargeInfo:`, data);
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

    // Explicitly call all getters.
    console.log("getStats() =", device.getStats());
    console.log("getLastTimeStats() =", device.getLastTimeStats());
    console.log("getTotalStats() =", device.getTotalStats());
    console.log("getBattery() =", device.getBattery());
    console.log("getChargeState() =", device.getChargeState());
    console.log("getChargeInfo() =", device.getChargeInfo());
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
  }

  await factory.disconnect();
}

main().catch((error) => {
  console.error("API 2.0 test failed:", error.message);
  process.exit(1);
});
