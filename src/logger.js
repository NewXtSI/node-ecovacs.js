export function createLogger({ enableLogging = true, logConnection = true } = {}) {
  const state = {
    enableLogging: Boolean(enableLogging),
    logConnection: Boolean(logConnection)
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

  return {
    info: (...args) => log("INFO", ...args),
    warn: (...args) => log("WARN", ...args),
    error: (...args) => log("ERROR", ...args),
    connection: (...args) => logConn("INFO", ...args),
    setEnableLogging: (enabled) => {
      state.enableLogging = Boolean(enabled);
    },
    setLogConnection: (enabled) => {
      state.logConnection = Boolean(enabled);
    },
    setOptions: ({ enableLogging: nextEnableLogging, logConnection: nextLogConnection } = {}) => {
      if (typeof nextEnableLogging !== "undefined") {
        state.enableLogging = Boolean(nextEnableLogging);
      }
      if (typeof nextLogConnection !== "undefined") {
        state.logConnection = Boolean(nextLogConnection);
      }
    },
    getOptions: () => ({
      enableLogging: state.enableLogging,
      logConnection: state.logConnection
    })
  };
}
