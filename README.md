# node-ecovacs.js

Ecovacs Node.js library for the ecovacs cloud subsystem.

Communication based on https://github.com/DeebotUniverse/client.py.git

No external Ecovacs login library is used. Authentication and API workflow are implemented directly in this project, following the reference structure from `client.py`.

## Development Start

This repository now contains a runnable Node.js scaffold for the planned flow.

### Quick Start

1. Install dependencies:

```bash
npm install
```

2. Create your local credentials file:

```bash
copy credentials.example.json credentials.json
```

3. Adjust the values in `credentials.json` and `topics.json`.
  `settings.json` is optional and only needed if you want to override defaults.

Credentials format:

```json
{
  "accountId": "your-account@example.com",
  "password": "your-password",
  "country": "DE",
  "continent": "eu",
  "deviceId": "node-ecovacs-local-dev",
  "overrideRestUrl": null,
  "overrideMqttUrl": null
}
```

4. Run:

```bash
npm start
```

## Runtime Flow

[1] Runtime flags have built-in defaults (all debug flags enabled). `settings.json` is optional for overrides:
- `enableLogging` — master switch for all logs
- `logConnection` — only logs related to connection setup (cloud + MQTT)
- `runtimeSeconds` (0 = forever, >0 = runtime in seconds)
- `logRawMqtt` — log every raw MQTT frame before filtering
- `logMqttTrafficToFile` — write each MQTT message as JSONL
- `mqttTrafficLogFile` — target file for JSONL traffic logs
- `logDiscovery` — log auto-discovered topics
- `logBinaryTopics` — emit chunk progress and LZMA decode diagnostics for binary blob topics
- `deviceClasses` — exact class allowlist used to select MQTT devices (for this Goat, usually `2px96q`)

Example:

```json
{
  "enableLogging": true,
  "logConnection": true,
  "runtimeSeconds": 0,
  "logRawMqtt": true,
  "logMqttTrafficToFile": true,
  "mqttTrafficLogFile": "mqtt_traffic.log",
  "logDiscovery": true,
  "logBinaryTopics": true,
  "deviceClasses": ["2px96q"]
}
```

`deviceClasses` uses the exact `class` field from the device list response. Devices whose class is not listed are skipped with a log line showing what was filtered out.

[2] Connect to Ecovacs cloud using `credentials.json`:
- login API call
- global auth code call
- `loginByItToken` call

[3] Get all devices:
- `GetDeviceList`
- `GetGlobalDeviceList`
- merge by `did`

[4] Connect to GOAT devices via MQTT
- default broker: `mq[-continent].ecouser.net:443`

[5] Gather information from ATR and P2P response topics

[6] Collect short topic names (for example `getPos`) in `topics.json` with output flags:
- `consoleOut`
- `consolePayload`
- `consoleParsed`

## Implemented Structure

```
src/
  index.js                     # Runtime orchestration
  config.js                    # JSON config loading
  logger.js                    # Timestamped logger
  services/
    ecovacsCloudClient.js      # Direct auth + REST API (client.py workflow)
    goatMqttClient.js          # MQTT config, topic subscription, wildcard dispatch
    topicCollector.js          # ATR/P2P topic discovery and configured output
    deviceCommander.js         # Send commands via iot/devmanager.do to trigger ATR responses
```

## Notes

- `credentials.json` is intentionally gitignored.
- The implementation follows the workflow and server conventions from the Python client reference.
