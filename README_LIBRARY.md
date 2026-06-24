# node-ecovacs-js Library

A Node.js library for controlling Ecovacs Goat robotic lawnmowers via the Ecovacs cloud API and MQTT.

## Installation

### From GitHub

```bash
npm install github:your-username/node-ecovacs-js
```

Or with yarn:

```bash
yarn add github:your-username/node-ecovacs-js
```

## Quick Start

```javascript
import { EcovacsGoatAdapter, Goat } from 'node-ecovacs-js';

const adapter = new EcovacsGoatAdapter();

// Set credentials
adapter.setCredentials('your-email@example.com', 'your-password', {
  country: 'DE'  // Optional, defaults to 'DE'
});

// Optional: runtime debug toggles (all debug flags are true by default)
adapter.setLogRawMqtt(true);
adapter.setLogDiscovery(true);
adapter.setLogBinaryTopics(true);
adapter.setLogMqttTrafficToFile(true);
adapter.setMqttTrafficLogFile('mqtt_traffic.log');

// Connect to Ecovacs cloud
await adapter.connect();

// Get list of Goat devices
const devices = await adapter.getGoatDevices();
console.log(devices);
// [
//   { 
//     id: 'device-id',
//     name: 'Goat Lawnmower',
//     class: '2px96q',
//     battery: null,
//     isCharging: null,
//     position: null,
//     state: null
//   }
// ]

// Create a Goat instance to control a device
const goat = await adapter.createGoatInstance(devices[0].id);

// Initialize and connect
await goat.init();
await goat.connect();

// Get current status
console.log(goat.getPosition());    // { x, y, a }
console.log(goat.getBattery());     // 85 (percentage)
console.log(goat.getChargeState()); // { isCharging: 0, mode: 'slot' }
console.log(goat.getMowInfo());     // { state: 'mow', type: 'spotArea', ... }
console.log(goat.getMowState());    // 'mow'

// Listen for state changes
goat.on('battery', (battery) => {
  console.log(`Battery: ${battery}%`);
});

goat.on('position', (pos) => {
  console.log(`Position: x=${pos.x}, y=${pos.y}, a=${pos.a}`);
});

goat.on('mowState', (state) => {
  console.log(`Mow state: ${state}`);
});

// Control the device
await goat.mowArea([1, 2, 3]);      // Mow specific areas
await goat.mowBorder('aid:1;aid:2'); // Mow borders
await goat.pause();                 // Pause mowing
await goat.resume();                // Resume mowing
await goat.stop();                  // Stop mowing (halt in place)

// Disconnect
await goat.disconnect();
await adapter.disconnect();
```

## API Reference

### EcovacsGoatAdapter

Main adapter class for managing connections and devices.

#### Constructor

```javascript
const adapter = new EcovacsGoatAdapter(credentials);
```

**Options:**
- `email` or `accountId`: Ecovacs account email
- `password`: Ecovacs account password
- `passwordHash`: Alternative to password (MD5 hash)
- `country`: Country code (default: 'DE')
- `continent`: Continent code (optional)
- `deviceId`: Optional client/app identifier used for cloud auth (NOT the Goat device `did`)
- `overrideMqttUrl`: MQTT broker URL override (optional)

#### Methods

##### `setCredentials(email, password, options)`

Set or update credentials.

```javascript
adapter.setCredentials('user@example.com', 'password', {
  country: 'DE'
});
```

##### `setPasswordHash(email, passwordHash, options)`

Set credentials using password hash instead of plaintext password.

```javascript
adapter.setPasswordHash('user@example.com', 'md5-hash-of-password', {
  country: 'DE'
});
```

##### `async connect()`

Connect to Ecovacs cloud API.

```javascript
await adapter.connect();
```

If no `deviceId` is provided, the adapter generates a random client `deviceId` automatically.

**Throws:** Error if credentials are missing.

##### `async getDevices()`

