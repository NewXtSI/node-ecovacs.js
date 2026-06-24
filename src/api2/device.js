import { EventEmitter } from "node:events";

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
      stats: UNSET,          // { time, area, mowedArea }
      lastTimeStats: UNSET,  // { cid, start, type, stop, area, time }
      totalStats: UNSET,     // { area, time, count }
      battery: UNSET,        // { value, isLow }
      chargeState: UNSET,    // { isCharging, mode }
      chargeInfo: UNSET,     // { cid, trigger, state, other }
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
      borderSwitch: UNSET     // {...}
    };

    // Tracks which commands have been requested but not yet answered,
    // so lazy-load does not flood the device with repeated requests.
    this._pendingRequests = new Set();
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
    if (this._isStateEvent(event) && this._state[event] === UNSET) {
      this._requestData(this._commandForState(event));
    }
    return this;
  }

  once(event, listener) {
    super.once(event, listener);
    if (this._isStateEvent(event) && this._state[event] === UNSET) {
      this._requestData(this._commandForState(event));
    }
    return this;
  }

  /** Returns true when the event name matches a tracked state key. */
  _isStateEvent(event) {
    return Object.prototype.hasOwnProperty.call(this._state, event);
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

  /** Returns current charge state or null; auto-polls via getChargeState if not yet received. */
  getChargeState() {
    return this._getOrRequest("chargeState");
  }

  /** Returns current charge info or null; auto-polls via getChargeInfo if not yet received. */
  getChargeInfo() {
    return this._getOrRequest("chargeInfo");
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
      lifeSpan: { name: "getLifeSpan", data: { type: ["blade", "lensBrush"] } }
    };
    return map[key] ?? `get${key.charAt(0).toUpperCase()}${key.slice(1)}`;
  }
}
