export function createLogger({ enabled = true } = {}) {
  const log = (...args) => {
    if (!enabled) {
      return;
    }

    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}]`, ...args);
  };

  return {
    info: (...args) => log("INFO", ...args),
    warn: (...args) => log("WARN", ...args),
    error: (...args) => log("ERROR", ...args)
  };
}
