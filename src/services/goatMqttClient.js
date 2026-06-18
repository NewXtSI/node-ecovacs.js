import mqtt from "mqtt";

function getContinent(alpha2Country, explicitContinent) {
  if (explicitContinent) {
    return explicitContinent.toLowerCase();
  }

  const eu = new Set([
    "AT",
    "BE",
    "BG",
    "CH",
    "CY",
    "CZ",
    "DE",
    "DK",
    "EE",
    "ES",
    "FI",
    "FR",
    "GB",
    "GR",
    "HR",
    "HU",
    "IE",
    "IS",
    "IT",
    "LT",
    "LU",
    "LV",
    "MT",
    "NL",
    "NO",
    "PL",
    "PT",
    "RO",
    "SE",
    "SI",
    "SK",
    "UK"
  ]);
  const na = new Set(["CA", "MX", "US"]);
  const asia = new Set([
    "AE",
    "HK",
    "ID",
    "IL",
    "IN",
    "JP",
    "KR",
    "KW",
    "MY",
    "PH",
    "QA",
    "SA",
    "SG",
    "TH",
    "TR",
    "TW",
    "VN"
  ]);

  if (eu.has(alpha2Country)) {
    return "eu";
  }

  if (na.has(alpha2Country)) {
    return "na";
  }

  if (asia.has(alpha2Country)) {
    return "as";
  }

  return "ww";
}

function getContinentUrlPostfix(alpha2Country, explicitContinent) {
  if (alpha2Country === "CN") {
    return "";
  }

  return `-${getContinent(alpha2Country, explicitContinent)}`;
}

function createMqttConfig({ deviceId, country, continent, overrideMqttUrl }) {
  if (overrideMqttUrl) {
    const url = new URL(overrideMqttUrl);
    if (url.protocol !== "mqtt:" && url.protocol !== "mqtts:") {
      throw new Error("Invalid MQTT override URL scheme. Expecting mqtt:// or mqtts://");
    }

    const hostname = url.hostname;
    if (!hostname) {
      throw new Error("Hostname is required in overrideMqttUrl");
    }

    const defaultPort = url.protocol === "mqtt:" ? 1883 : 8883;
    const port = Number(url.port || defaultPort);

    return {
      host: hostname,
      port,
      protocol: url.protocol,
      username: undefined,
      password: undefined,
      clientId: `${deviceId}-node-ecovacs`
    };
  }

  const continentPostfix = getContinentUrlPostfix(country, continent);
  const host = `mq${continentPostfix}.ecouser.net`;

  return {
    host,
    port: 443,
    protocol: "mqtts:",
    username: undefined,
    password: undefined,
    clientId: `${deviceId}-node-ecovacs`
  };
}

export function buildDeviceTopics(device) {
  const dataType = (device.dataType || "j").toLowerCase();
  const devicePath = `${device.did}/${device.class}/${device.resource}`;

  return [
    `iot/atr/+/${devicePath}/${dataType}`,
    `iot/p2p/+/+/+/+/${devicePath}/q/+/${dataType}`,
    `iot/p2p/+/${devicePath}/+/+/+/p/+/${dataType}`
  ];
}

// Checks whether an incoming MQTT topic matches a filter with + and # wildcards.
function mqttTopicMatches(filter, topic) {
  const filterParts = filter.split("/");
  const topicParts = topic.split("/");

  for (let i = 0; i < filterParts.length; i++) {
    if (filterParts[i] === "#") {
      return true;
    }

    if (filterParts[i] !== "+" && filterParts[i] !== topicParts[i]) {
      return false;
    }
  }

  return filterParts.length === topicParts.length;
}

export class GoatMqttClient {
  constructor({ logger, logRaw = false }) {
    this.logger = logger;
    this.logRaw = logRaw;
    this.client = null;
    // Each entry: { filters: string[], handler: fn }
    this.subscriptions = [];
  }

  async connect({ deviceId, country, continent, username, password, overrideMqttUrl }) {
    const mqttConfig = createMqttConfig({
      deviceId,
      country,
      continent,
      overrideMqttUrl
    });

    const protocol = mqttConfig.protocol === "mqtts:" ? "mqtts" : "mqtt";
    const url = `${protocol}://${mqttConfig.host}:${mqttConfig.port}`;

    this.logger.connection("Connecting to MQTT broker", {
      host: mqttConfig.host,
      port: mqttConfig.port
    });

    this.client = mqtt.connect(url, {
      username,
      password,
      clientId: `${username}@ecouser/${deviceId}`,
      rejectUnauthorized: false,
      reconnectPeriod: 5000
    });

    await new Promise((resolve, reject) => {
      this.client.once("connect", resolve);
      this.client.once("error", reject);
    });

    this.logger.connection("MQTT connected");

    // Single central message handler — dispatches to matching subscriptions only
    this.client.on("message", (receivedTopic, payload) => {
      const payloadString = payload.toString("utf8");

      if (this.logRaw) {
        this.logger.info("[RAW MQTT]", { topic: receivedTopic, payload: payloadString });
      }

      for (const sub of this.subscriptions) {
        if (sub.filters.some((f) => mqttTopicMatches(f, receivedTopic))) {
          sub.handler(receivedTopic, payloadString);
        }
      }
    });
  }

  subscribe(topicFilters, messageHandler) {
    if (!this.client) {
      throw new Error("MQTT client is not connected");
    }

    const filters = Array.isArray(topicFilters) ? topicFilters : [topicFilters];
    this.client.subscribe(filters);
    this.subscriptions.push({ filters, handler: messageHandler });
  }

  close() {
    if (this.client) {
      this.client.end(true);
    }
  }
}
