import { createDefaultSettings, loadConfig, writeTopicsFile } from "./config.js";
import { createLogger } from "./logger.js";
import { EcovacsCloudClient } from "./services/ecovacsCloudClient.js";
import { GoatMqttClient, buildDeviceTopics } from "./services/goatMqttClient.js";
import { TopicCollector } from "./services/topicCollector.js";
import { DeviceCommander } from "./services/deviceCommander.js";

export class Goat {
  constructor() {
    this.settings = createDefaultSettings();
    this.credentials = {};
    this.topics = {};
    this.logger = null;

    this.cloudClient = null;
    this.mqttClient = null;
    this.topicCollector = null;
    this.commander = null;

    this.device = null;
    this.runtimeMs = null;

    // State tracking - only notify on actual changes
    this.state = {
      position: null,  // { x, y, a }
      battery: null,   // percentage number
      sleep: null,     // boolean
      volume: null,    // { volume, fallVolume, searchVolume }
      lifeSpan: null,   // { blade: { left, total }, lensBrush: { left, total } }
      totalStats: null, // { area, time, count }
      netInfo: null,    // { ip, ssid, rssi, wkVer, mac }
      mapState: null,   // { state, expandState }
      mowInfo: null,    // { trigger, other, state, type, cleanState }
      chargeState: null,// { isCharging, mode }
      error: null,      // error code array e.g. [0]
      geolocation: null, // { enable, geoLocation: { longitude, latitude } }
      mowCommand: null  // { act, type, value, content, parsed, ts }
    };

    // Callbacks for state changes
    this.callbacks = {
      position: [],
      battery: [],
      sleep: [],
      volume: [],
      lifeSpan: [],
      totalStats: [],
      netInfo: [],
      mapState: [],
      mowInfo: [],
      mowState: [],
      chargeState: [],
      error: [],
      geolocation: [],
      mowCommand: [],
      connected: [],
      disconnected: []
    };
  }

  async init({ settings = null, credentials = null, topics = null } = {}) {
    const hasCredentialsAlready = this.credentials && Object.keys(this.credentials).length > 0;
    const hasCredentialsOverride = credentials && Object.keys(credentials).length > 0;

    const loaded = await loadConfig({
      requireCredentials: !hasCredentialsOverride && !hasCredentialsAlready,
      requireTopics: false
    });

    this.settings = {
      ...createDefaultSettings(),
      ...(loaded.settings || {}),
      ...(settings || {})
    };
    this.credentials = {
      ...(loaded.credentials || {}),
      ...(this.credentials || {}),
      ...(credentials || {})
    };
    this.topics = {
      ...(loaded.topics || {}),
      ...(topics || {})
    };

    this.logger = createLogger({
      enableLogging: this.settings.enableLogging === true,
      logConnection: this.settings.logConnection === true
    });

  }

