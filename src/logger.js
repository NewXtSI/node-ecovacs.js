export function createLogger({ enableLogging = true, logConnection = true } = {}) {
  const log = (...args) => {
    if (!enableLogging) {
      return;
    }

    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}]`, ...args);
  };

  const logConn = (...args) => {
    if (!enableLogging || !logConnection) {
      return;
    }

    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}]`, ...args);
  };

  return {
    info: (...args) => log("INFO", ...args),
    warn: (...args) => log("WARN", ...args),
    error: (...args) => log("ERROR", ...args),
    connection: (...args) => logConn("INFO", ...args)
  };
}
