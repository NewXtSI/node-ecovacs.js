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
      connection: true,
      auth: true,
      devices: true
    }
  });

  // Toggle debug flag at runtime.
  factory.setDebugFlag("connection", "on");
  factory.setDebugFlag("auth", "on");
  factory.setDebugFlag("devices", "on");

  await factory.connect();

  const devices = await factory.getDevices();
  console.log(`Found ${devices.length} device(s):`);

  for (const device of devices) {
    console.log({
      id: device.id,
      name: device.name,
      nickName: device.nickName,
      className: device.className,
      productCategory: device.productCategory,
      isConnected: device.isConnected
    });
  }

  const goatDevices = await factory.getGoatDevices();
  console.log(`Found ${goatDevices.length} GOATBOT device(s):`);

  await factory.disconnect();
}

main().catch((error) => {
  console.error("API 2.0 test failed:", error.message);
  process.exit(1);
});