  async connect() {
    if (!this.logger || !this.credentials || Object.keys(this.credentials).length === 0) {
      throw new Error("GOAT not initialized. Call init() first.");
    }

    this.cloudClient = new EcovacsCloudClient({ credentials: this.credentials, logger: this.logger });
    await this.cloudClient.connect();

    const devices = await this.cloudClient.getDevices();
    const allowedDeviceClasses = Array.isArray(this.settings.deviceClasses)
      ? this.settings.deviceClasses.map((entry) => String(entry || "").trim()).filter((entry) => entry.length > 0)
      : [];
    const mqttDevices = devices.mqtt.filter((d) => {
      if (allowedDeviceClasses.length === 0) {
        return false;
      }

      return allowedDeviceClasses.includes(String(d.class || "").trim());
    });

    if (mqttDevices.length === 0) {
      throw new Error("No matching MQTT devices found.");
    }

    this.device = mqttDevices[0];

    this.topicCollector = new TopicCollector({
      topicsConfig: this.topics,
      logger: this.logger,
      logDiscovery: this.settings.logDiscovery === true,
      logBinaryTopics: this.settings.logBinaryTopics === true,
      onDiscoverTopic: async (topicName) => {
        this.topics[topicName] = {
          enabled: false,
          consoleOut: false,
          consolePayload: false,
          consoleParsed: false,
          hasParser: false
        };
        try {
          await writeTopicsFile("./topics.json", this.topics);
        } catch (error) {
          this.logger?.error("Failed to save discovered topic", { topic: topicName, error: error.message });
        }
      }
    });

    const sessionCredentials = await this.cloudClient.getSessionCredentials();
    const hasTopicConfig = this.topics && Object.keys(this.topics).length > 0;

    this.mqttClient = new GoatMqttClient({
      logger: this.logger,
      logRaw: this.settings.logRawMqtt === true,
      rawTopicFilter: hasTopicConfig ? (fullTopic) => this.topicCollector.shouldLogPayloadTopic(fullTopic) : null,
      logTrafficToFile: this.settings.logMqttTrafficToFile === true,
      trafficLogFilePath: this.settings.mqttTrafficLogFile || "mqtt_traffic.log"
    });

    await this.mqttClient.connect({
      deviceId: this.credentials.deviceId,
      country: String(this.credentials.country || "").toUpperCase(),
      continent: this.credentials.continent,
      username: sessionCredentials.userId,
      password: sessionCredentials.token,
      overrideMqttUrl: this.credentials.overrideMqttUrl
    });

    const topicsForDevice = buildDeviceTopics(this.device);
    this.mqttClient.subscribe(topicsForDevice, (fullTopic, payload) => {
      this.topicCollector.collect(fullTopic, payload);
      this.onTopicPayload(fullTopic, payload);
    });

    this.commander = new DeviceCommander({ cloudClient: this.cloudClient, logger: this.logger });

    // Poll device state immediately so battery / clean state / position are hydrated right away.
    void this.commander.pollDeviceState(this.device);

    this.callCallback("connected");

    const runtimeMs = this.resolveRuntimeMs(this.settings.runtimeSeconds);
    if (runtimeMs !== null) {
      this.runtimeMs = runtimeMs;
      setTimeout(() => {
        this.disconnect();
      }, runtimeMs);
    }
  }

