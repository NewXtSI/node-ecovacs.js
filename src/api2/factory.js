import { randomUUID } from "node:crypto";
import { createLogger } from "../logger.js";
import { EcovacsCloudClient } from "../services/ecovacsCloudClient.js";
import { GoatMqttClient, buildDeviceTopics } from "../services/goatMqttClient.js";
import { DeviceCommander } from "../services/deviceCommander.js";
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

function extractApiErrorDetails(error) {
  const message = error?.message || String(error || "");
  const match = message.match(/\((\d{3})\)\s+on\s+([^\s]+)/i);
  if (!match) {
    return {
      code: null,
      endpoint: null
    };
  }

  return {
    code: Number(match[1]),
    endpoint: match[2]
  };
}

function createInitialConnectionStatus() {
  return {
    phase: "idle",
    connected: false,
    authServer: "unknown",
    devicesServer: "unknown",
    mqtt: "unknown",
    updatedAt: null,
    lastError: null
  };
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
    this.mqttClient = null;
    this.connected = false;
    this._connectionStatus = createInitialConnectionStatus();
  }

  get isConnected() {
    return this.connected;
  }

  get status() {
    return this.getConnectionStatus();
  }

  getConnectionStatus() {
    return {
      ...this._connectionStatus,
      lastError: this._connectionStatus.lastError
        ? { ...this._connectionStatus.lastError }
        : null
    };
  }

  _updateConnectionStatus(patch = {}) {
    this._connectionStatus = {
      ...this._connectionStatus,
      ...patch,
      connected: this.connected,
      updatedAt: new Date().toISOString()
    };
  }

  _setConnectionError(stage, error) {
    const details = extractApiErrorDetails(error);
    this._updateConnectionStatus({
      phase: "error",
      lastError: {
        stage,
        message: error?.message || String(error),
        code: details.code,
        endpoint: details.endpoint,
        at: new Date().toISOString()
      }
    });
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
      this._updateConnectionStatus({
        phase: "connecting",
        authServer: "pending",
        devicesServer: "unknown",
        mqtt: "unknown",
        lastError: null
      });
      this.logger.devices?.("Factory connect() started", {
        user: this.credentials.email,
        country: this.credentials.country,
        continent: this.credentials.continent || null
      });
      await this.cloudClient.connect();
      this.connected = true;
      this._updateConnectionStatus({
        phase: "connected",
        authServer: "ok",
        lastError: null
      });
      this.logger.devices?.("Factory connect() successful");
      return this;
    } catch (error) {
      this.connected = false;
      this._updateConnectionStatus({ authServer: "error" });
      this._setConnectionError("connect", error);
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
      this._updateConnectionStatus({
        phase: "fetching_devices",
        devicesServer: "pending",
        lastError: null
      });
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

      this._updateConnectionStatus({
        phase: "ready",
        devicesServer: "ok",
        lastError: null
      });

      return devices;
    } catch (error) {
      this._updateConnectionStatus({ devicesServer: "error" });
      this._setConnectionError("getDevices", error);
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

  /**
   * Connects a device to MQTT, wires lazy-load commands, and routes incoming
   * MQTT messages into device._ingestTopicData().
   *
   * A single shared MQTT client is created on first call and reused for
   * subsequent devices connected via the same factory instance.
   *
   * @param {Api2Device} device
   * @returns {Promise<Api2Device>}
   */
  async connectDevice(device) {
    if (!this.connected || !this.cloudClient) {
      throw new Error("Factory not connected. Call connect() first.");
    }

    // Create the shared MQTT client on first use.
    if (!this.mqttClient) {
      const session = await this.cloudClient.getSessionCredentials();
      this.mqttClient = new GoatMqttClient({ logger: this.logger });
      try {
        this._updateConnectionStatus({ mqtt: "pending", lastError: null });
        await this.mqttClient.connect({
          deviceId: this.credentials.deviceId,
          country: this.credentials.country,
          continent: this.credentials.continent,
          username: session.userId,
          password: session.token,
          overrideMqttUrl: this.credentials.overrideMqttUrl
        });
        this._updateConnectionStatus({ mqtt: "ok", phase: "ready" });
      } catch (error) {
        this._updateConnectionStatus({ mqtt: "error" });
        this._setConnectionError("connectDevice:mqtt", error);
        throw error;
      }
    }

    const commander = new DeviceCommander({
      cloudClient: this.cloudClient,
      logger: this.logger
    });

    const sendToDevice = async (commandEntry) => {
      return commander.sendCommand(device.rawDevice, commandEntry);
    };

    device.setCommandSender(sendToDevice);

    // Wire device lazy-load requests → real device commands.
    // commandEntry is a string name or { name, data } object.
    device.on("_requestData", async (commandEntry) => {
      try {
        await sendToDevice(commandEntry);
      } catch (error) {
        const cmdName = typeof commandEntry === "string" ? commandEntry : commandEntry.name;
        this.logger.warn("Failed to send command", {
          commandName: cmdName,
          error: error.message
        });
      }
    });

    // Subscribe to MQTT topics for this device and route messages.
    const topicFilters = buildDeviceTopics(device.rawDevice);
    this.mqttClient.subscribe(topicFilters, (fullTopic, payloadString) => {
      // Topic format: iot/atr/{topicName}/... or iot/p2p/{topicName}/...
      const topicName = fullTopic.split("/")[2] || null;
      if (!topicName) return;

      // Temporary diagnostics for AreaSet: emit raw event for BOTH request (/q/) and
      // response (/p/) directions before the filter discards query echoes.
      if (topicName === "getAreaSet" || topicName === "onAreaSet" || topicName === "setAreaSet") {
        let rawPayload;
        try { rawPayload = JSON.parse(payloadString); } catch { rawPayload = null; }
        device.emit("_rawAreaSetPayload", {
          fullTopic,
          topicName,
          direction: fullTopic.includes("/q/") ? "request" : "response",
          rawPayload,
          rawString: payloadString
        });
      }

      // Temporary diagnostics for map payloads. getAR/onAR can be multipacket,
      // so raw payload visibility helps validate chunk headers and ordering.
      if (topicName === "getAR" || topicName === "onAR") {
        let rawPayload;
        try { rawPayload = JSON.parse(payloadString); } catch { rawPayload = null; }
        device.emit("_rawMapArPayload", {
          fullTopic,
          topicName,
          direction: fullTopic.includes("/q/") ? "request" : "response",
          rawPayload,
          rawString: payloadString
        });
      }

      // Diagnostics for map/area information topics (ArI/MI).
      if (topicName === "getArI" || topicName === "onArI" || topicName === "getMI" || topicName === "onMI") {
        let rawPayload;
        try { rawPayload = JSON.parse(payloadString); } catch { rawPayload = null; }
        device.emit("_rawMapInfoPayload", {
          fullTopic,
          topicName,
          direction: fullTopic.includes("/q/") ? "request" : "response",
          rawPayload,
          rawString: payloadString
        });
      }

      // Skip p2p "query" direction (/q/) only for getter commands — those are
      // echoes of our own outgoing requests and carry no device response data.
      // Set commands and others on /q/ may carry meaningful payload.
      if (fullTopic.includes("/q/") && topicName.startsWith("get")) return;

      let payload;
      try {
        payload = JSON.parse(payloadString);
      } catch {
        return;
      }

      const data = topicName.startsWith("onFwBuryPoint-")
        ? (payload?.body?.data ?? payload?.body ?? null)
        : (payload?.body?.data ?? null);

      // Temporary diagnostics: expose raw position payloads so consumers can
      // inspect all coordinate blocks (robot/dock/rtk/...) during rollout.
      if (topicName === "getPos" || topicName === "onPos") {
        device.emit("_rawPosPayload", {
          fullTopic,
          topicName,
          data,
          payload
        });
      }

      // Temporary diagnostics: expose raw area parameter payloads to identify response format.
      if (topicName === "getAreaParameter" || topicName === "onAreaParameter") {
        device.emit("_rawAreaParameterPayload", {
          fullTopic,
          topicName,
          data,
          payload
        });
      }

      device._ingestTopicData(topicName, data);
    });

    this.logger.devices?.("Device connected to MQTT", {
      id: device.id,
      name: device.name
    });

    return device;
  }

  async disconnect() {
    if (this.mqttClient) {
      this.mqttClient.close?.();
      this.mqttClient = null;
    }
    this.connected = false;
    this.cloudClient = null;
    this._connectionStatus = {
      ...createInitialConnectionStatus(),
      phase: "disconnected",
      updatedAt: new Date().toISOString()
    };
  }
}
