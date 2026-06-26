import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { decodeAreaSetPayload } from "./areaSetDecoder.js";
import { decodeBinaryTopicBase64 } from "./binaryTopicDecoder.js";
import { calculateBounds, generateMapSvg, transformPoint } from "./mapVisualizerSvg.js";

// Internal sentinel used to detect "no previous value yet" vs. an actual null state.
const UNSET = Symbol("UNSET");

// Known ATR/API topics seen in the field but not yet fully modeled in Api2Device.
// They are emitted via `topicBacklog` for visibility and future parser implementation.
const KNOWN_BACKLOG_TOPICS = new Set([
  "GetWKVer",
  "getNetworkSwitch",
  "getOta",
  "getRTKOta",
  "getMapState",
  "getPIN",
  "appping",
  "getRTK",
  "getCachedMapInfo",
  "getBreakPointStatus",
  "getMoveCtrlState",
  "getSchedules",
  "getRelocationState",
  "getRobotFeature",
  "getMoveupWarning",
  "getCrossMapBorderWarning",
  "getMapTrace",
  "getScheduleTaskInfo",
  "getScheduleLatestTask",
  "onScheduleLatestTask",
  "getGnss",
  "onGnss",
  "getRemoteSupport",
  "onRemoteSupport",
  "getRecognization",
  "getWifiList"
]);

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
      mowCommand: UNSET,     // { command, data, content, parsed, ts }
      fwBuryPoints: UNSET,   // { [substate]: payloadWithoutProtocolMeta }
      rtk: UNSET,            // getRTK/onRTK payload
      networkSwitch: UNSET,  // getNetworkSwitch/onNetworkSwitch
      ota: UNSET,            // getOta/onOta
      rtkOta: UNSET,         // getRTKOta/onRTKOta
      mapState: UNSET,       // getMapState/onMapState
      pin: UNSET,            // getPIN/onPIN
      breakPointStatus: UNSET, // getBreakPointStatus/onBreakPointStatus
      moveCtrlState: UNSET,  // getMoveCtrlState/onMoveCtrlState
      robotFeature: UNSET,   // getRobotFeature/onRobotFeature
      moveupWarning: UNSET,  // getMoveupWarning/onMoveupWarning
      crossMapBorderWarning: UNSET, // getCrossMapBorderWarning/onCrossMapBorderWarning
      relocationState: UNSET, // getRelocationState/onRelocationState
      scheduleTaskInfo: UNSET, // getScheduleTaskInfo/onScheduleTaskInfo
      scheduleLatestTask: UNSET, // getScheduleLatestTask/onScheduleLatestTask
      geolocation: UNSET,    // { enable, geoLocation: { longitude, latitude } }
      protectState: UNSET,   // onProtectState payload
      netInfo: UNSET,        // { ip, ssid, rssi, wkVer, mac }
      sleep: UNSET,          // { enable }
      error: UNSET,          // { code: [...] }
      lifeSpan: UNSET,       // { blade: { left, total }, ... }
      volume: UNSET,         // { volume } / { level } / { value }
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
      mapInfo: UNSET,          // raw payload from getMI/onMI (map information)
      goatMap: UNSET,          // { svg, mapInfo, arInfo, bounds, viewBox, generatedAt }
      deviceMap: UNSET         // { svg, viewBox, fingerprint, generatedAt }
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
    if ((event === "deviceMap" || event === "onDeviceMap") && this._state.deviceMap === UNSET) {
      this._requestDeviceMapDependencies();
      this._refreshDeviceMap();
      return this;
    }
    if ((event === "goatMap" || event === "onGoatMap") && this._state.goatMap === UNSET) {
      this._requestGoatMapDependencies();
      this._refreshGoatMap();
      return this;
    }
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
    if ((event === "deviceMap" || event === "onDeviceMap") && this._state.deviceMap === UNSET) {
      this._requestDeviceMapDependencies();
      this._refreshDeviceMap();
      return this;
    }
    if ((event === "goatMap" || event === "onGoatMap") && this._state.goatMap === UNSET) {
      this._requestGoatMapDependencies();
      this._refreshGoatMap();
      return this;
    }
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
    return key === "mapAr" || key === "arInfo" || key === "mapInfo" || key === "goatMap" || key === "deviceMap" || key === "mowCommand" || key === "fwBuryPoints";
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

  /** Returns latest acknowledged mow command payload or null; passive (no automatic poll command). */
  getMowCommand() {
    return this._state.mowCommand === UNSET ? null : this._state.mowCommand;
  }

  /** Returns latest RTK payload or null; auto-polls via getRTK if not yet received. */
  getRtk() {
    return this._getOrRequest("rtk");
  }

  getNetworkSwitch() {
    return this._getOrRequest("networkSwitch");
  }

  getOta() {
    return this._getOrRequest("ota");
  }

  getRtkOta() {
    return this._getOrRequest("rtkOta");
  }

  getMapState() {
    return this._getOrRequest("mapState");
  }

  getPin() {
    return this._getOrRequest("pin");
  }

  getBreakPointStatus() {
    return this._getOrRequest("breakPointStatus");
  }

  getMoveCtrlState() {
    return this._getOrRequest("moveCtrlState");
  }

  getRobotFeature() {
    return this._getOrRequest("robotFeature");
  }

  getMoveupWarning() {
    return this._getOrRequest("moveupWarning");
  }

  getCrossMapBorderWarning() {
    return this._getOrRequest("crossMapBorderWarning");
  }

  getRelocationState() {
    return this._getOrRequest("relocationState");
  }

  getScheduleTaskInfo() {
    return this._getOrRequest("scheduleTaskInfo");
  }

  getScheduleLatestTask() {
    return this._getOrRequest("scheduleLatestTask");
  }

  /** Returns all cached FwBuryPoint substates or null; passive (event driven). */
  getFwBuryPoints() {
    return this._state.fwBuryPoints === UNSET ? null : this._state.fwBuryPoints;
  }

  /** Returns one cached FwBuryPoint substate payload or null. */
  getFwBuryPoint(substate) {
    if (!substate) return null;
    const all = this.getFwBuryPoints();
    if (!all) return null;
    return all[substate] ?? null;
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

  /** Returns current volume or null; auto-polls via getVolume if not yet received. */
  getVolume() {
    return this._getOrRequest("volume");
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

  /**
   * Returns generated goat map payload or null.
   * Lazy-requests getMI/getArI and becomes available once both are decoded.
   */
  getGoatMap() {
    if (this._state.goatMap === UNSET) {
      this._requestGoatMapDependencies();
      this._refreshGoatMap();
    }
    return this._state.goatMap === UNSET ? null : this._state.goatMap;
  }

  /**
   * Returns generated device position map payload or null.
   * Uses goatMap viewBox and overlays goat/charger/rtk markers.
   */
  getDeviceMap() {
    if (this._state.deviceMap === UNSET) {
      this._requestDeviceMapDependencies();
      this._refreshDeviceMap();
    }
    return this._state.deviceMap === UNSET ? null : this._state.deviceMap;
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

  /**
   * Sends a generic mowing command through the underlying "clean" command channel.
   * command examples: start, stop, pause, resume
   */
  async mow(command, data = null) {
    const commandName = String(command || "").trim();
    if (!commandName) {
      throw new Error("mow(command, data) requires a non-empty command.");
    }

    const payload = { act: commandName };
    if (data && typeof data === "object" && !Array.isArray(data)) {
      payload.content = data;
    }

    const response = await this.sendCommand({
      name: "clean",
      data: payload
    });

    this._requestData("getCleanInfo");
    return response;
  }

  _getCurrentMowTypeFallback() {
    return this.getMowInfo()?.type || this.getMowCommand()?.content?.type || "spotArea";
  }

  _normalizeAreaIds(areaIds) {
    if (typeof areaIds === "string") {
      const ids = areaIds
        .split(",")
        .map((entry) => Number(entry.trim()))
        .filter((id) => Number.isFinite(id));
      if (ids.length === 0) {
        throw new Error("mowArea requires at least one numeric area id.");
      }
      return ids;
    }

    if (Array.isArray(areaIds)) {
      const ids = areaIds
        .map((id) => Number(id))
        .filter((id) => Number.isFinite(id));
      if (ids.length === 0) {
        throw new Error("mowArea requires at least one numeric area id.");
      }
      return ids;
    }

    throw new Error("mowArea expects an array of ids or comma-separated id string.");
  }

  _normalizeBorderValue(target) {
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

      if (target.every((entry) => Number.isFinite(Number(entry)))) {
        return target.map((entry) => `aid:${Number(entry)}`).join(";");
      }

      const values = target
        .map((entry) => String(entry).trim())
        .filter((entry) => entry.length > 0);
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

  _parseMowCommandValue(type, value) {
    if (type === "spotArea") {
      const spotAreaIds = typeof value === "string"
        ? value.split(",").map((entry) => Number(entry.trim())).filter((id) => Number.isFinite(id))
        : [];
      return {
        spotAreaIds,
        borderAreaIds: [],
        borderVirtualIds: [],
        unknownBorderTokens: []
      };
    }

    if (type === "border") {
      const result = {
        spotAreaIds: [],
        borderAreaIds: [],
        borderVirtualIds: [],
        unknownBorderTokens: []
      };

      if (typeof value !== "string" || value.trim().length === 0) {
        return result;
      }

      const tokens = value.split(";").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
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

    return {
      spotAreaIds: [],
      borderAreaIds: [],
      borderVirtualIds: [],
      unknownBorderTokens: []
    };
  }

  async startMow() {
    return this.mow("start", { type: this._getCurrentMowTypeFallback() });
  }

  async pauseMow() {
    return this.mow("pause", { type: this._getCurrentMowTypeFallback() });
  }

  async resumeMow() {
    return this.mow("resume", { type: this._getCurrentMowTypeFallback() });
  }

  async stopMow() {
    return this.mow("stop", { type: this._getCurrentMowTypeFallback() });
  }

  async start() {
    return this.startMow();
  }

  async pause() {
    return this.pauseMow();
  }

  async resume() {
    return this.resumeMow();
  }

  async stop() {
    return this.stopMow();
  }

  async mowArea(areaIds) {
    const ids = this._normalizeAreaIds(areaIds);
    return this.mow("start", {
      type: "spotArea",
      value: ids.join(",")
    });
  }

  async mowBorder(borderIds) {
    const value = this._normalizeBorderValue(borderIds);
    return this.mow("start", {
      type: "border",
      value
    });
  }

  async dock() {
    const response = await this.sendCommand({
      name: "charge",
      data: { act: "go" }
    });
    this._requestData("getChargeState");
    this._requestData("getChargeInfo");
    return response;
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

  /**
   * Sets device volume and triggers a refresh request afterward.
   * Accepts either a number or a payload object.
   * @param {number|{volume?:number,level?:number,value?:number}} volumeOrData
   */
  async setVolume(volumeOrData) {
    let data;
    if (volumeOrData && typeof volumeOrData === "object" && !Array.isArray(volumeOrData)) {
      data = { ...volumeOrData };
    } else {
      data = { volume: Number(volumeOrData) };
    }

    const resolvedVolume = [data.volume, data.level, data.value]
      .map((value) => Number(value))
      .find((value) => Number.isFinite(value));

    if (!Number.isFinite(resolvedVolume)) {
      throw new Error("setVolume(...) requires a numeric volume/level/value.");
    }

    if (!Number.isFinite(Number(data.volume))) {
      data.volume = resolvedVolume;
    }

    const response = await this.sendCommand({
      name: "setVolume",
      data
    });

    this._requestData("getVolume");
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
      case "clean": {
        if (data && typeof data.act !== "undefined") {
          const content = data.content ?? null;
          const type = content?.type ?? null;
          const value = typeof content?.value === "string" ? content.value : "";
          this._updateState("mowCommand", {
            command: data.act,
            data,
            content,
            type,
            value,
            parsed: this._parseMowCommandValue(type, value),
            ts: Date.now()
          });
        }
        break;
      }
      case "charge": {
        // P2P command topic (not a state): emit so consumers can react to ack/command flow.
        this.emit("charge", {
          command: data?.act ?? null,
          data,
          ts: Date.now()
        });
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
      case "getVolume":
      case "onVolume":
        this._updateState("volume", data);
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

        this._ingestFwBuryPoint(topicName, data);
        break;
      }
      case "getRTK":
      case "onRTK": {
        this._updateState("rtk", data);
        break;
      }
      case "getNetworkSwitch":
      case "onNetworkSwitch":
        this._updateState("networkSwitch", data);
        break;
      case "getOta":
      case "onOta":
        this._updateState("ota", data);
        break;
      case "getRTKOta":
      case "onRTKOta":
        this._updateState("rtkOta", data);
        break;
      case "getMapState":
      case "onMapState":
        this._updateState("mapState", data);
        break;
      case "getPIN":
      case "onPIN":
        this._updateState("pin", data);
        break;
      case "getBreakPointStatus":
      case "onBreakPointStatus":
        this._updateState("breakPointStatus", data);
        break;
      case "getMoveCtrlState":
      case "onMoveCtrlState":
        this._updateState("moveCtrlState", data);
        break;
      case "getRobotFeature":
      case "onRobotFeature":
        this._updateState("robotFeature", data);
        break;
      case "getMoveupWarning":
      case "onMoveupWarning":
        this._updateState("moveupWarning", data);
        break;
      case "getCrossMapBorderWarning":
      case "onCrossMapBorderWarning":
        this._updateState("crossMapBorderWarning", data);
        break;
      case "getRelocationState":
      case "onRelocationState":
        this._updateState("relocationState", data);
        break;
      case "getScheduleTaskInfo":
      case "onScheduleTaskInfo":
        this._updateState("scheduleTaskInfo", data);
        break;
      case "getScheduleLatestTask":
      case "onScheduleLatestTask":
        this._updateState("scheduleLatestTask", data);
        break;
      case "getInfo":
        this._ingestGetInfoData(data);
        break;
      default:
        if (typeof topicName === "string" && topicName.startsWith("onFwBuryPoint-")) {
          this._ingestFwBuryPoint(topicName, data);
          break;
        }

        if (KNOWN_BACKLOG_TOPICS.has(topicName)) {
          this.emit("topicBacklog", {
            topicName,
            data
          });
          break;
        }

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

  _extractProtocolMeta(payload) {
    if (!payload || typeof payload !== "object") {
      return null;
    }

    const meta = {};
    if (typeof payload.gid !== "undefined") meta.gid = payload.gid;
    if (typeof payload.index !== "undefined") meta.index = payload.index;
    if (typeof payload.ts !== "undefined") meta.ts = payload.ts;
    return Object.keys(meta).length > 0 ? meta : null;
  }

  _stripProtocolMeta(payload) {
    if (!payload || typeof payload !== "object") {
      return payload;
    }

    const cleaned = { ...payload };
    delete cleaned.gid;
    delete cleaned.index;
    delete cleaned.ts;
    return cleaned;
  }

  _ingestFwBuryPoint(topicName, data) {
    // ATR diagnostics are frequently null; ignore empty payloads.
    if (data === null || typeof data === "undefined") {
      return;
    }

    const substate = String(topicName || "").replace("onFwBuryPoint-", "");
    if (!substate) {
      return;
    }

    const payload = this._stripProtocolMeta(data);
    const meta = this._extractProtocolMeta(data);

    const current = this._state.fwBuryPoints === UNSET
      ? {}
      : { ...this._state.fwBuryPoints };

    const previous = current[substate];
    current[substate] = payload;
    if (!stateEqual(previous, payload)) {
      this._updateState("fwBuryPoints", current);
    }

    this.emit("fwBuryPoint", {
      topicName,
      substate,
      payload,
      meta,
      rawPayload: data
    });
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
    if (key === "goatMap") {
      this.emit("onGoatMap", newValue);
    }
    if (key === "deviceMap") {
      this.emit("onDeviceMap", newValue);
    }
    if (key === "mapInfo" || key === "arInfo") {
      this._refreshGoatMap();
    }
    if (key === "goatMap" || key === "goatPosition" || key === "chargePosition" || key === "rtkPosition") {
      this._refreshDeviceMap();
    }
  }

  _requestGoatMapDependencies() {
    if (this._state.mapInfo === UNSET) {
      this._requestData({ name: "getMI", data: { type: "0" } });
    }
    if (this._state.arInfo === UNSET) {
      this._requestData({ name: "getArI", data: { type: "0", aid: "0" } });
    }
  }

  _requestDeviceMapDependencies() {
    this._requestGoatMapDependencies();
    if (this._state.goatPosition === UNSET || this._state.chargePosition === UNSET || this._state.rtkPosition === UNSET) {
      this._requestData("getPos");
    }
  }

  _extractDecodedEntries(payload) {
    if (Array.isArray(payload)) return payload;
    if (payload && typeof payload === "object" && Array.isArray(payload.decoded)) {
      return payload.decoded;
    }
    return null;
  }

  _refreshGoatMap() {
    const mapInfoEntries = this._extractDecodedEntries(this._state.mapInfo);
    const arInfoEntries = this._extractDecodedEntries(this._state.arInfo);

    if (!Array.isArray(mapInfoEntries) || !Array.isArray(arInfoEntries)) {
      return;
    }

    try {
      const svg = generateMapSvg(mapInfoEntries, { arInfo: arInfoEntries });
      const bounds = calculateBounds(mapInfoEntries, arInfoEntries);
      const viewBox = {
        minX: bounds.minX,
        minY: bounds.minY,
        width: bounds.maxX - bounds.minX,
        height: bounds.maxY - bounds.minY
      };
      const fingerprint = createHash("sha1")
        .update(JSON.stringify(mapInfoEntries))
        .update("|")
        .update(JSON.stringify(arInfoEntries))
        .digest("hex");
      this._updateState("goatMap", {
        generatedAt: new Date().toISOString(),
        fingerprint,
        svg,
        bounds,
        viewBox,
        mapInfo: mapInfoEntries,
        arInfo: arInfoEntries
      });
    } catch (error) {
      this.emit("unknownTopic", {
        topicName: "goatMap",
        data: {
          mapInfoCount: mapInfoEntries.length,
          arInfoCount: arInfoEntries.length
        },
        error: error?.message || String(error)
      });
    }
  }

  _normalizePositionArray(value) {
    if (Array.isArray(value)) return value.filter((item) => item && Number.isFinite(Number(item.x)) && Number.isFinite(Number(item.y)));
    if (value && Number.isFinite(Number(value.x)) && Number.isFinite(Number(value.y))) return [value];
    return [];
  }

  _buildDeviceMapSvg(goatMap) {
    const viewBox = goatMap?.viewBox;
    if (!viewBox) return null;

    const goat = this._normalizePositionArray(this._state.goatPosition).map((item) => ({ ...item, type: "Goat", color: "#0057ff", radius: 34 }));
    const charger = this._normalizePositionArray(this._state.chargePosition).map((item) => ({ ...item, type: "Charger", color: "#ff9500", radius: 28 }));
    const rtk = this._normalizePositionArray(this._state.rtkPosition).map((item) => ({ ...item, type: "RTK", color: "#8e8e93", radius: 24 }));
    const markers = [...goat, ...charger, ...rtk];

    if (markers.length === 0) {
      return null;
    }

    const markerSvg = markers
      .map((marker, index) => {
        const transformed = transformPoint({ x: Number(marker.x), y: Number(marker.y) });
        const x = transformed.x;
        const y = transformed.y;
        const angle = Number.isFinite(Number(marker.a)) ? Number(marker.a) + 180 : null;
        const arrowLength = marker.radius * 2.2;
        const arrowX2 = angle === null ? x : x + (Math.cos((angle * Math.PI) / 180) * arrowLength);
        const arrowY2 = angle === null ? y : y + (Math.sin((angle * Math.PI) / 180) * arrowLength);
        const label = `${marker.type}${markers.length > 1 ? ` ${index + 1}` : ""}`;

        return [
          `  <g>`,
          `    <title>${label}: x=${Number(marker.x)}, y=${Number(marker.y)}, a=${marker.a ?? "-"}</title>`,
          `    <circle cx="${x}" cy="${y}" r="${marker.radius}" fill="${marker.color}" fill-opacity="0.25" stroke="${marker.color}" stroke-width="10"/>`,
          angle === null ? "" : `    <line x1="${x}" y1="${y}" x2="${arrowX2}" y2="${arrowY2}" stroke="${marker.color}" stroke-width="12" stroke-linecap="round"/>`,
          `    <text x="${x + marker.radius + 16}" y="${y - marker.radius - 8}" fill="${marker.color}" font-size="80">${label}</text>`,
          `  </g>`
        ].filter(Boolean).join("\n");
      })
      .join("\n");

    return [
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<svg viewBox="${viewBox.minX} ${viewBox.minY} ${viewBox.width} ${viewBox.height}" xmlns="http://www.w3.org/2000/svg" width="1200" height="900">`,
      `  <defs><style>text{font-family:Arial,sans-serif;font-weight:bold}</style></defs>`,
      markerSvg,
      `  <text x="${viewBox.minX + 50}" y="${viewBox.minY + 150}" fill="#666" font-size="90">Device Map (Goat/Charger/RTK)</text>`,
      `</svg>`
    ].join("\n");
  }

  _refreshDeviceMap() {
    const goatMap = this._state.goatMap === UNSET ? null : this._state.goatMap;
    if (!goatMap) return;

    const svg = this._buildDeviceMapSvg(goatMap);
    if (!svg) return;

    const fingerprint = createHash("sha1")
      .update(String(goatMap.fingerprint || ""))
      .update("|")
      .update(JSON.stringify(this._state.goatPosition === UNSET ? null : this._state.goatPosition))
      .update("|")
      .update(JSON.stringify(this._state.chargePosition === UNSET ? null : this._state.chargePosition))
      .update("|")
      .update(JSON.stringify(this._state.rtkPosition === UNSET ? null : this._state.rtkPosition))
      .digest("hex");

    this._updateState("deviceMap", {
      generatedAt: new Date().toISOString(),
      fingerprint,
      svg,
      viewBox: goatMap.viewBox
    });
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
      rtk: "getRTK",
      rtkOta: "getRTKOta",
      pin: "getPIN",
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