Get all devices (not just Goat devices).

```javascript
const allDevices = await adapter.getDevices();
```

Returns array of all device objects from cloud.

##### `async getGoatDevices()`

Get only Goat/lawnmower devices.

```javascript
const goatDevices = await adapter.getGoatDevices();
```

Returns array of:
```javascript
{
  id: string,           // Device ID
  name: string,         // Device name or nick
  class: string,        // Device class (e.g., '2px96q')
  resource: string,     // Device resource ID
  company: string,      // Company name
  battery: null|number, // Battery percentage (null initially)
  isCharging: null|bool,// Charging status (null initially)
  position: null|obj,   // Position { x, y, a } (null initially)
  state: null|string    // Mowing state (null initially)
}
```

##### `async createGoatInstance(deviceId)`

Create a Goat control instance for a specific device.

```javascript
const goat = await adapter.createGoatInstance(devices[0].id);
```

Returns initialized `Goat` object (not yet connected to MQTT).

##### `async disconnect()`

Disconnect from Ecovacs cloud.

```javascript
await adapter.disconnect();
```

##### Debug Toggle Methods

All methods are chainable and affect newly created Goat instances:

```javascript
adapter
  .setEnableLogging(true)
  .setLogConnection(true)
  .setLogRawMqtt(true)
  .setLogDiscovery(true)
  .setLogBinaryTopics(true)
  .setLogMqttTrafficToFile(true)
  .setMqttTrafficLogFile('mqtt_traffic.log');
```

Available methods:
- `setEnableLogging(enabled)`
- `setLogConnection(enabled)`
- `setLogRawMqtt(enabled)`
- `setLogDiscovery(enabled)`
- `setLogBinaryTopics(enabled)`
- `setLogMqttTrafficToFile(enabled)`
- `setMqttTrafficLogFile(filePath)`

---

### Goat

Device control class for a single Goat lawnmower.

#### Methods

##### `async init()`

Initialize Goat configuration and logger.

```javascript
await goat.init();
```

##### `async connect()`

Connect to MQTT broker and subscribe to device topics.

```javascript
await goat.connect();
```

##### Getters

Get current device state:

```javascript
goat.getPosition()      // { x: number, y: number, a: number }
goat.getBattery()       // number (percentage 0-100)
goat.getSleep()         // boolean
goat.getVolume()        // { volume, fallVolume, searchVolume }
goat.getLifeSpan()      // { blade: { left, total }, lensBrush: { left, total } }
goat.getTotalStats()    // { area, time, count }
goat.getStats()         // getStats/onStats payload
goat.getLastTimeStats() // getLastTimeStats/onLastTimeStats payload
goat.getNetInfo()       // { ip, ssid, rssi, wkVer, mac }
goat.getMapState()      // { state, expandState }
goat.getChargeState()   // { isCharging, mode }
goat.getChargeInfo()    // getChargeInfo/onChargeInfo payload
goat.getError()         // [error codes] or null
goat.getProtectState()  // getProtectState/onProtectState payload
goat.getAreaSet()       // getAreaSet/onAreaSet payload
goat.getAreaParameter() // getAreaParameter/onAreaParameter payload
goat.getGeolocation()   // { enable, geoLocation: { longitude, latitude } }
goat.getFwBuryPoints()  // { [substate]: data, ... } object with all last FwBuryPoint messages
goat.getFwBuryPoint('bd_basicinfo') // Get specific substate data or null

// Info fields (lazy-loaded via getInfo, automatically requested on first access if null)
goat.getCutEfficiency()     // { level }
goat.getObstacleHeight()    // { level }
goat.getCutHeight()         // { level }
goat.getCutDirection()      // { angle, set }
goat.getAutoCutDirection()  // { enable }
goat.getRainDelay()         // { enable, delay }
goat.getAnimProtect()       // { ... }
goat.getTimeZone()          // { ... }
goat.getCustomCutMode()     // { ... }
goat.getBorderSwitch()      // { ... }

goat.getMowInfo()       // { state, type, trigger, cleanState }
goat.getMowState()      // 'mow' | 'dock' | ... | null
goat.getMowCommand()    // { act, type, value, parsed, ts } or null
```

