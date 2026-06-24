# node-ecovacs.js — API 2.0

> **Branch:** `feature/api-2.0-base`  
> API 2.0 is a clean-room redesign of the library. It lives under `src/api2/` and is independent of the original `src/lib.js` / `src/goat.js` stack.

---

## Konzept

| Aspect | Beschreibung |
|---|---|
| **Factory** | `Api2Factory` — Authentifizierung, Geräteliste, MQTT-Verbindung pro Device |
| **Device** | `Api2Device extends EventEmitter` — Zustandsspeicher, Getter, Events |
| **Lazy-Load** | Erstes `device.on('stats', …)` oder `device.getStats()` sendet automatisch den passenden Geräte-Command |
| **Change-Detection** | Events feuern nur bei tatsächlich geändertem Wert (deep-equal via JSON.stringify) |
| **Dedup** | Mehrfache Getter-Aufrufe oder Subscriptions senden den Command nur einmal (Set-basiertes Tracking) |

---

## Installation

```js
import { Api2Factory } from './src/api2/index.js';
// oder nach npm-Paketinstallation:
import { Api2Factory } from 'node-ecovacs-js/src/api2/index.js';
```

---

## Quick Start

```js
import { Api2Factory } from './src/api2/index.js';

const factory = new Api2Factory({
  user: 'user@example.com',
  password: 'geheim',
  country: 'DE'
});

await factory.connect();

// Alle Geräte
const allDevices = await factory.getDevices();

// Nur GOATBOT-Geräte (product_category === 'GOATBOT')
const goatDevices = await factory.getGoatDevices();

for (const device of goatDevices) {
  console.log(device.id, device.name, device.isConnected);

  // MQTT verbinden und Events verdrahten
  await factory.connectDevice(device);

  // Event-Subscription — triggert automatisch Lazy-Load-Request
  device.on('stats', (data) => console.log('stats:', data));
  device.on('lastTimeStats', (data) => console.log('lastTimeStats:', data));
  device.on('totalStats', (data) => console.log('totalStats:', data));
}

// Aufräumen
await factory.disconnect();
```

---

## Api2Factory

### Konstruktor

```js
new Api2Factory({
  user: string,           // E-Mail-Adresse des Ecovacs-Accounts
  password: string,       // Passwort (alternativ: passwordHash)
  passwordHash: string,   // MD5-Hash des Passworts
  country: string,        // ISO-2-Ländercode, default 'DE'
  continent: string,      // Optional: 'eu', 'na', 'as', 'ww'
  deviceId: string,       // Optional: eigene Client-ID (wird sonst generiert)
  overrideMqttUrl: string,// Optional: alternativer MQTT-Endpoint
  enableLogging: boolean, // Default true
  debugFlags: {
    connection: boolean,  // Default true
    auth: boolean,        // Default false
    devices: boolean      // Default false
  }
})
```

### Methoden

| Methode | Beschreibung |
|---|---|
| `setCredentials(user, password, options?)` | Credentials setzen (chainable) |
| `setPasswordHash(user, hash, options?)` | Credentials via MD5-Hash setzen (chainable) |
| `setEnableLogging(bool)` | Logging ein-/ausschalten (chainable) |
| `setDebugFlag(name, value)` | Debug-Flag zur Laufzeit umschalten (chainable) |
| `getDebugFlag(name)` | Aktuellen Wert eines Debug-Flags lesen |
| `getDebugFlags()` | Alle Debug-Flags als Objekt |
| `connect()` | Authentifizierung gegen Ecovacs Cloud |
| `getDevices()` | Alle Geräte des Accounts als `Api2Device[]` |
| `getGoatDevices()` | Nur GOATBOT-Geräte (`product_category === 'GOATBOT'`) |
| `connectDevice(device)` | MQTT-Verbindung für ein Device herstellen, Events verdrahten |
| `disconnect()` | MQTT trennen, Verbindung zurücksetzen |

### Debug-Flags

Flags können im Konstruktor **und** zur Laufzeit via `setDebugFlag()` gesetzt werden.  
Erlaubte Werte: `true / false / 'on' / 'off' / '1' / '0' / 'yes' / 'no'`.

| Flag | Default | Loggt |
|---|---|---|
| `connection` | `true` | Cloud-Verbindungsaufbau, MQTT-Connect; aktiviert gleichzeitig Raw-Auth-Responses |
| `auth` | `false` | Einzelne Auth-Phasen (Login → AuthCode → Token) |
| `devices` | `false` | Geräteliste, MQTT-Wiring; aktiviert gleichzeitig vollständigen Raw-getDevices()-Payload |

