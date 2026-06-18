import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { EcovacsCloudClient } from "./services/ecovacsCloudClient.js";
import { GoatMqttClient, buildDeviceTopics } from "./services/goatMqttClient.js";
import { TopicCollector } from "./services/topicCollector.js";

function resolveRuntimeMs(runtimeSeconds) {
  if (!Number.isFinite(runtimeSeconds) || runtimeSeconds <= 0) {
    return null;
  }

  return runtimeSeconds * 1000;
}

async function main() {
  const { settings, credentials, topics } = await loadConfig();
  const logger = createLogger({ enabled: settings.logConnection !== false });

  logger.info("Starting node-ecovacs.js runtime");

  const cloudClient = new EcovacsCloudClient({ credentials, logger });
  await cloudClient.connect();

  const devices = await cloudClient.getDevices();
  logger.info("Device overview", {
    total: devices.all.length,
    mqtt: devices.mqtt.length,
    xmpp: devices.xmpp.length,
    notSupported: devices.notSupported.length
  });

  for (const device of devices.all) {
    logger.info("Device found", {
      did: device.did,
      class: device.class,
      name: device.name,
      nick: device.nick || null,
      deviceName: device.deviceName || null,
      resource: device.resource,
      company: device.company
    });
  }

  const topicCollector = new TopicCollector({ topicsConfig: topics, logger });

  let mqttClient = null;

  if (devices.mqtt.length > 0) {
    const sessionCredentials = await cloudClient.getSessionCredentials();
    mqttClient = new GoatMqttClient({ logger });

    await mqttClient.connect({
      deviceId: credentials.deviceId,
      country: String(credentials.country || "").toUpperCase(),
      continent: credentials.continent,
      username: sessionCredentials.userId,
      password: sessionCredentials.token,
      overrideMqttUrl: credentials.overrideMqttUrl
    });

    for (const device of devices.mqtt) {
      const topicsForDevice = buildDeviceTopics(device);
      logger.info("Subscribing device", {
        did: device.did,
        class: device.class,
        name: device.name,
        nick: device.nick || null,
        resource: device.resource,
        topics: topicsForDevice.length
      });

      mqttClient.subscribe(topicsForDevice, (fullTopic, payload) => {
        topicCollector.collect(fullTopic, payload);
      });
    }
  } else {
    logger.warn("No eco-ng MQTT devices returned by API.");
  }

  const runtimeMs = resolveRuntimeMs(settings.runtimeSeconds);
  if (runtimeMs !== null) {
    logger.info("Runtime limit enabled", `${settings.runtimeSeconds}s`);
    setTimeout(() => {
      logger.info("Runtime limit reached. Exiting.");
      if (mqttClient) {
        mqttClient.close();
      }
      process.exit(0);
    }, runtimeMs);
  } else {
    logger.info("Runtime limit disabled. Running continuously.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