##### Control Methods

```javascript
// Mow specific areas
await goat.mowArea([1, 2, 3]);
await goat.mowArea('1,2,3');  // Can also pass comma-separated string

// Mow borders (areas or virtual borders)
await goat.mowBorder('aid:1;aid:2');  // Area borders
await goat.mowBorder('vid:1');        // Virtual border
await goat.mowBorder([1, 2]);         // Shorthand (interpreted as aid:1;aid:2)
await goat.mowBorder({ aid: [1, 2], vid: [3] });  // Mixed

// Mow control
await goat.pause();      // Pause mowing
await goat.resume();     // Resume mowing
await goat.stop();       // Stop mowing (halt)
```

##### Event Listeners

```javascript
// Register callbacks for state changes (only called when value changes)
goat.on('connected', () => {
  console.log('Device connected');
});

goat.on('position', (pos) => {
  console.log(`Position: ${pos.x}, ${pos.y}, angle: ${pos.a}`);
});

goat.on('battery', (percentage) => {
  console.log(`Battery: ${percentage}%`);
});

goat.on('mowState', (state) => {
  console.log(`Mow state: ${state}`);
});

goat.on('mowInfo', (info) => {
  console.log(`Mowing: ${info.state}, type: ${info.type}`);
});

goat.on('mowCommand', (cmd) => {
  console.log(`Command received: ${cmd.act}, areas: ${cmd.parsed.spotAreaIds}`);
});

goat.on('chargeState', (state) => {
  console.log(`Charging: ${state.isCharging}, mode: ${state.mode}`);
});

goat.on('chargeInfo', (info) => {
  console.log('Charge info update', info);
});

goat.on('error', (codes) => {
  console.log('Device error', codes);
});

goat.on('stats', (stats) => {
  console.log('Stats update', stats);
});

goat.on('lastTimeStats', (stats) => {
  console.log('Last-time stats update', stats);
});

goat.on('protectState', (state) => {
  console.log('Protect state update', state);
});

goat.on('areaSet', (areaSet) => {
  console.log('Area set update', areaSet);
});

goat.on('areaParameter', (params) => {
  console.log('Area parameter update', params);
});

goat.on('customCutMode', (data) => {
  console.log('Custom cut mode update', data);
});

goat.on('borderSwitch', (data) => {
  console.log('Border switch update', data);
});

goat.on('fwBuryPoint', (msg) => {
  console.log(`Firmware message [${msg.substate}]`, msg.data);
});

goat.on('rawMessage', (msg) => {
  console.log('Raw MQTT message', msg.topicName, msg.payloadRaw);
});

goat.on('disconnected', () => {
  console.log('Device disconnected');
});

// Unregister callback
goat.off('battery', callbackFunction);
```

Available callback events:
- `connected`
- `disconnected`
- `position`
- `battery`
- `sleep`
- `volume`
- `lifeSpan`
- `totalStats`
- `stats`
- `lastTimeStats`
- `netInfo`
- `mapState`
- `mowInfo`
- `mowState`
- `mowCommand`
- `chargeState`
- `chargeInfo`
- `error`
- `protectState`
- `areaSet`
- `areaParameter`
- `fwBuryPoint`
- `cutEfficiency`
- `obstacleHeight`
- `cutHeight`
- `cutDirection`
- `autoCutDirection`
- `rainDelay`
- `animProtect`
- `timeZone`
- `customCutMode`
- `borderSwitch`
- `geolocation`
- `rawMessage`

`fwBuryPoint` payload shape:

```javascript
{
  substate: string,  // e.g. 'bd_basicinfo', 'bd_reedvoltage', 'bd_machine'
  data: object       // Body content from onFwBuryPoint-[substate] message
}
```