```js
factory.setDebugFlag('auth', 'on');     // einschalten
factory.setDebugFlag('connection', false); // ausschalten
```

---

## Api2Device

`Api2Device` erweitert Node.js `EventEmitter`.

### Identity-Properties (synchron, immer verfügbar)

| Property | Typ | Beschreibung |
|---|---|---|
| `device.id` | `string \| null` | Geräte-DID |
| `device.name` | `string` | `deviceName`, ggf. mit Nickname in Klammern: `GOAT O800 RTK (Goat)` |
| `device.nickName` | `string \| null` | Benutzer-vergebener Name, `null` wenn nicht gesetzt |
| `device.className` | `string \| null` | Geräteklasse, z. B. `2px96q` |
| `device.productCategory` | `string \| null` | z. B. `GOATBOT`, `DEEBOT` |
| `device.isConnected` | `boolean` | `true` wenn `status === 1` in den Cloud-Daten |

### Event-Pattern

```js
// Subscription + automatischer Lazy-Load (bevorzugte Nutzung)
device.on('stats', (data) => { /* data = { area, time, mowedArea } */ });

// Einmaliger Listener
device.once('totalStats', (data) => { /* ... */ });

// Listener entfernen
device.off('stats', myHandler);
```

**Verhalten beim ersten `on()`-Aufruf für einen noch unbekannten State:**
1. EventEmitter-Listener wird registriert
2. Automatisch `_requestData(commandName)` gefeuert (dedupliziert)
3. Kurz danach sendet der Connection-Layer den echten Device-Command
4. Antwort landet in `_ingestTopicData()` → `_updateState()` → Event feuert

### Getter

Getter sind **synchron** und geben den aktuellen gecachten Wert zurück.  
Ist noch kein Wert vorhanden (`null`), wird **nebenbei** ein Lazy-Load-Request ausgelöst.

```js
const s = device.getStats();       // null oder { area, time, mowedArea }
const l = device.getLastTimeStats(); // null oder { cid, start, type, stop, area, time }
const t = device.getTotalStats();  // null oder { area, time, count }
```

### `unknownTopic`-Event

Kommt eine MQTT-Nachricht für ein noch nicht implementiertes Topic an,
feuert das Device ein generisches Event:

```js
device.on('unknownTopic', ({ topicName, data }) => {
  console.log('unbekanntes Topic:', topicName, data);
});
```

---

## Unterstützte States & Commands

Legende:
- **Getter** — `getXxx()` vorhanden, Lazy-Load bei erstem Zugriff
- **Event `on()`** — via EventEmitter subscribbar, Lazy-Load bei erstem `on()`
- **ATR Push** — Gerät sendet spontan (`onXxx`), kein expliziter Aufruf nötig
- **Setter** — `setXxx()` / Write-Command vorhanden
- ✅ implementiert · ⬜ geplant · — nicht zutreffend

