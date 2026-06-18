// Sends commands to devices via the Ecovacs REST API (iot/devmanager.do).
// The device responds via ATR MQTT topic.
// Command structure follows client.py command.py _execute_api_request pattern.

const PATH_API_IOT_DEVMANAGER = "iot/devmanager.do";

// Known poll commands (JSON data type) that request current state.
// The device replies with an ATR MQTT message for each.
// Each entry can be a string (command name) or { name, data } for commands requiring body data.
export const POLL_COMMANDS = [
  "getBattery",
  "getCleanInfo",
  "getChargeState",
  "getPos",
  "getNetInfo",
  { name: "getLifeSpan", data: { type: ["blade", "lensbrush"] } }
];

function buildCommandPayload(bodyData = {}) {
  return JSON.stringify({
    header: {
      pri: 1,
      ts: String(Date.now()),
      tzm: 480,
      ver: "0.0.50"
    },
    body: {
      data: bodyData
    }
  });
}

export class DeviceCommander {
  constructor({ cloudClient, logger }) {
    this.cloudClient = cloudClient;
    this.logger = logger;
  }

  async sendCommand(device, commandEntry) {
    const commandName = typeof commandEntry === "string" ? commandEntry : commandEntry.name;
    const commandData = typeof commandEntry === "string" ? {} : (commandEntry.data || {});
    const sessionCredentials = await this.cloudClient.getSessionCredentials();

    // Body structure: cmdName, payload, payloadType, td, toId, toRes, toType
    // Matches client.py command.py _execute_api_request
    const body = {
      cmdName: commandName,
      payload: buildCommandPayload(commandData),
      payloadType: "j",
      td: "q",
      toId: device.did,
      toRes: device.resource,
      toType: device.class
    };

    // Query params are sent separately alongside the body
    const queryParams = {
      mid: device.class,
      did: device.did,
      td: "q",
      u: sessionCredentials.userId,
      cv: "1.67.3",
      t: "a",
      av: "1.3.1"
    };

    this.logger.info("Sending command", {
      device: device.nick || device.name,
      command: commandName,
      ...(Object.keys(commandData).length > 0 ? { data: commandData } : {})
    });

    const response = await this.cloudClient.postAuthenticated(
      PATH_API_IOT_DEVMANAGER,
      body,
      { queryParams }
    );

    if (response.ret !== "ok") {
      this.logger.warn("Command returned non-ok", {
        command: commandName,
        ret: response.ret,
        errno: response.errno,
        error: response.error
      });
    }

    return response;
  }

  async pollDeviceState(device, commands = POLL_COMMANDS) {
    this.logger.info("Polling device state", {
      device: device.nick || device.name,
      commands: commands.length
    });

    for (const command of commands) {
      try {
        await this.sendCommand(device, command);
        // Small gap between commands to avoid flooding
        await new Promise((resolve) => setTimeout(resolve, 200));
      } catch (error) {
        this.logger.warn("Command failed", { command, error: error.message });
      }
    }
  }
}
