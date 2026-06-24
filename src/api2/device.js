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
      chargeInfo: UNSET      // onChargeInfo payload
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
      default:
        // Emit a generic 'unknownTopic' event so the consumer can react if needed.
        this.emit("unknownTopic", { topicName, data });
        break;
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
    this._pendingRequests.delete(this._commandForState(key));
    this.emit(key, newValue);
  }

  /**
   * Fires the internal '_requestData' event so the connection layer can send
   * the corresponding device command.  Deduplicates concurrent requests.
   * @param {string} commandName - e.g. 'getStats'
   */
  _requestData(commandName) {
    if (this._pendingRequests.has(commandName)) return;
    this._pendingRequests.add(commandName);
    // Async emit so the caller's call-stack finishes first.
    setImmediate(() => this.emit("_requestData", commandName));
  }

  /**
   * Maps a state key back to its primary poll command name.
   * Override entries where the command name does not follow the default
   * get<Key> convention.
   * @param {string} key - State field name
   * @returns {string}
   */
  _commandForState(key) {
    // Only needed for keys where the command name differs from get<Key>.
    const map = {
      stats: "getStats",
      lastTimeStats: "getLastTimeStats",
      totalStats: "getTotalStats"
    };
    return map[key] ?? `get${key.charAt(0).toUpperCase()}${key.slice(1)}`;
  }
}