  onTopicPayload(fullTopic, payloadString) {
    try {
      const payload = JSON.parse(payloadString);
      const topicName = this.resolveTopicName(fullTopic);

      if (topicName === "onPos" || topicName === "getPos") {
        const data = payload?.body?.data;
        if (data && data.deebotPos) {
          const newPos = {
            x: Number(data.deebotPos.x) || 0,
            y: Number(data.deebotPos.y) || 0,
            a: Number(data.deebotPos.a) || 0
          };
          if (!this.positionChanged(newPos)) {
            return;
          }
          this.state.position = newPos;
          this.callCallback("position", newPos);
        }
      }

      if (topicName === "onBattery" || topicName === "getBattery") {
        const data = payload?.body?.data;
        if (data && typeof data.value === "number") {
          const newBattery = data.value;
          if (this.state.battery === newBattery) {
            return;
          }
          this.state.battery = newBattery;
          this.callCallback("battery", newBattery);
        }
      }

      if (topicName === "getSleep" || topicName === "onSleep") {
        const data = payload?.body?.data;
        if (data && typeof data.enable !== "undefined") {
          const newSleep = data.enable === 1 || data.enable === true;
          if (this.state.sleep === newSleep) {
            return;
          }
          this.state.sleep = newSleep;
          this.callCallback("sleep", newSleep);
        }
      }

      if (topicName === "getVolume" || topicName === "onVolume") {
        const data = payload?.body?.data;
        if (data && typeof data.volume !== "undefined") {
          const newVolume = {
            volume: Number(data.volume),
            fallVolume: Number(data.fallVolume),
            searchVolume: Number(data.searchVolume)
          };
          if (this.volumeEqual(newVolume)) {
            return;
          }
          this.state.volume = newVolume;
          this.callCallback("volume", newVolume);
        }
      }

      if (topicName === "getMapState") {
        const data = payload?.body?.data;
        if (data && typeof data.state !== "undefined") {
          const prev = this.state.mapState;
          if (prev && prev.state === data.state && prev.expandState === data.expandState) return;
          this.state.mapState = { state: data.state, expandState: data.expandState };
          this.callCallback("mapState", this.state.mapState);
        }
      }

      if (topicName === "clean") {
        const body = payload?.body;
        if (body && body.data && typeof body.data.act !== "undefined") {
          const content = body.data.content ?? null;
          const type = content?.type ?? null;
          const value = typeof content?.value === "string" ? content.value : "";
          const parsed = this.parseMowCommandValue(type, value);
          const newCmd = {
            act: body.data.act,
            type,
            value,
            content,
            parsed,
            ts: Date.now()
          };
          this.state.mowCommand = newCmd;
          this.callCallback("mowCommand", newCmd);
        }
      }

      if (topicName === "getCleanInfo" || topicName === "onCleanInfo") {
        const data = payload?.body?.data;
        if (data && typeof data.state !== "undefined") {
          const nextState = this.toMowState(data.state);
          const nextType = this.toMowType(data.cleanState);
          const prev = this.state.mowInfo;
          if (prev && prev.state === nextState && prev.trigger === data.trigger &&
              prev.type === nextType &&
              JSON.stringify(prev.cleanState) === JSON.stringify(data.cleanState)) return;
          this.state.mowInfo = {
            trigger: data.trigger,
            other: data.other,
            state: nextState,
            type: nextType,
            cleanState: data.cleanState ?? null
          };
          this.callCallback("mowInfo", this.state.mowInfo);
          if (!prev || prev.state !== nextState) {
            this.callCallback("mowState", nextState);
          }
        }
      }

      if (topicName === "getChargeState" || topicName === "onChargeState") {
        const data = payload?.body?.data;
        if (data && typeof data.isCharging !== "undefined") {
          const prev = this.state.chargeState;
          if (prev && prev.isCharging === data.isCharging && prev.mode === data.mode) return;
          this.state.chargeState = { isCharging: data.isCharging, mode: data.mode };
          this.callCallback("chargeState", this.state.chargeState);
        }
      }

      if (topicName === "getError" || topicName === "onError") {
        const data = payload?.body?.data;
        if (data && Array.isArray(data.code)) {
          const newCode = JSON.stringify(data.code);
          if (JSON.stringify(this.state.error) === newCode) return;
          this.state.error = data.code;
          this.callCallback("error", this.state.error);
        }
      }

      if (topicName === "getGeolocation") {
        const data = payload?.body?.data;
        if (data && data.geoLocation) {
          const geo = data.geoLocation;
          const prev = this.state.geolocation;
          if (prev && prev.geoLocation?.latitude === geo.latitude && prev.geoLocation?.longitude === geo.longitude) return;
          this.state.geolocation = { enable: data.enable, geoLocation: { longitude: geo.longitude, latitude: geo.latitude } };
          this.callCallback("geolocation", this.state.geolocation);
        }
      }

      if (topicName === "getTotalStats") {
        const data = payload?.body?.data;
        if (data && typeof data.area !== "undefined") {
          const newStats = {
            area: Number(data.area),
            time: Number(data.time),
            count: Number(data.count)
          };
          const prev = this.state.totalStats;
          if (prev && prev.area === newStats.area && prev.time === newStats.time && prev.count === newStats.count) {
            return;
          }
          this.state.totalStats = newStats;
          this.callCallback("totalStats", newStats);
        }
      }

      if (topicName === "getNetInfo") {
        const data = payload?.body?.data;
        if (data && typeof data.ip !== "undefined") {
          const newNet = {
            ip: data.ip,
            ssid: data.ssid,
            rssi: data.rssi,
            wkVer: data.wkVer,
            mac: data.mac
          };
          const prev = this.state.netInfo;
          if (prev && prev.ip === newNet.ip && prev.ssid === newNet.ssid && prev.rssi === newNet.rssi) {
            return;
          }
          this.state.netInfo = newNet;
          this.callCallback("netInfo", newNet);
        }
      }

      if (topicName === "getLifeSpan") {
        const data = payload?.body?.data;
        if (Array.isArray(data)) {
          const updated = { ...(this.state.lifeSpan || {}) };
          let changed = false;
          for (const entry of data) {
            const type = entry.type;
            const left = Number(entry.left);
            const total = Number(entry.total);
            if (type && !isNaN(left) && !isNaN(total)) {
              if (!updated[type] || updated[type].left !== left || updated[type].total !== total) {
                updated[type] = { left, total };
                changed = true;
              }
            }
          }
          if (!changed) {
            return;
          }
          this.state.lifeSpan = updated;
          this.callCallback("lifeSpan", updated);
        }
      }
    } catch {
      // Silently ignore parse errors
    }
  }

