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

    // Explicitly call getStats() — returns null immediately (no data yet)
    // and sends the real getStats command to the device over MQTT.
    const current = device.getStats();
    console.log(`getStats() returned immediately:`, current);

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
