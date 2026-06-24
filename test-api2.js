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

    // Wait for the reply to arrive via MQTT (onStats / getStats response).
    console.log("Waiting for stats reply…");
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  await factory.disconnect();
}

main().catch((error) => {
  console.error("API 2.0 test failed:", error.message);
  process.exit(1);
});