| State-Key | Event | Getter | ATR Push (`onXxx`) | Poll-Command | Setter |
|---|---|---|---|---|---|
| `stats` | ✅ `stats` | ✅ `getStats()` | ✅ `onStats` | `getStats` | — |
| `lastTimeStats` | ✅ `lastTimeStats` | ✅ `getLastTimeStats()` | ✅ `onLastTimeStats` | `getLastTimeStats` | — |
| `totalStats` | ✅ `totalStats` | ✅ `getTotalStats()` | — | `getTotalStats` | — |
| `battery` | ✅ `battery` | ✅ `getBattery()` | ✅ `onBattery` | `getBattery` | — |
| `position` | ✅ `position` | ✅ `getPosition()` | ✅ `onPos` | `getPos` | — |
| `chargeState` | ✅ `chargeState` | ✅ `getChargeState()` | ✅ `onChargeState` | `getChargeState` | — |
| `chargeInfo` | ✅ `chargeInfo` | ✅ `getChargeInfo()` | ✅ `onChargeInfo` | `getChargeInfo` | — |
| `mowInfo` | ✅ `mowInfo` | ✅ `getMowInfo()` / `getMowState()` | ✅ `onCleanInfo` | `getCleanInfo` | — |
| `mowCommand` | ⬜ | ⬜ | ⬜ `clean` (p2p/q) | — | ⬜ `mowArea` / `mowBorder` / `pause` / `resume` / `stop` |
| `error` | ✅ `error` | ✅ `getError()` | ✅ `onError` | `getError` | — |
| `sleep` | ✅ `sleep` | ✅ `getSleep()` | — | `getSleep` | — |
| `volume` | ⬜ | ⬜ | ⬜ `onVolume` | `getVolume` | ⬜ `setVolume` |
| `lifeSpan` | ✅ `lifeSpan` | ✅ `getLifeSpan()` | — | `getLifeSpan` ¹ | — |
| `netInfo` | ✅ `netInfo` | ✅ `getNetInfo()` | — | `getNetInfo` | — |
| `protectState` | ✅ `protectState` | ✅ `getProtectState()` | ✅ `onProtectState` | `getProtectState` | — |
| `areaSet` | ⬜ | ⬜ | ⬜ `onAreaSet` | `getAreaSet` | — |
| `areaParameter` | ⬜ | ⬜ | ⬜ `onAreaParameter` | `getAreaParameter` | — |
| `geolocation` | ✅ `geolocation` | ✅ `getGeolocation()` | — | `getGeolocation` | — |
| `cutEfficiency` | ✅ `cutEfficiency` | ✅ `getCutEfficiency()` | — | `getCutEfficiency` ² | ⬜ |
| `obstacleHeight` | ✅ `obstacleHeight` | ✅ `getObstacleHeight()` | — | `getObstacleHeight` ² | ✅ `setObstacleHeight` |
| `cutHeight` | ✅ `cutHeight` | ✅ `getCutHeight()` | — | `getCutHeight` ² | ✅ `setCutHeight` |
| `cutDirection` | ✅ `cutDirection` | ✅ `getCutDirection()` | — | `getCutDirection` ² | ✅ `setCutDirection` |
| `autoCutDirection` | ✅ `autoCutDirection` | ✅ `getAutoCutDirection()` | — | `getAutoCutDirection` ² | ⬜ |
| `rainDelay` | ✅ `rainDelay` | ✅ `getRainDelay()` | — | `getRainDelay` ² | ✅ `setRainDelay` |
| `animProtect` | ✅ `animProtect` | ✅ `getAnimProtect()` | — | `getAnimProtect` ² | ⬜ |
| `timeZone` | ✅ `timeZone` | ✅ `getTimeZone()` | — | `getTimeZone` ² | ⬜ |
| `customCutMode` | ✅ `customCutMode` | ✅ `getCustomCutMode()` | — | `getCustomCutMode` ² | ⬜ |
| `borderSwitch` | ✅ `borderSwitch` | ✅ `getBorderSwitch()` | — | `getBorderSwitch` ² | ✅ `setBorderSwitch` |
| `fwBuryPoint-*` | ⬜ | — | ⬜ `onFwBuryPoint-*` | — | — |

> **Hinweis `getInfo`-Fallback:** Die Info-Felder werden primär über direkte Commands (`getCutDirection`, `getCutHeight`, …) geladen. Zusätzlich werden verschachtelte `getInfo`-Replies auf dieselben direkten Routen gemappt.

> ¹ `getLifeSpan` benötigt einen Body-Parameter `{ type: ["blade", "lensBrush"] }`. Dieser wird intern automatisch mitgesendet.

> ² Direkter Command + `getInfo`-Fallback-Mapping.

> ³ `position` normalisiert mehrere mögliche Payload-Felder (z. B. `deebotPos`, `pos`, `position`, `rtkPos`) auf `{ x, y, a }`.

---

## Vollständiges Beispiel (ioBroker-Adapter-Stil)

```js
import { Api2Factory } from 'node-ecovacs-js/src/api2/index.js';

const factory = new Api2Factory({ user, password, country: 'DE' });
factory.setDebugFlag('connection', false); // kein Connection-Log in Produktion

await factory.connect();
const [goat] = await factory.getGoatDevices();
if (!goat) throw new Error('Kein GOATBOT gefunden');

await factory.connectDevice(goat);

// States in ioBroker schreiben, wenn Events eintreffen
goat.on('stats', ({ area, time, mowedArea }) => {
  adapter.setState('goat.stats.area', area, true);
  adapter.setState('goat.stats.time', time, true);
  adapter.setState('goat.stats.mowedArea', mowedArea, true);
});

goat.on('totalStats', ({ area, time, count }) => {
  adapter.setState('goat.totalStats.area', area, true);
  adapter.setState('goat.totalStats.time', time, true);
  adapter.setState('goat.totalStats.count', count, true);
});

goat.on('lastTimeStats', ({ area, time, type }) => {
  adapter.setState('goat.lastTimeStats.area', area, true);
  adapter.setState('goat.lastTimeStats.time', time, true);
  adapter.setState('goat.lastTimeStats.type', type, true);
});

goat.on('unknownTopic', ({ topicName, data }) => {
  adapter.log.debug(`Unbekanntes Topic: ${topicName}`);
});

// Unbekanntes Topic: adapter on unload
adapter.on('unload', async () => {
  await factory.disconnect();
});
```
