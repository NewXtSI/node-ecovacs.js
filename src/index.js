import { loadConfig, writeTopicsFile } from "./config.js";
import { createLogger } from "./logger.js";
import { EcovacsCloudClient } from "./services/ecovacsCloudClient.js";
import { GoatMqttClient, buildDeviceTopics } from "./services/goatMqttClient.js";
import { TopicCollector } from "./services/topicCollector.js";
import { DeviceCommander } from "./services/deviceCommander.js";

function resolveRuntimeMs(runtimeSeconds) {
  if (!Number.isFinite(runtimeSeconds) || runtimeSeconds <= 0) {
    return null;
  }

  return runtimeSeconds * 1000;
}

async function main() {
  const { settings, credentials, topics } = await loadConfig();
  const logger = createLogger({
    enableLogging: settings.enableLogging !== false,
    logConnection: settings.logConnection !== false
  });

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

  const topicCollector = new TopicCollector({
    topicsConfig: topics,
    logger,
    logDiscovery: settings.logDiscovery !== false,
    onDiscoverTopic: async (topicName) => {
      topics[topicName] = {
        enabled: false,
        consoleOut: false,
        consolePayload: false,
        consoleParsed: false
      };

      try {
        await writeTopicsFile("./topics.json", topics);
        logger.info("Topic auto-registered", { topic: topicName });
      } catch (error) {
        logger.error("Failed to save discovered topic", { topic: topicName, error: error.message });
      }
    }
  });

  let mqttClient = null;

  const mqttDevices = devices.mqtt.filter((d) => {
    if (!settings.deviceClasses || settings.deviceClasses.length === 0) {
      return true;
    }

    return settings.deviceClasses.includes(d.class);
  });

  if (mqttDevices.length < devices.mqtt.length) {
    logger.info("Device filter applied", {
      total: devices.mqtt.length,
      active: mqttDevices.length,
      skipped: devices.mqtt
        .filter((d) => !mqttDevices.includes(d))
        .map((d) => ({ class: d.class, deviceName: d.deviceName }))
    });
  }

  if (mqttDevices.length > 0) {
    const sessionCredentials = await cloudClient.getSessionCredentials();
    mqttClient = new GoatMqttClient({
      logger,
      logRaw: settings.logRawMqtt === true,
      rawTopicFilter: (fullTopic) => topicCollector.shouldLogPayloadTopic(fullTopic)
    });

    await mqttClient.connect({
      deviceId: credentials.deviceId,
      country: String(credentials.country || "").toUpperCase(),
      continent: credentials.continent,
      username: sessionCredentials.userId,
      password: sessionCredentials.token,
      overrideMqttUrl: credentials.overrideMqttUrl
    });

    for (const device of mqttDevices) {
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

    // Poll all MQTT devices once to trigger ATR responses.
    // Waits briefly so subscriptions are confirmed before requests go out.
    const commander = new DeviceCommander({ cloudClient, logger });
    setTimeout(async () => {
      for (const device of mqttDevices) {
        await commander.pollDeviceState(device);
      }
    }, 1500);
  } else {
    logger.warn("No matching MQTT devices after filter. Check settings.deviceClasses.");
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