All `onFwBuryPoint-*` messages are aggregated into the `fwBuryPoint` callback by their substate.
When using whitelist/blacklist filters, you can treat all `onFwBuryPoint-*` topics as a single `onFwBuryPoint` entry.

`rawMessage` payload shape:

```javascript
{
  topic: string,        // Full MQTT topic
  topicName: string,    // Short command name (e.g. onStats)
  payloadRaw: string,   // Original MQTT payload string
  payload: object|null, // Parsed JSON payload if available
  parseError: string|null,
  ts: number            // Unix ms timestamp
}
```

By default, `rawMessage` is emitted only for topics without dedicated Goat state callbacks.
Set `unhandledOnly: false` if you want to receive all MQTT messages.

Topic filter methods:

```javascript
// Generic filter method
goat.setRawCallbackFilter({
  whitelist: ['onFwBuryPoint-bd_setting', 'iot/atr/onMapTrace/...'],
  blacklist: ['onMapTrace'],
  unhandledOnly: true
});

// Filter all FwBuryPoint messages together
goat.setRawCallbackFilter({
  whitelist: ['onFwBuryPoint'],  // Include all onFwBuryPoint-* messages
  unhandledOnly: false           // Include despite having dedicated callback
});

// Or use the convenience method:
goat.setRawCallbackWhitelist(['onFwBuryPoint']);

// Convenience methods
goat.setRawCallbackWhitelist(['onFwBuryPoint-bd_basicinfo']);
goat.setRawCallbackBlacklist(['onMapTrace']);
goat.setRawCallbackUnhandledOnly(false); // forward all MQTT messages
```

Whitelist/blacklist entries can be either short topic names (`onStats`) or full MQTT topic strings.

##### Topic to State/Callback Mapping

| Topic(s) | Stored State | Callback | Getter | Initial Poll |
|---|---|---|---|---|
| `getPos`, `onPos` | `state.position` | `position` | `getPosition()` | yes (`getPos`) |
| `getBattery`, `onBattery` | `state.battery` | `battery` | `getBattery()` | yes (`getBattery`) |
| `getSleep`, `onSleep` | `state.sleep` | `sleep` | `getSleep()` | yes (`getSleep`) |
| `getVolume`, `onVolume` | `state.volume` | `volume` | `getVolume()` | yes (`getVolume`) |
| `getLifeSpan` | `state.lifeSpan` | `lifeSpan` | `getLifeSpan()` | yes (`getLifeSpan`) |
| `getTotalStats` | `state.totalStats` | `totalStats` | `getTotalStats()` | no |
| `getStats`, `onStats` | `state.stats` | `stats` | `getStats()` | yes (`getStats`) |
| `getLastTimeStats`, `onLastTimeStats` | `state.lastTimeStats` | `lastTimeStats` | `getLastTimeStats()` | yes (`getLastTimeStats`) |
| `getNetInfo` | `state.netInfo` | `netInfo` | `getNetInfo()` | yes (`getNetInfo`) |
| `getMapState` | `state.mapState` | `mapState` | `getMapState()` | no |
| `getCleanInfo`, `onCleanInfo` | `state.mowInfo` | `mowInfo`, `mowState` | `getMowInfo()`, `getMowState()` | yes (`getCleanInfo`) |
| `clean` | `state.mowCommand` | `mowCommand` | `getMowCommand()` | no |
| `getChargeState`, `onChargeState` | `state.chargeState` | `chargeState` | `getChargeState()` | yes (`getChargeState`) |
| `getChargeInfo`, `onChargeInfo` | `state.chargeInfo` | `chargeInfo` | `getChargeInfo()` | yes (`getChargeInfo`) |
| `getError`, `onError` | `state.error` | `error` | `getError()` | yes (`getError`) |
| `getProtectState`, `onProtectState` | `state.protectState` | `protectState` | `getProtectState()` | yes (`getProtectState`) |
| `getAreaSet`, `onAreaSet` | `state.areaSet` | `areaSet` | `getAreaSet()` | yes (`getAreaSet`) |
| `getAreaParameter`, `onAreaParameter` | `state.areaParameter` | `areaParameter` | `getAreaParameter()` | yes (`getAreaParameter`) |
| `getGeolocation` | `state.geolocation` | `geolocation` | `getGeolocation()` | no |
| `getInfo` (lazy) | `state.cutEfficiency`, `cutObstacleHeight`, `cutHeight`, `cutDirection`, `autoCutDirection`, `rainDelay`, `animProtect`, `timeZone`, `customCutMode`, `borderSwitch` | `cutEfficiency`, `obstacleHeight`, `cutHeight`, `cutDirection`, `autoCutDirection`, `rainDelay`, `animProtect`, `timeZone`, `customCutMode`, `borderSwitch` | `getCutEfficiency()`, `getObstacleHeight()`, etc. | no (triggered by getter if null) |

