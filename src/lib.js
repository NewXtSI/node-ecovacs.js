import { EcovacsCloudClient } from "./services/ecovacsCloudClient.js";
import { Goat } from "./goat.js";
import { createLogger } from "./logger.js";
import { createDefaultSettings, loadConfig } from "./config.js";
import { randomUUID } from "node:crypto";

// Supported Goat device classes
const SUPPORTED_GOAT_CLASSES = ["2px96q"];

function createClientDeviceId() {
  return randomUUID().replace(/-/g, "");
}

function normalizeDeviceClasses() {
  return [...SUPPORTED_GOAT_CLASSES];
}

export class EcovacsGoatAdapter {
  constructor(credentials = {}) {
    this.credentials = {
      email: credentials.email || credentials.accountId || null,
      password: credentials.password || null,
      passwordHash: credentials.passwordHash || null,
      country: credentials.country || "DE",
      continent: credentials.continent || null,
      deviceId: credentials.deviceId || null,
      overrideMqttUrl: credentials.overrideMqttUrl || null
    };

    this.cloudClient = null;
    this.logger = createLogger({ enableLogging: true, logConnection: true });
    this.isConnected = false;
    this.devices = [];
    this.goatSettings = createDefaultSettings();
  }

  setCredentials(email, password, options = {}) {
    this.credentials.email = email;
    this.credentials.password = password;
    this.credentials.passwordHash = null;
    if (options.country) this.credentials.country = options.country;
    if (options.continent) this.credentials.continent = options.continent;
    if (options.deviceId) this.credentials.deviceId = options.deviceId;
    if (options.overrideMqttUrl) this.credentials.overrideMqttUrl = options.overrideMqttUrl;
  }

  setPasswordHash(email, passwordHash, options = {}) {
    this.credentials.email = email;
    this.credentials.passwordHash = passwordHash;
    this.credentials.password = null;
    if (options.country) this.credentials.country = options.country;
    if (options.continent) this.credentials.continent = options.continent;
    if (options.deviceId) this.credentials.deviceId = options.deviceId;
    if (options.overrideMqttUrl) this.credentials.overrideMqttUrl = options.overrideMqttUrl;
  }

  validateCredentials() {
    const hasEmail = Boolean(this.credentials.email);
    const hasAuth = Boolean(this.credentials.password || this.credentials.passwordHash);

    if (!hasEmail || !hasAuth) {
      throw new Error(
        "Missing required credentials. Call setCredentials() or setPasswordHash() with email and password/passwordHash."
      );
    }
  }

  setEnableLogging(enabled) {
    this.goatSettings.enableLogging = Boolean(enabled);
    this.logger?.setEnableLogging?.(enabled);
    return this;
  }

  setLogConnection(enabled) {
    this.goatSettings.logConnection = Boolean(enabled);
    this.logger?.setLogConnection?.(enabled);
    return this;
  }

  setLogRawMqtt(enabled) {
    this.goatSettings.logRawMqtt = Boolean(enabled);
    return this;
  }

  setLogMqttTrafficToFile(enabled) {
    this.goatSettings.logMqttTrafficToFile = Boolean(enabled);
    return this;
  }

  setMqttTrafficLogFile(filePath) {
    if (typeof filePath !== "string" || filePath.trim().length === 0) {
      throw new Error("setMqttTrafficLogFile requires a non-empty file path string.");
    }
    this.goatSettings.mqttTrafficLogFile = filePath;
    return this;
  }

  setLogDiscovery(enabled) {
    this.goatSettings.logDiscovery = Boolean(enabled);
    return this;
  }

  setLogBinaryTopics(enabled) {
    this.goatSettings.logBinaryTopics = Boolean(enabled);
    return this;
  }

  getAllowedDeviceClasses() {
    return normalizeDeviceClasses();
  }

  async connect() {
    this.validateCredentials();

    if (!this.credentials.deviceId) {
      this.credentials.deviceId = createClientDeviceId();
    }

    this.cloudClient = new EcovacsCloudClient({
      credentials: {
        accountId: this.credentials.email,
        email: this.credentials.email,
        password: this.credentials.password,
        passwordHash: this.credentials.passwordHash,
        country: this.credentials.country,
        continent: this.credentials.continent,
        deviceId: this.credentials.deviceId,
        overrideMqttUrl: this.credentials.overrideMqttUrl
      },
      logger: this.logger
    });

    await this.cloudClient.connect();
    this.isConnected = true;
  }

  async getDevices() {
    if (!this.isConnected) {
      throw new Error("Not connected. Call connect() first.");
    }

    const allDevices = await this.cloudClient.getDevices();
    return allDevices;
  }

  async getGoatDevices() {
    if (!this.isConnected) {
      throw new Error("Not connected. Call connect() first.");
    }

    const allDevices = await this.cloudClient.getDevices();
    const allowedClasses = normalizeDeviceClasses();
    const goatDevices = allDevices.mqtt.filter((device) => {
      return allowedClasses.includes(String(device.class || "").trim());
    });

    return goatDevices.map((device) => ({
      id: device.did,
      name: device.nick || device.name || device.deviceName || `Goat ${device.did}`,
      class: device.class,
      resource: device.resource,
      company: device.company,
      battery: null,
      isCharging: null,
      position: null,
      state: null
    }));
  }

  async createGoatInstance(deviceId) {
    if (!this.isConnected) {
      throw new Error("Not connected. Call connect() first.");
    }

    const allDevices = await this.cloudClient.getDevices();
    const device = allDevices.all.find((d) => d.did === deviceId);

    if (!device) {
      throw new Error(`Device not found: ${deviceId}`);
    }

    const allowedClasses = normalizeDeviceClasses();
    const deviceClass = String(device.class || "").trim();

    if (!allowedClasses.includes(deviceClass)) {
      throw new Error(
        `Device class "${deviceClass}" is not supported. Supported Goat classes: ${allowedClasses.join(", ")}`
      );
    }

    const goat = new Goat();
    goat.cloudClient = this.cloudClient;
    goat.deviceId = deviceId;  // Store target device ID

    const { settings, topics } = await loadConfig({
      requireCredentials: false,
      requireTopics: false
    });
    goat.settings = {
      ...createDefaultSettings(),
      ...(settings || {}),
      ...this.goatSettings
    };
    goat.credentials = {
      ...this.credentials,
      deviceId: device.did
    };
    goat.topics = topics || {};
    goat.logger = this.logger;

    return goat;
  }

  async disconnect() {
    this.isConnected = false;
    if (this.cloudClient) {
      this.cloudClient = null;
    }
  }
}

export { Goat } from "./goat.js";