  positionChanged(newPos) {
    if (!this.state.position) {
      return true;
    }
    return (
      newPos.x !== this.state.position.x ||
      newPos.y !== this.state.position.y ||
      newPos.a !== this.state.position.a
    );
  }

  volumeEqual(newVolume) {
    if (!this.state.volume) {
      return false;
    }
    return (
      newVolume.volume === this.state.volume.volume &&
      newVolume.fallVolume === this.state.volume.fallVolume &&
      newVolume.searchVolume === this.state.volume.searchVolume
    );
  }

  toMowState(stateValue) {
    return stateValue === "clean" ? "mow" : stateValue;
  }

  toMowType(cleanState) {
    const typeFromContent = cleanState?.content?.type;
    if (typeof typeFromContent === "string" && typeFromContent.length > 0) {
      return typeFromContent;
    }

    const typeFromSubContent = cleanState?.content?.subContent?.type;
    if (typeof typeFromSubContent === "string" && typeFromSubContent.length > 0) {
      return typeFromSubContent;
    }

    return null;
  }

  parseMowCommandValue(type, value) {
    if (type === "spotArea") {
      return {
        spotAreaIds: this.parseSpotAreaIds(value),
        borderAreaIds: [],
        borderVirtualIds: [],
        unknownBorderTokens: []
      };
    }

    if (type === "border") {
      return this.parseBorderTargets(value);
    }

    return {
      spotAreaIds: [],
      borderAreaIds: [],
      borderVirtualIds: [],
      unknownBorderTokens: []
    };
  }

  parseSpotAreaIds(value) {
    if (typeof value !== "string" || value.trim().length === 0) {
      return [];
    }

    return value
      .split(",")
      .map((entry) => Number(entry.trim()))
      .filter((id) => Number.isFinite(id));
  }

  parseBorderTargets(value) {
    const result = {
      spotAreaIds: [],
      borderAreaIds: [],
      borderVirtualIds: [],
      unknownBorderTokens: []
    };

    if (typeof value !== "string" || value.trim().length === 0) {
      return result;
    }

    const tokens = value
      .split(";")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);

    for (const token of tokens) {
      const [prefixRaw, idRaw] = token.split(":");
      const prefix = String(prefixRaw || "").toLowerCase();
      const id = Number(idRaw);
      if (!Number.isFinite(id)) {
        result.unknownBorderTokens.push(token);
        continue;
      }

      if (prefix === "aid") {
        result.borderAreaIds.push(id);
      } else if (prefix === "vid") {
        result.borderVirtualIds.push(id);
      } else {
        result.unknownBorderTokens.push(token);
      }
    }

