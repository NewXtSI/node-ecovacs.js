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

3. Adjust the values in `credentials.json`, `settings.json`, and `topics.json`.

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

[1] Use `settings.json` for global flags:
- `logConnection` — enable/disable connection and MQTT log output
- `runtimeSeconds` (0 = forever, >0 = runtime in seconds)
- `logRawMqtt` — log every raw MQTT frame before filtering
- `deviceClasses` — whitelist of device class IDs to connect to (empty = all)

Example:

```json
{
  "logConnection": true,
  "runtimeSeconds": 0,
  "logRawMqtt": false,
  "deviceClasses": ["2px96q"]
}
```

`deviceClasses` uses the `class` field from the device list response. Devices not in the list are skipped with a log line showing what was filtered out.

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
