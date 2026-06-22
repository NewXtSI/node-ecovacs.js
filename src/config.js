import { readFile, writeFile } from "node:fs/promises";

const DEFAULT_SETTINGS = {
  enableLogging: true,
  logConnection: true,
  runtimeSeconds: 0,
  logRawMqtt: true,
  logMqttTrafficToFile: true,
  mqttTrafficLogFile: "mqtt_traffic.log",
  logDiscovery: true,
  logBinaryTopics: true,
  deviceClasses: []
};

export function createDefaultSettings() {
  return {
    ...DEFAULT_SETTINGS,
    deviceClasses: [...DEFAULT_SETTINGS.deviceClasses]
  };
}

async function readJsonFile(filePath, { required = true, defaultValue = null } = {}) {
  let raw;

  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT" && !required) {
      return defaultValue;
    }

    if (error && error.code === "ENOENT") {
      throw new Error(
        `Missing required file: ${filePath}. Create it before starting the app.`
      );
    }

    throw error;
  }

  return JSON.parse(raw);
}

export async function writeTopicsFile(filePath, topics) {
  const json = JSON.stringify(topics, null, 2) + "\n";
  await writeFile(filePath, json, "utf8");
}

export async function loadConfig({ requireCredentials = true, requireTopics = true } = {}) {
  const [settings, credentials, topics] = await Promise.all([
    readJsonFile("settings.json", { required: false, defaultValue: createDefaultSettings() }),
    readJsonFile("credentials.json", { required: requireCredentials, defaultValue: {} }),
    readJsonFile("topics.json", { required: requireTopics, defaultValue: {} })
  ]);

  return {
    settings: {
      ...createDefaultSettings(),
      ...(settings || {})
    },
    credentials,
    topics
  };
}