    return result;
  }

  ensureConnectedForCommand() {
    if (!this.commander || !this.device) {
      throw new Error("GOAT not connected. Call connect() first.");
    }
  }

  async sendCleanCommand(act, content) {
    this.ensureConnectedForCommand();
    const data = { act };
    if (content) {
      data.content = content;
    }
    return this.commander.sendCommand(this.device, { name: "clean", data });
  }

  getCurrentMowTypeFallback() {
    return this.state.mowInfo?.type || this.state.mowCommand?.type || "spotArea";
  }

  normalizeAreaIds(areaIds) {
    if (typeof areaIds === "string") {
      const ids = this.parseSpotAreaIds(areaIds);
      if (ids.length === 0) {
        throw new Error("mowArea requires at least one area id.");
      }
      return ids;
    }

    if (Array.isArray(areaIds)) {
      const ids = areaIds
        .map((id) => Number(id))
        .filter((id) => Number.isFinite(id));
      if (ids.length === 0) {
        throw new Error("mowArea requires at least one area id.");
      }
      return ids;
    }

    throw new Error("mowArea expects an array of ids or comma-separated id string.");
  }

  normalizeBorderValue(target) {
    if (typeof target === "string") {
      const value = target.trim();
      if (!value) {
        throw new Error("mowBorder requires a non-empty target value.");
      }
      return value;
    }

    if (Array.isArray(target)) {
      if (target.length === 0) {
        throw new Error("mowBorder requires at least one target.");
      }

      // Number[] => aid:number
      if (target.every((entry) => Number.isFinite(Number(entry)))) {
        return target.map((entry) => `aid:${Number(entry)}`).join(";");
      }

      // String[] => expected tokens like aid:1 or vid:1
      const values = target.map((entry) => String(entry).trim()).filter((entry) => entry.length > 0);
      if (values.length === 0) {
        throw new Error("mowBorder requires non-empty border tokens.");
      }
      return values.join(";");
    }

    if (target && typeof target === "object") {
      const aids = Array.isArray(target.aid) ? target.aid : [];
      const vids = Array.isArray(target.vid) ? target.vid : [];
      const aidTokens = aids.map((id) => `aid:${Number(id)}`).filter((token) => !token.endsWith(":NaN"));
      const vidTokens = vids.map((id) => `vid:${Number(id)}`).filter((token) => !token.endsWith(":NaN"));
      const tokens = [...aidTokens, ...vidTokens];
      if (tokens.length === 0) {
        throw new Error("mowBorder object requires aid[] and/or vid[] with numeric ids.");
      }
      return tokens.join(";");
    }

    throw new Error("mowBorder expects string, array, or object with aid/vid arrays.");
  }

  resolveTopicName(fullTopic) {
    const parts = String(fullTopic).split("/");
    if (parts.length < 3) {
      return null;
    }
    if (parts[0] === "iot" && parts[1] === "atr") {
      return parts[2];
    }
    if (parts[0] === "iot" && parts[1] === "p2p") {
      return parts[2];
    }
    return null;
  }

  on(event, callback) {
    if (this.callbacks[event]) {
      this.callbacks[event].push(callback);
    }
  }

  applyRuntimeLogSettings() {
    if (this.logger?.setOptions) {
      this.logger.setOptions({
        enableLogging: this.settings.enableLogging === true,
        logConnection: this.settings.logConnection === true
      });
    }

    if (this.topicCollector) {
      this.topicCollector.logDiscovery = this.settings.logDiscovery === true;
      this.topicCollector.logBinaryTopics = this.settings.logBinaryTopics === true;
    }

    if (this.mqttClient) {
      this.mqttClient.logRaw = this.settings.logRawMqtt === true;
      this.mqttClient.logTrafficToFile = this.settings.logMqttTrafficToFile === true;
      this.mqttClient.trafficLogFilePath = this.settings.mqttTrafficLogFile || "mqtt_traffic.log";
      this.mqttClient.rawTopicFilter =
        this.topics && Object.keys(this.topics).length > 0
          ? (fullTopic) => this.topicCollector?.shouldLogPayloadTopic(fullTopic)
          : null;
    }
  }

  setEnableLogging(enabled) {
    this.settings.enableLogging = Boolean(enabled);
    this.applyRuntimeLogSettings();
    return this;
  }

  setLogConnection(enabled) {
    this.settings.logConnection = Boolean(enabled);
    this.applyRuntimeLogSettings();
    return this;
  }

  setLogRawMqtt(enabled) {
    this.settings.logRawMqtt = Boolean(enabled);
    this.applyRuntimeLogSettings();
    return this;
  }

  setLogMqttTrafficToFile(enabled) {
    this.settings.logMqttTrafficToFile = Boolean(enabled);
    this.applyRuntimeLogSettings();
    return this;
  }

  setMqttTrafficLogFile(filePath) {
    if (typeof filePath !== "string" || filePath.trim().length === 0) {
      throw new Error("setMqttTrafficLogFile requires a non-empty file path string.");
    }
    this.settings.mqttTrafficLogFile = filePath;
    this.applyRuntimeLogSettings();
    return this;
  }

  setLogDiscovery(enabled) {
    this.settings.logDiscovery = Boolean(enabled);
    this.applyRuntimeLogSettings();
    return this;
  }

  setLogBinaryTopics(enabled) {
    this.settings.logBinaryTopics = Boolean(enabled);
    this.applyRuntimeLogSettings();
    return this;
  }

  off(event, callback) {
    if (this.callbacks[event]) {
      const index = this.callbacks[event].indexOf(callback);
      if (index > -1) {
        this.callbacks[event].splice(index, 1);
      }
    }
  }

  callCallback(event, data = null) {
    if (this.callbacks[event]) {
      for (const cb of this.callbacks[event]) {
        try {
          cb(data);
        } catch (error) {
          this.logger?.warn(`Callback error for event ${event}`, { error: error.message });
        }
      }
    }
  }

  getPosition() {
    return this.state.position;
  }

  getBattery() {
    return this.state.battery;
  }

  getSleep() {
    return this.state.sleep;
  }

  getVolume() {
    return this.state.volume;
  }

  getLifeSpan() {
    return this.state.lifeSpan;
  }

  getTotalStats() {
    return this.state.totalStats;
  }

  getNetInfo() {
    return this.state.netInfo;
  }

  getMapState() {
    return this.state.mapState;
  }

  getMowInfo() {
    return this.state.mowInfo;
  }

  getMowState() {
    return this.state.mowInfo?.state ?? null;
  }

  getMowCommand() {
    return this.state.mowCommand;
  }

  getChargeState() {
    return this.state.chargeState;
  }

  getError() {
    return this.state.error;
  }

  getGeolocation() {
    return this.state.geolocation;
  }

  async mowArea(areaIds) {
    const ids = this.normalizeAreaIds(areaIds);
    return this.sendCleanCommand("start", {
      type: "spotArea",
      value: ids.join(",")
    });
  }

  async mowBorder(target) {
    const value = this.normalizeBorderValue(target);
    return this.sendCleanCommand("start", {
      type: "border",
      value
    });
  }

  async pause() {
    return this.sendCleanCommand("pause", {
      type: this.getCurrentMowTypeFallback()
    });
  }

  async resume() {
    return this.sendCleanCommand("resume", {
      type: this.getCurrentMowTypeFallback()
    });
  }

  async stopMow() {
    return this.sendCleanCommand("stop", {
      type: this.getCurrentMowTypeFallback()
    });
  }

  async dock() {
    throw new Error("dock command not implemented yet (unknown Ecovacs command for this model).");
  }

  async setPos(pos) {
    this.ensureConnectedForCommand();

    if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) {
      throw new Error("setPos requires numeric x and y.");
    }

    const a = Number.isFinite(pos.a) ? pos.a : 0;
    const commandEntry = {
      name: "setPos",
      data: {
        deebotPos: {
          x: Number(pos.x),
          y: Number(pos.y),
          a: Number(a),
          invalid: 0
        }
      }
    };

    return this.commander.sendCommand(this.device, commandEntry);
  }

  async stop() {
    return this.stopMow();
  }

  async disconnect() {
    const hadClient = Boolean(this.mqttClient);
    if (this.mqttClient) {
      this.mqttClient.close();
      this.mqttClient = null;
    }
    if (hadClient) {
      this.callCallback("disconnected");
    }
  }

  async close() {
    return this.disconnect();
  }

  resolveRuntimeMs(runtimeSeconds) {
    if (!Number.isFinite(runtimeSeconds) || runtimeSeconds <= 0) {
      return null;
    }
    return runtimeSeconds * 1000;
  }
}
