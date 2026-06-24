import { randomUUID } from "node:crypto";
import { createLogger } from "../logger.js";
import { EcovacsCloudClient } from "../services/ecovacsCloudClient.js";
import { Api2Device } from "./device.js";

const DEFAULT_DEBUG_FLAGS = {
  connection: true,
  auth: false,
  devices: false
};

function createClientDeviceId() {
  return randomUUID().replace(/-/g, "");
}

function parseBooleanFlag(value) {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["on", "true", "1", "yes"].includes(normalized)) {
      return true;
    }
    if (["off", "false", "0", "no"].includes(normalized)) {
      return false;
    }
  }

  return Boolean(value);
}

export class Api2Factory {
  constructor(options = {}) {
    const debugFlags = {
      ...DEFAULT_DEBUG_FLAGS,
      ...(options.debugFlags || {})
    };

    this.credentials = {
      email: options.email || options.user || null,
      password: options.password || null,
      passwordHash: options.passwordHash || null,
      country: options.country || "DE",
      continent: options.continent || null,
      deviceId: options.deviceId || null,
      overrideMqttUrl: options.overrideMqttUrl || null
    };

    this.debugFlags = debugFlags;
    const isConnectionEnabled = parseBooleanFlag(debugFlags.connection);
    const isAuthEnabled = parseBooleanFlag(debugFlags.auth);
    const isDevicesEnabled = parseBooleanFlag(debugFlags.devices);
    this.logger = createLogger({
      enableLogging: options.enableLogging !== false,
      logConnection: isConnectionEnabled,
      logConnectionRaw: isConnectionEnabled,
      logAuth: isAuthEnabled,
      logDevices: isDevicesEnabled,
      logDevicesRaw: isDevicesEnabled
    });

    this.cloudClient = null;
    this.connected = false;
  }

  get isConnected() {
    return this.connected;
  }

  setCredentials(userOrEmail, password, options = {}) {
    this.credentials.email = userOrEmail;
    this.credentials.password = password;
    this.credentials.passwordHash = null;
    if (options.country) this.credentials.country = options.country;
    if (options.continent) this.credentials.continent = options.continent;
    if (options.deviceId) this.credentials.deviceId = options.deviceId;
    if (options.overrideMqttUrl) this.credentials.overrideMqttUrl = options.overrideMqttUrl;
    return this;
  }

  setPasswordHash(userOrEmail, passwordHash, options = {}) {
    this.credentials.email = userOrEmail;
    this.credentials.passwordHash = passwordHash;
    this.credentials.password = null;
    if (options.country) this.credentials.country = options.country;
    if (options.continent) this.credentials.continent = options.continent;
    if (options.deviceId) this.credentials.deviceId = options.deviceId;
    if (options.overrideMqttUrl) this.credentials.overrideMqttUrl = options.overrideMqttUrl;
    return this;
  }

  setEnableLogging(enabled) {
    this.logger.setEnableLogging(Boolean(enabled));
    return this;
  }

  setDebugFlag(flagName, enabled) {
    if (typeof flagName !== "string" || flagName.trim().length === 0) {
      throw new Error("setDebugFlag(flagName, enabled) requires a valid flag name.");
    }

    const normalizedFlag = flagName.trim();
    const normalizedValue = parseBooleanFlag(enabled);
    this.debugFlags[normalizedFlag] = normalizedValue;

    if (normalizedFlag === "connection") {
      this.logger.setLogConnection(normalizedValue);
      this.logger.setLogConnectionRaw(normalizedValue);
    }

    if (normalizedFlag === "auth") {
      this.logger.setLogAuth(normalizedValue);
    }

    if (normalizedFlag === "devices") {
      this.logger.setLogDevices(normalizedValue);
      this.logger.setLogDevicesRaw(normalizedValue);
    }

    return this;
  }

  getDebugFlag(flagName) {
    return this.debugFlags[flagName];
  }

  getDebugFlags() {
    return { ...this.debugFlags };
  }

  validateCredentials() {
    const hasEmail = Boolean(this.credentials.email);
    const hasAuth = Boolean(this.credentials.password || this.credentials.passwordHash);

    if (!hasEmail || !hasAuth) {
      throw new Error(
        "Missing required credentials. Use constructor, setCredentials(), or setPasswordHash()."
      );
    }
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

    try {
      this.logger.devices?.("Factory connect() started", {
        user: this.credentials.email,
        country: this.credentials.country,
        continent: this.credentials.continent || null
      });
      await this.cloudClient.connect();
      this.connected = true;
      this.logger.devices?.("Factory connect() successful");
      return this;
    } catch (error) {
      this.logger.devices?.("Factory connect() failed", {
        error: error?.message || String(error)
      });
      throw error;
    }
  }

  async getDevices() {
    if (!this.connected || !this.cloudClient) {
      throw new Error("Not connected. Call connect() first.");
    }

    try {
      const allDevices = await this.cloudClient.getDevices();
      this.logger.devicesRaw?.("Raw getDevices() payload", allDevices);

      const devices = allDevices.all.map((rawDevice) => {
        return new Api2Device(rawDevice);
      });

      const goatDevicesCount = Array.isArray(allDevices?.all)
        ? allDevices.all.filter((device) => String(device?.product_category || "").toUpperCase() === "GOATBOT").length
        : 0;

      this.logger.devices?.("Mapped devices for API2", {
        totalAll: Array.isArray(allDevices?.all) ? allDevices.all.length : 0,
        totalMqtt: Array.isArray(allDevices?.mqtt) ? allDevices.mqtt.length : 0,
        totalXmpp: Array.isArray(allDevices?.xmpp) ? allDevices.xmpp.length : 0,
        totalNotSupported: Array.isArray(allDevices?.notSupported)
          ? allDevices.notSupported.length
          : 0,
        totalGoatBot: goatDevicesCount
      });

      return devices;
    } catch (error) {
      this.logger.devices?.("getDevices() failed", {
        error: error?.message || String(error)
      });
      throw error;
    }
  }

  async getGoatDevices() {
    const devices = await this.getDevices();
    return devices.filter((device) => {
      return String(device.productCategory || "").toUpperCase() === "GOATBOT";
    });
  }

  async disconnect() {
    this.connected = false;
    this.cloudClient = null;
  }
}