##### Info Fields (Lazy-Loaded)

The device provides additional device-specific info that is not automatically pushed via MQTT, but can be queried via `getInfo` API.
When you access any info field getter, if the value is `null`, the getter automatically triggers a `getInfo` request.
The getInfo response contains all 10 info fields, which arrive moments later and trigger their respective callbacks when updated.

Supported info fields:
- `cutEfficiency` - { level }
- `obstacleHeight` - { level }
- `cutHeight` - { level }
- `cutDirection` - { angle, set }
- `autoCutDirection` - { enable }
- `rainDelay` - { enable, delay }
- `animProtect` - { ... }
- `timeZone` - { ... }
- `customCutMode` - { ... }
- `borderSwitch` - { ... }

```javascript
// On first access, lazy-loads via getInfo if value is null
const direction = goat.getCutDirection();  // null, but getInfo request sent

// Listen for the response
goat.on('cutDirection', (data) => {
  console.log('Cut direction updated:', data);
});

// Or manually request info fields
await goat.requestInfoFields(['cutDirection', 'cutHeight']);

// Request all info fields
await goat.requestInfoFields();
```

##### Disconnect

```javascript
await goat.disconnect();
```

Closes MQTT connection and triggers `disconnected` event.

On connect, the device now polls initial battery, position, clean state, charge state, charge info, error, stats, last-time stats, protect state, area set, area parameter, net info, sleep, volume, and lifespan immediately so the first callbacks can fire with a real baseline instead of waiting for the next spontaneous MQTT update.

##### Runtime Debug Toggle Methods

These methods apply immediately, even while connected:

```javascript
goat
  .setEnableLogging(true)
  .setLogConnection(true)
  .setLogRawMqtt(true)
  .setLogDiscovery(true)
  .setLogBinaryTopics(true)
  .setLogMqttTrafficToFile(true)
  .setMqttTrafficLogFile('mqtt_traffic.log');
```

Available methods:
- `setEnableLogging(enabled)`
- `setLogConnection(enabled)`
- `setLogRawMqtt(enabled)`
- `setLogDiscovery(enabled)`
- `setLogBinaryTopics(enabled)`
- `setLogMqttTrafficToFile(enabled)`
- `setMqttTrafficLogFile(filePath)`
- `setRawCallbackFilter({ whitelist, blacklist, unhandledOnly })`
- `setRawCallbackWhitelist(topics)`
- `setRawCallbackBlacklist(topics)`
- `setRawCallbackUnhandledOnly(enabled)`

---

## Configuration Files

The library can run fully without `settings.json`.

Supported files:

1. **credentials.json** - Ecovacs account credentials (recommended over passing in code)
   ```json
   {
     "email": "user@example.com",
     "password": "password",
     "accountId": "user@example.com",
    "country": "DE"
   }
   ```

  2. **settings.json** - Optional runtime overrides (all debug flags default to `true`)
   ```json
   {
     "enableLogging": true,
     "logConnection": true,
     "logRawMqtt": true,
     "logMqttTrafficToFile": true,
     "mqttTrafficLogFile": "mqtt_traffic.log",
     "runtimeSeconds": 0,
     "logDiscovery": true,
     "logBinaryTopics": true,
    "deviceClasses": ["2px96q"]
   }
   ```

  `deviceClasses` is an exact class allowlist. For the Goat device in this project, use `"2px96q"`.

3. **topics.json** - MQTT topic configuration (auto-generated)

## Advanced: Full Traffic Logging

For debugging, full MQTT traffic logging is enabled by default.

To override at runtime:

```javascript
adapter
  .setLogMqttTrafficToFile(true)
  .setMqttTrafficLogFile('mqtt_traffic.log');
```

This logs all incoming MQTT messages as JSONL:
```json
{"ts":"2026-06-18T16:12:34.123Z","topic":"iot/p2p/...","payload":"{...}"}
```

## Example: ioBroker Adapter Usage

```javascript
import { EcovacsGoatAdapter } from 'node-ecovacs-js';

class GoatAdapter {
  constructor(options) {
    this.adapter = new EcovacsGoatAdapter();
    this.devices = [];
  }

  async init(email, password) {
    this.adapter.setCredentials(email, password, {
      country: 'DE'
    });
    await this.adapter.connect();

    const devices = await this.adapter.getGoatDevices();
    for (const device of devices) {
      const goat = await this.adapter.createGoatInstance(device.id);
      await goat.init();
      await goat.connect();

      this.devices.push({
        id: device.id,
        name: device.name,
        goat
      });

      // Listen for updates
      goat.on('battery', (battery) => {
        this.onBatteryChange(device.id, battery);
      });

      goat.on('position', (pos) => {
        this.onPositionChange(device.id, pos);
      });
    }
  }

  async mowArea(deviceId, areaIds) {
    const device = this.devices.find(d => d.id === deviceId);
    if (device) {
      await device.goat.mowArea(areaIds);
    }
  }
}
```

### ioBroker Raw Callback Profiles

#### Profile 1: Only Unhandled Topics (default)

Use this profile to receive only MQTT messages that currently do not have a dedicated Goat state callback.

```javascript
// Optional: explicit default setup
goat.setRawCallbackUnhandledOnly(true);
goat.setRawCallbackWhitelist([]);
goat.setRawCallbackBlacklist([]);

goat.on('rawMessage', (msg) => {
  // msg.topicName can be null for malformed topics
  const topic = msg.topicName || msg.topic;
  this.log.debug(`[RAW/UNHANDLED] ${topic}: ${msg.payloadRaw}`);
});
```

#### Profile 2: Full Raw Stream With Whitelist

Use this profile when you want all raw traffic, but constrained to selected topic names.

```javascript
// Receive all topics first
goat.setRawCallbackUnhandledOnly(false);

// Then constrain to selected topics
goat.setRawCallbackWhitelist([
  'onMapTrace',
  'onFwBuryPoint-bd_basicinfo',
  'onFwBuryPoint-bd_setting'
]);

// Optional: exclude noisy topics even if whitelisted later by full topic string
goat.setRawCallbackBlacklist([
  'onBattery'
]);

goat.on('rawMessage', (msg) => {
  // Parsed payload is in msg.payload (if JSON parse was successful)
  this.log.info(`[RAW/FILTERED] ${msg.topicName}`, msg.payload);
});
```

#### Notes

- Whitelist and blacklist entries can be short names like onStats or full MQTT topic strings.
- If whitelist is non-empty, only whitelist matches are forwarded.
- Blacklist is always applied after whitelist.
- For adapter-level discovery of new topics, Profile 1 is typically the safest default.

## License

MIT

## Support

For issues, questions, or contributions, please open an issue on GitHub.
