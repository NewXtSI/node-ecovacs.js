import { EventEmitter } from "node:events";
import { decodeAreaSetPayload } from "./areaSetDecoder.js";
import { decodeBinaryTopicBase64 } from "./binaryTopicDecoder.js";

// Internal sentinel used to detect "no previous value yet" vs. an actual null state.
const UNSET = Symbol("UNSET");

function stateEqual(a, b) {
  if (a === b) return true;
  if (a === UNSET || b === UNSET) return false;
  if (a === null || b === null) return a === b;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

export class Api2Device extends EventEmitter {
  constructor(rawDevice) {
    super();
    this.rawDevice = rawDevice || {};

    // Internal state store.  Each property starts as UNSET (never received)
    // so the first ingested value always triggers an event even if it is null.
    this._state = {
      goatPosition: UNSET,   // { x, y, a, ... }
      chargePosition: UNSET, // [{ x, y, a, ... }, ...]
      rtkPosition: UNSET,    // [{ x, y, a, ... }, ...]
      stats: UNSET,          // { time, area, mowedArea }
      lastTimeStats: UNSET,  // { cid, start, type, stop, area, time }
      totalStats: UNSET,     // { area, time, count }
      battery: UNSET,        // { value, isLow }
      chargeState: UNSET,    // { isCharging, mode }
      chargeInfo: UNSET,     // { cid, trigger, state, other }
      mowInfo: UNSET,        // { trigger, other, state, type, cleanState }
      geolocation: UNSET,    // { enable, geoLocation: { longitude, latitude } }
      protectState: UNSET,   // onProtectState payload
      netInfo: UNSET,        // { ip, ssid, rssi, wkVer, mac }
      sleep: UNSET,          // { enable }
      error: UNSET,          // { code: [...] }
      lifeSpan: UNSET,       // { blade: { left, total }, ... }
      cutEfficiency: UNSET,   // { level }
      obstacleHeight: UNSET,  // { level }
      cutHeight: UNSET,       // { level }
      cutDirection: UNSET,    // { angle, set }
      autoCutDirection: UNSET,// { enable }
      rainDelay: UNSET,       // { enable, delay }
      animProtect: UNSET,     // {...}
      timeZone: UNSET,        // {...}
      customCutMode: UNSET,   // {...}
      borderSwitch: UNSET,    // {...}
      areaParameters: UNSET,  // [{ areaId, cutMode, mowHeightLevel, obstacleHeight }, ...]
      areaSet: UNSET,          // { ar: [...], vw: [...], nc: [] }  — lazy, all 3 types
      mapAr: UNSET,            // { decoded, infoSize, serial, ...meta } from getAR/onAR multipackets
      arInfo: UNSET,           // raw payload from getArI/onArI (area information)
      mapInfo: UNSET           // raw payload from getMI/onMI (map information)
    };

    // Tracks which commands have been requested but not yet answered,
    // so lazy-load does not flood the device with repeated requests.
    this._pendingRequests = new Set();

    // Per-topic chunk buffers for multipacket binary topics (e.g. getAR/onAR).
    this._binaryTopicBuffers = new Map();

    // Set by Api2Factory.connectDevice() to forward explicit write commands.
    this._sendCommand = null;
  }

  // ─── EventEmitter override ────────────────────────────────────────────────

  /**
   * Subscribes to a device event.  When subscribing to a known state key
   * (e.g. 'stats') and no value has been received yet, automatically triggers
   * a lazy-load request so the first value arrives without needing to call
   * the corresponding getter explicitly.
   */
  on(event, listener) {
    super.on(event, listener);
    if (this._isStateEvent(event) && this._state[event] === UNSET && !this._isPassiveStateKey(event)) {
      if (event === "areaSet") {
        this._requestAllAreaSetTypes();
      } else {
        this._requestData(this._commandForState(event));
      }
    }
    return this;
  }

  once(event, listener) {
    super.once(event, listener);
    if (this._isStateEvent(event) && this._state[event] === UNSET && !this._isPassiveStateKey(event)) {
      if (event === "areaSet") {
        this._requestAllAreaSetTypes();
      } else {
        this._requestData(this._commandForState(event));
      }
    }
    return this;
  }

  /** Returns true when the event name matches a tracked state key. */
  _isStateEvent(event) {
    return Object.prototype.hasOwnProperty.call(this._state, event);
  }

  _isPassiveStateKey(key) {
    return key === "mapAr" || key === "arInfo" || key === "mapInfo";
  }

  // ─── Device identity getters ──────────────────────────────────────────────

  get isConnected() {
    return Number(this.rawDevice.status) === 1;
  }

  get id() {
    return this.rawDevice.did || null;
  }

  get name() {
    const baseName = String(
      this.rawDevice.deviceName || this.rawDevice.name || this.id || "Unknown Device"
    ).trim();
    const nickname = this.nickName;
    return nickname ? `${baseName} (${nickname})` : baseName;
  }

  get nickName() {
    const nick = this.rawDevice.nick;
    if (typeof nick !== "string") return null;
    const trimmed = nick.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  get className() {
    return this.rawDevice.class || null;
  }

  get productCategory() {
    return this.rawDevice.product_category || null;
  }

  // ─── State: stats / lastTimeStats / totalStats ──────────────────────────

  /** Returns current stats or null; auto-polls via getStats if not yet received. */
  getStats() {
    return this._getOrRequest("stats");
  }

  /** Returns current lastTimeStats or null; auto-polls via getLastTimeStats if not yet received. */
  getLastTimeStats() {
    return this._getOrRequest("lastTimeStats");
  }

  /** Returns current totalStats or null; auto-polls via getTotalStats if not yet received. */
  getTotalStats() {
    return this._getOrRequest("totalStats");
  }

  // ─── State: battery / chargeState / chargeInfo ───────────────────────────

  /** Returns current battery state or null; auto-polls via getBattery if not yet received. */
  getBattery() {
    return this._getOrRequest("battery");
  }

  /** Returns current goat(robot) position or null; auto-polls via getPos if not yet received. */
  getGoatPosition() {
    return this._getOrRequest("goatPosition");
  }

  /** Returns current charge(dock) positions or null; auto-polls via getPos if not yet received. */
  getChargePosition() {
    return this._getOrRequest("chargePosition");
  }

  /** Returns current RTK positions or null; auto-polls via getPos if not yet received. */
  getRtkPosition() {
    return this._getOrRequest("rtkPosition");
  }

  /** Returns current charge state or null; auto-polls via getChargeState if not yet received. */
  getChargeState() {
    return this._getOrRequest("chargeState");
  }

  /** Returns current charge info or null; auto-polls via getChargeInfo if not yet received. */
  getChargeInfo() {
    return this._getOrRequest("chargeInfo");
  }

  /** Returns current mow info or null; auto-polls via getCleanInfo if not yet received. */
  getMowInfo() {
    return this._getOrRequest("mowInfo");
  }

  /** Returns current mapped mow state (`clean` -> `mow`) or null. */
  getMowState() {
    return this.getMowInfo()?.state ?? null;
  }

  // ─── State: geolocation / protectState / netInfo / sleep / error / lifeSpan

  /** Returns current geolocation or null; auto-polls via getGeolocation if not yet received. */
  getGeolocation() {
    return this._getOrRequest("geolocation");
  }

  /** Returns current protect state or null; auto-polls via getProtectState if not yet received. */
  getProtectState() {
    return this._getOrRequest("protectState");
  }

  /** Returns current net info or null; auto-polls via getNetInfo if not yet received. */
  getNetInfo() {
    return this._getOrRequest("netInfo");
  }

  /** Returns current sleep state or null; auto-polls via getSleep if not yet received. */
  getSleep() {
    return this._getOrRequest("sleep");
  }

  /** Returns current error state or null; auto-polls via getError if not yet received. */
  getError() {
    return this._getOrRequest("error");
  }

  /** Returns current life span or null; auto-polls via getLifeSpan if not yet received. */
  getLifeSpan() {
    return this._getOrRequest("lifeSpan");
  }

  // ─── State: direct info-fields (with getInfo fallback support) ───────────

  getCutEfficiency() {
    return this._getOrRequest("cutEfficiency");
  }

  getObstacleHeight() {
    return this._getOrRequest("obstacleHeight");
  }

  getCutHeight() {
    return this._getOrRequest("cutHeight");
  }

  getCutDirection() {
    return this._getOrRequest("cutDirection");
  }

  getAutoCutDirection() {
    return this._getOrRequest("autoCutDirection");
  }

  getRainDelay() {
    return this._getOrRequest("rainDelay");
  }

  getAnimProtect() {
    return this._getOrRequest("animProtect");
  }

  getTimeZone() {
    return this._getOrRequest("timeZone");
  }

  getCustomCutMode() {
    return this._getOrRequest("customCutMode");
  }

  getBorderSwitch() {
    return this._getOrRequest("borderSwitch");
  }

  /** Returns current area parameters or null; auto-polls via getAreaParameter if not yet received. */
  getAreaParameters() {
    return this._getOrRequest("areaParameters");
  }

  /** Returns full areaSet object { ar, vw, nc } or null; triggers all 3 getAreaSet commands. */
  getAreaSet() {
    if (this._state.areaSet === UNSET) {
      this._requestAllAreaSetTypes();
    }
    return this._state.areaSet === UNSET ? null : this._state.areaSet;
  }

  /** Convenience: returns only the spotArea / mowing-area entries. */
  getAreas() {
    return this.getAreaSet()?.ar ?? null;
  }

  /** Convenience: returns only the virtual-wall entries. */
  getVirtualWalls() {
    return this.getAreaSet()?.vw ?? null;
  }

  /** Convenience: returns only the no-go-zone entries. */
  getNoCrossZones() {
    return this.getAreaSet()?.nc ?? null;
  }

  /** Returns decoded map payload from onAR/getAR or null; passive (no automatic poll command). */
  getMapAr() {
    return this._state.mapAr === UNSET ? null : this._state.mapAr;
  }

  /** Returns cached area information payload or null; no automatic poll. */
  getArInfo() {
    return this._state.arInfo === UNSET ? null : this._state.arInfo;
  }

  /** Returns cached map information payload or null; no automatic poll. */
  getMapInfo() {
    return this._state.mapInfo === UNSET ? null : this._state.mapInfo;
  }

  /** Requests getArI with explicit type and returns command response. Default type is "0" for full area info. */
  async requestArInfo(type = "0") {
    const data = (type && typeof type === "object" && !Array.isArray(type))
      ? type
      : { type: String(type), aid: "0" };
    return this.sendCommand({ name: "getArI", data });
  }

  /** Requests getMI with explicit type and returns command response. Default type is "0" for full map info. */
  async requestMapInfo(type = "0") {
    const data = (type && typeof type === "object" && !Array.isArray(type))
      ? type
      : { type: String(type) };
    return this.sendCommand({ name: "getMI", data });
  }

  // ─── Write commands (setters) ─────────────────────────────────────────────

  /** Internal hook used by the factory to inject the real command sender. */
  setCommandSender(sender) {
    this._sendCommand = typeof sender === "function" ? sender : null;
    return this;
  }

  /** Sends a raw command entry through the connected command sender. */
  async sendCommand(commandEntry) {
    if (!this._sendCommand) {
      throw new Error("Device command sender is not connected. Call factory.connectDevice(device) first.");
    }

    return this._sendCommand(commandEntry);
  }

  /**
   * Sets obstacle height level and triggers a refresh request afterward.
   * @param {number} level
   */
  async setObstacleHeight(level) {
    const numericLevel = Number(level);
    if (!Number.isFinite(numericLevel)) {
      throw new Error("setObstacleHeight(level) requires a numeric level.");
    }

    const response = await this.sendCommand({
      name: "setObstacleHeight",
      data: { level: numericLevel }
    });

    // Request fresh value so state/event updates reflect the effective value.
    this._requestData("getObstacleHeight");
    return response;
  }

  /**
   * Sets cut height level and triggers a refresh request afterward.
   * @param {number} level
   */
  async setCutHeight(level) {
    const numericLevel = Number(level);
    if (!Number.isFinite(numericLevel)) {
      throw new Error("setCutHeight(level) requires a numeric level.");
    }

    const response = await this.sendCommand({
      name: "setCutHeight",
      data: { level: numericLevel }
    });

    this._requestData("getCutHeight");
    return response;
  }

  /**
   * Sets cut direction and triggers a refresh request afterward.
   * Accepts either (angle, set) or a payload object { angle, set }.
   * @param {number|{angle:number,set:number}} angleOrData
   * @param {number} [set=1]
   */
  async setCutDirection(angleOrData, set = 1) {
    let data;
    if (angleOrData && typeof angleOrData === "object" && !Array.isArray(angleOrData)) {
      data = {
        angle: Number(angleOrData.angle),
        set: Number(angleOrData.set)
      };
    } else {
      data = {
        angle: Number(angleOrData),
        set: Number(set)
      };
    }

    if (!Number.isFinite(data.angle) || !Number.isFinite(data.set)) {
      throw new Error("setCutDirection(...) requires numeric angle and set values.");
    }

    const response = await this.sendCommand({
      name: "setCutDirection",
      data
    });

    this._requestData("getCutDirection");
    return response;
  }

  /**
   * Sets rain delay and triggers a refresh request afterward.
   * Accepts either (delay, enable) or a payload object { delay, enable }.
   * @param {number|{delay:number,enable:number}} delayOrData
   * @param {number} [enable=1]
   */
  async setRainDelay(delayOrData, enable = 1) {
    let data;
    if (delayOrData && typeof delayOrData === "object" && !Array.isArray(delayOrData)) {
      data = {
        delay: Number(delayOrData.delay),
        enable: Number(delayOrData.enable)
      };
    } else {
      data = {
        delay: Number(delayOrData),
        enable: Number(enable)
      };
    }

    if (!Number.isFinite(data.delay) || !Number.isFinite(data.enable)) {
      throw new Error("setRainDelay(...) requires numeric delay and enable values.");
    }

    const response = await this.sendCommand({
      name: "setRainDelay",
      data
    });

    this._requestData("getRainDelay");
    return response;
  }

  /**
   * Sets border switch mode and triggers a refresh request afterward.
   * Accepts either (mode, enable) or a payload object { mode, enable }.
   * @param {number|{mode:number,enable:number}} modeOrData
   * @param {number} [enable=1]
   */
  async setBorderSwitch(modeOrData, enable = 1) {
    let data;
    if (modeOrData && typeof modeOrData === "object" && !Array.isArray(modeOrData)) {
      data = {
        mode: Number(modeOrData.mode),
        enable: Number(modeOrData.enable)
      };
    } else {
      data = {
        mode: Number(modeOrData),
        enable: Number(enable)
      };
    }

    if (!Number.isFinite(data.mode) || !Number.isFinite(data.enable)) {
      throw new Error("setBorderSwitch(...) requires numeric mode and enable values.");
    }

    const response = await this.sendCommand({
      name: "setBorderSwitch",
      data
    });

    this._requestData("getBorderSwitch");
    return response;
  }

  /** Generic lazy-get helper: returns state value or null and fires request if UNSET. */
  _getOrRequest(key) {
    if (this._state[key] === UNSET) {
      this._requestData(this._commandForState(key));
    }
    return this._state[key] === UNSET ? null : this._state[key];
  }

  // ─── Internal: state management ──────────────────────────────────────────

  /**
   * Called by the connection layer when a parsed MQTT message arrives.
   * @param {string} topicName - Logical topic name (e.g. 'onStats', 'getStats')
   * @param {*} data - Already-parsed payload data
   */
  _ingestTopicData(topicName, data) {
    switch (topicName) {
      case "getPos":
      case "onPos": {
        const nextPositions = this._normalizePositions(data);
        this._updateState("goatPosition", nextPositions.goatPosition);
        this._updateState("chargePosition", nextPositions.chargePosition);
        this._updateState("rtkPosition", nextPositions.rtkPosition);
        break;
      }
      case "getStats":
      case "onStats":
        this._updateState("stats", data);
        break;
      case "getLastTimeStats":
      case "onLastTimeStats":
        this._updateState("lastTimeStats", data);
        break;
      case "getTotalStats":
        this._updateState("totalStats", data);
        break;
      case "getBattery":
      case "onBattery":
        this._updateState("battery", data);
        break;
      case "getChargeState":
      case "onChargeState":
        this._updateState("chargeState", data);
        break;
      case "getChargeInfo":
      case "onChargeInfo":
        this._updateState("chargeInfo", data);
        break;
      case "getCleanInfo":
      case "onCleanInfo": {
        const normalizedMowInfo = this._normalizeMowInfo(data);
        if (normalizedMowInfo) this._updateState("mowInfo", normalizedMowInfo);
        break;
      }
      case "getGeolocation":
        this._updateState("geolocation", data);
        break;
      case "getProtectState":
      case "onProtectState":
        this._updateState("protectState", data);
        break;
      case "getNetInfo":
        this._updateState("netInfo", data);
        break;
      case "getSleep":
        this._updateState("sleep", data);
        break;
      case "getError":
      case "onError":
        this._updateState("error", data);
        break;
      case "getLifeSpan":
        this._updateState("lifeSpan", data);
        break;
      case "getCutEfficiency":
        this._updateState("cutEfficiency", data);
        break;
      case "getObstacleHeight":
        this._updateState("obstacleHeight", data);
        break;
      case "getCutHeight":
        this._updateState("cutHeight", data);
        break;
      case "getCutDirection":
        this._updateState("cutDirection", data);
        break;
      case "getAutoCutDirection":
        this._updateState("autoCutDirection", data);
        break;
      case "getRainDelay":
        this._updateState("rainDelay", data);
        break;
      case "getAnimProtect":
        this._updateState("animProtect", data);
        break;
      case "getTimeZone":
        this._updateState("timeZone", data);
        break;
      case "getCustomCutMode":
        this._updateState("customCutMode", data);
        break;
      case "getBorderSwitch":
        this._updateState("borderSwitch", data);
        break;
      case "getAreaSet":
      case "onAreaSet": {
        // Each response carries one type (ar/vw/nc); accumulate into a single state object.
        if (data && data.type) {
          try {
            const decoded = decodeAreaSetPayload(data);
            if (decoded) {
              const current = this._state.areaSet === UNSET
                ? { ar: [], vw: [], nc: [] }
                : { ...(this._state.areaSet || { ar: [], vw: [], nc: [] }) };
              current[decoded.type] = decoded.items;
              this._updateState("areaSet", current);

              // Enrich already-known area parameters with names from areaSet.ar.
              if (this._state.areaParameters !== UNSET && Array.isArray(this._state.areaParameters)) {
                const mergedAreas = this._mergeAreaParametersWithAreaSet(this._state.areaParameters, current);
                this._updateState("areaParameters", mergedAreas);
              }

              // Clear the per-type pending key so re-polling works correctly.
              this._pendingRequests.delete(`getAreaSet:${decoded.type}`);
            }
          } catch (err) {
            // Decode failure: emit as unknownTopic so the consumer can still react.
            this.emit("unknownTopic", { topicName, data, error: err.message });
          }
        }
        break;
      }
      case "getAR":
      case "onAR": {
        if (this._isBinaryTopicChunk(data)) {
          this._ingestBinaryTopicChunk(topicName, data, "mapAr");
        } else if (data && typeof data === "object") {
          this._updateState("mapAr", {
            topic: topicName,
            serial: data.serial ?? null,
            infoSize: data.infoSize ?? null,
            batid: data.batid ?? null,
            mid: data.mid ?? null,
            aid: data.aid ?? null,
            mapSetType: data.mapSetType ?? data.type ?? null,
            decoded: data
          });
        }
        break;
      }
      case "getArI":
      case "onArI": {
        if (this._isBinaryTopicChunk(data)) {
          this._ingestBinaryTopicChunk(topicName, data, "arInfo");
        } else if (data && typeof data === "object") {
          this._updateState("arInfo", data);
        }
        break;
      }
      case "getMI":
      case "onMI": {
        if (this._isBinaryTopicChunk(data)) {
          this._ingestBinaryTopicChunk(topicName, data, "mapInfo");
        } else if (data && typeof data === "object") {
          this._updateState("mapInfo", data);
        }
        break;
      }
      case "getAreaParameter":
      case "onAreaParameter": {
        // getAreaParameter returns { areaParameters: [...] }
        // onAreaParameter may return the array directly or wrapped
        const rawItems = Array.isArray(data)
          ? data
          : (Array.isArray(data?.areaParameters) ? data.areaParameters : null);
        const normalizedAreas = rawItems ? this._normalizeAreaParameters(rawItems) : null;
        if (normalizedAreas) this._updateState("areaParameters", normalizedAreas);
        break;
      }
      case "onFwBuryPoint-bd_setting": {
        // bd_setting fires spontaneously and contains AreaParameters array.
        const rawAreas = data?.AreaParameters;
        if (Array.isArray(rawAreas) && rawAreas.length > 0) {
          const normalizedAreas = this._normalizeAreaParameters(rawAreas);
          if (normalizedAreas) this._updateState("areaParameters", normalizedAreas);
        }
        break;
      }
      case "getInfo":
        this._ingestGetInfoData(data);
        break;
      default:
        // Emit a generic 'unknownTopic' event so the consumer can react if needed.
        this.emit("unknownTopic", { topicName, data });
        break;
    }
  }

  /**
   * Handles getInfo nested payloads and routes each nested getXxx result
   * through the same direct topic pipeline, so state logic stays unified.
   */
  _ingestGetInfoData(data) {
    if (!data || typeof data !== "object") return;

    for (const [nestedTopicName, nestedPayload] of Object.entries(data)) {
      if (!nestedTopicName.startsWith("get")) continue;
      const nestedData = nestedPayload?.data ?? null;
      this._ingestTopicData(nestedTopicName, nestedData);
    }
  }

  /**
   * Updates a single state field and emits a change event if the value differs.
   * @param {string} key - State field name (must exist in this._state)
   * @param {*} newValue - New parsed value
   */
  _updateState(key, newValue) {
    const prev = this._state[key];
    if (stateEqual(prev, newValue)) return;
    this._state[key] = newValue;
    // Clear pending request using the command entry's name.
    const cmd = this._commandForState(key);
    const cmdName = typeof cmd === "string" ? cmd : cmd.name;
    this._pendingRequests.delete(cmdName);
    this.emit(key, newValue);
  }

  /**
   * Fires the internal '_requestData' event so the connection layer can send
   * the corresponding device command.  Deduplicates concurrent requests.
   * The command entry is passed through as-is so the factory can forward
   * objects with extra body data (e.g. { name: 'getLifeSpan', data: {...} }).
   * @param {string|{name:string,data:object}} commandEntry
   */
  _requestData(commandEntry) {
    const key = typeof commandEntry === "string" ? commandEntry : commandEntry.name;
    if (this._pendingRequests.has(key)) return;
    this._pendingRequests.add(key);
    // Async emit so the caller's call-stack finishes first.
    setImmediate(() => this.emit("_requestData", commandEntry));
  }

  /**
   * Fires one getAreaSet command per type (ar, vw, nc), each deduplicated separately.
   * Tracks pending requests per type so repeated calls do not re-send in-flight commands.
   */
  _requestAllAreaSetTypes() {
    for (const type of ["ar", "vw", "nc"]) {
      const pendingKey = `getAreaSet:${type}`;
      if (!this._pendingRequests.has(pendingKey)) {
        this._pendingRequests.add(pendingKey);
        setImmediate(() => this.emit("_requestData", { name: "getAreaSet", data: { mid: "1", aid: "0", type } }));
      }
    }
  }

  /**
   * Maps a state key back to its primary poll command name.
   * Override entries where the command name does not follow the default
   * get<Key> convention.
   * @param {string} key - State field name
   * @returns {string}
   */
  _commandForState(key) {
    // Returns a string command name or a { name, data } object for commands
    // that require extra body data.
    const map = {
      lifeSpan: { name: "getLifeSpan", data: { type: ["blade", "lensBrush"] } },
      mowInfo: "getCleanInfo",
      goatPosition: "getPos",
      chargePosition: "getPos",
      rtkPosition: "getPos",
      areaParameters: "getAreaParameter"
      // areaSet is handled by _requestAllAreaSetTypes() — not routed via _commandForState
    };
    return map[key] ?? `get${key.charAt(0).toUpperCase()}${key.slice(1)}`;
  }

  _isBinaryTopicChunk(data) {
    return Boolean(
      data &&
      typeof data === "object" &&
      data.serial !== undefined &&
      data.index !== undefined &&
      data.infoSize !== undefined &&
      typeof data.info === "string"
    );
  }

  _ingestBinaryTopicChunk(topicName, chunkData, targetStateKey) {
    this._pruneBinaryTopicBuffers();

    const bufferKey = this._binaryTopicBufferKey(topicName, chunkData);
    const existing = this._binaryTopicBuffers.get(bufferKey) || {
      expectedSize: 0,
      expectedChunkCount: 0,
      chunks: new Map(),
      updatedAt: Date.now(),
      meta: {
        topic: topicName,
        batid: chunkData?.batid ?? null,
        mid: chunkData?.mid ?? null,
        aid: chunkData?.aid ?? null,
        mapSetType: chunkData?.mapSetType ?? chunkData?.type ?? null
      }
    };

    existing.expectedSize = Number(chunkData.infoSize) || 0;
    existing.expectedChunkCount = Number(chunkData.serial) || 0;
    existing.updatedAt = Date.now();

    const chunkIndex = Number(chunkData.index);
    if (Number.isFinite(chunkIndex) && chunkIndex >= 0) {
      existing.chunks.set(chunkIndex, String(chunkData.info));
    }

    this._binaryTopicBuffers.set(bufferKey, existing);

    const assembledBase64 = this._assembleBinaryTopicBuffer(existing);
    if (assembledBase64 === null) return;

    this._binaryTopicBuffers.delete(bufferKey);

    try {
      const decoded = decodeBinaryTopicBase64(assembledBase64, existing.expectedSize);
      this._updateState(targetStateKey, {
        ...existing.meta,
        serial: existing.expectedChunkCount,
        infoSize: existing.expectedSize,
        decoded
      });
    } catch (error) {
      this.emit("unknownTopic", {
        topicName,
        data: chunkData,
        error: error?.message || String(error)
      });
    }
  }

  _binaryTopicBufferKey(topicName, chunkData) {
    return [
      topicName,
      chunkData?.batid || "",
      chunkData?.mid || "",
      chunkData?.aid || "",
      chunkData?.mapSetType || chunkData?.type || ""
    ].join(":");
  }

  _assembleBinaryTopicBuffer(binaryTopicBuffer) {
    if (!Number.isFinite(binaryTopicBuffer.expectedSize) || binaryTopicBuffer.expectedSize <= 0) {
      return null;
    }

    const orderedChunks = [...binaryTopicBuffer.chunks.entries()].sort((left, right) => left[0] - right[0]);
    if (orderedChunks.length === 0 || orderedChunks[0][0] !== 0) {
      return null;
    }

    if (
      Number.isFinite(binaryTopicBuffer.expectedChunkCount) &&
      binaryTopicBuffer.expectedChunkCount > 0 &&
      orderedChunks.length >= binaryTopicBuffer.expectedChunkCount &&
      orderedChunks[binaryTopicBuffer.expectedChunkCount - 1]?.[0] === binaryTopicBuffer.expectedChunkCount - 1
    ) {
      return orderedChunks
        .slice(0, binaryTopicBuffer.expectedChunkCount)
        .map(([, chunkValue]) => chunkValue)
        .join("");
    }

    let assembledBase64 = "";
    for (let expectedIndex = 0; expectedIndex < orderedChunks.length; expectedIndex += 1) {
      const [chunkIndex, chunkValue] = orderedChunks[expectedIndex];
      if (chunkIndex !== expectedIndex) {
        return null;
      }

      assembledBase64 += chunkValue;

      const decodedByteLength = Buffer.from(assembledBase64, "base64").length;
      if (assembledBase64.length >= binaryTopicBuffer.expectedSize) {
        return assembledBase64.slice(0, binaryTopicBuffer.expectedSize);
      }

      if (decodedByteLength >= binaryTopicBuffer.expectedSize) {
        return assembledBase64;
      }
    }

    return null;
  }

  _pruneBinaryTopicBuffers() {
    const expireBefore = Date.now() - (10 * 60 * 1000);
    for (const [key, buffer] of this._binaryTopicBuffers.entries()) {
      if ((buffer?.updatedAt || 0) < expireBefore) {
        this._binaryTopicBuffers.delete(key);
      }
    }
  }

  _normalizeAreaParameters(data) {
    const items = Array.isArray(data) ? data : (data && typeof data === "object" ? [data] : []);
    if (items.length === 0) return null;

    const normalized = items
      .map((item) => ({
        areaId: item.areaID != null ? Number(item.areaID) : (item.areaId != null ? Number(item.areaId) : null),
        cutMode: item.cutMode ?? null,
        mowHeightLevel: item.mowHeightLevel ?? null,
        obstacleHeight: item.obstacleHeight ?? null
      }))
      .filter((area) => area.areaId !== null && Number.isFinite(area.areaId))
      .sort((a, b) => a.areaId - b.areaId);

    if (normalized.length === 0) return null;
    return this._mergeAreaParametersWithAreaSet(normalized, this._state.areaSet === UNSET ? null : this._state.areaSet);
  }

  _mergeAreaParametersWithAreaSet(areaParameters, areaSet) {
    if (!Array.isArray(areaParameters)) return areaParameters;
    if (!areaSet || !Array.isArray(areaSet.ar)) return areaParameters;

    const areaNames = new Map();
    for (const areaEntry of areaSet.ar) {
      const areaId = Number(areaEntry?.areaId);
      const name = typeof areaEntry?.name === "string" ? areaEntry.name : "";
      if (!Number.isFinite(areaId) || name.length === 0 || areaNames.has(areaId)) continue;
      areaNames.set(areaId, name);
    }

    return areaParameters.map((area) => {
      const mergedName = areaNames.get(area.areaId) ?? area.name ?? "";
      return {
        ...area,
        name: mergedName
      };
    });
  }

  _normalizeMowInfo(data) {
    if (!data || typeof data !== "object") return null;
    if (typeof data.state === "undefined") return null;

    return {
      trigger: data.trigger ?? null,
      other: data.other ?? null,
      state: this._toMowState(data.state),
      type: this._toMowType(data.cleanState),
      cleanState: data.cleanState ?? null
    };
  }

  _toMowState(stateValue) {
    return stateValue === "clean" ? "mow" : stateValue;
  }

  _toMowType(cleanState) {
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

  _normalizePositions(data) {
    if (!data || typeof data !== "object") {
      return {
        goatPosition: null,
        chargePosition: null,
        rtkPosition: null
      };
    }

    const goatCandidate = data.deebotPos ?? data.goatPos ?? data.robotPos ?? data.pos ?? data.position ?? data;
    const goatPosition = this._normalizePose(goatCandidate);

    const chargeRaw = data.chargePos ?? data.chargePosition ?? data.dockPos ?? data.dockPosition;
    const chargePosition = this._normalizePoseArray(chargeRaw);

    const rtkRaw = data.rtkPos ?? data.rtkPosition ?? data.gnssPos ?? data.gnssPosition;
    const rtkPosition = this._normalizePoseArray(rtkRaw);

    return {
      goatPosition,
      chargePosition,
      rtkPosition
    };
  }

  _normalizePose(candidate) {
    if (!candidate || typeof candidate !== "object") return null;

    const x = this._pickNumeric(candidate, ["x", "X", "posX", "px"]);
    const y = this._pickNumeric(candidate, ["y", "Y", "posY", "py"]);
    const a = this._pickNumeric(candidate, ["a", "A", "angle", "theta", "yaw", "posA", "pa"]);

    if (x === null || y === null) return null;

    const normalized = {
      ...candidate,
      x,
      y,
      a: a ?? 0
    };

    return normalized;
  }

  _normalizePoseArray(rawValue) {
    const items = Array.isArray(rawValue) ? rawValue : rawValue ? [rawValue] : [];
    const normalized = items
      .map((entry) => this._normalizePose(entry))
      .filter((entry) => entry !== null);

    return normalized;
  }

  _pickNumeric(source, keys) {
    for (const key of keys) {
      const value = Number(source?.[key]);
      if (Number.isFinite(value)) return value;
    }
    return null;
  }
}
