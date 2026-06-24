export function createLogger({
  enableLogging = true,
  logConnection = true,
  logAuth = false,
  logConnectionRaw = false,
  logDevices = false,
  logDevicesRaw = false
} = {}) {
  const state = {
    enableLogging: Boolean(enableLogging),
    logConnection: Boolean(logConnection),
    logAuth: Boolean(logAuth),
    logConnectionRaw: Boolean(logConnectionRaw),
    logDevices: Boolean(logDevices),
    logDevicesRaw: Boolean(logDevicesRaw)
  };

  const log = (...args) => {
    if (!state.enableLogging) {
      return;
    }

    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}]`, ...args);
  };

  const logConn = (...args) => {
    if (!state.enableLogging || !state.logConnection) {
      return;
    }

    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}]`, ...args);
  };

  const logConnRaw = (...args) => {
    if (!state.enableLogging || !state.logConnection || !state.logConnectionRaw) {
      return;
    }

    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}]`, ...args);
  };

  const logAuthChannel = (...args) => {
    if (!state.enableLogging || !state.logAuth) {
      return;
    }

    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}]`, ...args);
  };

  const logDevicesChannel = (...args) => {
    if (!state.enableLogging || !state.logDevices) {
      return;
    }

    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}]`, ...args);
  };

  const logDevicesRawChannel = (...args) => {
    if (!state.enableLogging || !state.logDevices || !state.logDevicesRaw) {
      return;
    }

    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}]`, ...args);
  };

  return {
    info: (...args) => log("INFO", ...args),
    warn: (...args) => log("WARN", ...args),
    error: (...args) => log("ERROR", ...args),
    connection: (...args) => logConn("INFO", ...args),
    connectionRaw: (...args) => logConnRaw("RAW", ...args),
    auth: (...args) => logAuthChannel("AUTH", ...args),
    devices: (...args) => logDevicesChannel("DEVICES", ...args),
    devicesRaw: (...args) => logDevicesRawChannel("RAW-DEVICES", ...args),
    setEnableLogging: (enabled) => {
      state.enableLogging = Boolean(enabled);
    },
    setLogConnection: (enabled) => {
      state.logConnection = Boolean(enabled);
    },
    setLogConnectionRaw: (enabled) => {
      state.logConnectionRaw = Boolean(enabled);
    },
    setLogAuth: (enabled) => {
      state.logAuth = Boolean(enabled);
    },
    setLogDevices: (enabled) => {
      state.logDevices = Boolean(enabled);
    },
    setLogDevicesRaw: (enabled) => {
      state.logDevicesRaw = Boolean(enabled);
    },
    setOptions: ({
      enableLogging: nextEnableLogging,
      logConnection: nextLogConnection,
      logAuth: nextLogAuth,
      logConnectionRaw: nextLogConnectionRaw,
      logDevices: nextLogDevices,
      logDevicesRaw: nextLogDevicesRaw
    } = {}) => {
      if (typeof nextEnableLogging !== "undefined") {
        state.enableLogging = Boolean(nextEnableLogging);
      }
      if (typeof nextLogConnection !== "undefined") {
        state.logConnection = Boolean(nextLogConnection);
      }
      if (typeof nextLogAuth !== "undefined") {
        state.logAuth = Boolean(nextLogAuth);
      }
      if (typeof nextLogConnectionRaw !== "undefined") {
        state.logConnectionRaw = Boolean(nextLogConnectionRaw);
      }
      if (typeof nextLogDevices !== "undefined") {
        state.logDevices = Boolean(nextLogDevices);
      }
      if (typeof nextLogDevicesRaw !== "undefined") {
        state.logDevicesRaw = Boolean(nextLogDevicesRaw);
      }
    },
    getOptions: () => ({
      enableLogging: state.enableLogging,
      logConnection: state.logConnection,
      logAuth: state.logAuth,
      logConnectionRaw: state.logConnectionRaw,
      logDevices: state.logDevices,
      logDevicesRaw: state.logDevicesRaw
    })
  };
}
