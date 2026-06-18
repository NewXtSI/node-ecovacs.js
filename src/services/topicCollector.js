export class TopicCollector {
  constructor({ topicsConfig, logger, logDiscovery = false, onDiscoverTopic = null }) {
    this.topicsConfig = topicsConfig;
    this.logger = logger;
    this.logDiscovery = logDiscovery;
    this.onDiscoverTopic = onDiscoverTopic;
    this.discoveredTopics = new Set();
  }

  getTopicConfig(fullTopic) {
    const topicName = this.resolveTopicName(fullTopic);
    if (!topicName) {
      return null;
    }

    return {
      topicName,
      topicConfig: this.topicsConfig[topicName] || null
    };
  }

  shouldLogPayloadTopic(fullTopic) {
    const resolved = this.getTopicConfig(fullTopic);
    if (!resolved) {
      return false;
    }

    const { topicConfig } = resolved;
    return Boolean(topicConfig?.enabled && topicConfig?.consolePayload);
  }

  resolveTopicName(fullTopic) {
    const parts = String(fullTopic).split("/");
    if (parts.length < 3) {
      return null;
    }

    // iot/atr/[command]/... — broadcast from device, always a response
    if (parts[0] === "iot" && parts[1] === "atr") {
      return parts[2];
    }

    // iot/p2p/[command]/[from]/[fromClass]/[fromRes]/[to]/[toClass]/[toRes]/[q|p]/[msgId]/j
    // Only process 'p' (reply from device), skip 'q' (query sent to device)
    if (parts[0] === "iot" && parts[1] === "p2p") {
      const direction = parts[9];
      if (direction !== "p") {
        return null;
      }

      return parts[2];
    }

    return null;
  }

  collect(fullTopic, payloadString) {
    const resolved = this.getTopicConfig(fullTopic);
    if (!resolved) {
      return;
    }

    const { topicName, topicConfig } = resolved;

    // Handle discovered topics: auto-register and optionally log
    if (!topicConfig) {
      if (!this.discoveredTopics.has(topicName)) {
        this.discoveredTopics.add(topicName);
        if (this.logDiscovery) {
          this.logger.info("[TOPIC DISCOVERED]", { topic: topicName });
        }

        if (this.onDiscoverTopic) {
          this.onDiscoverTopic(topicName);
        }
      }

      return;
    }

    if (!topicConfig.enabled) {
      return;
    }

    // If no output flags are active at all, skip processing entirely
    if (!topicConfig.consoleOut && !topicConfig.consolePayload && !topicConfig.consoleParsed) {
      return;
    }

    let parsedPayload = null;

    try {
      parsedPayload = JSON.parse(payloadString);
    } catch {
      parsedPayload = null;
    }

    // consoleOut controls only the "Topic received" header line
    if (topicConfig.consoleOut) {
      this.logger.info("Topic received", {
        shortName: topicName,
        fullTopic
      });
    }

    if (topicConfig.consolePayload) {
      this.logger.info("Payload", payloadString);
    }

    if (topicConfig.consoleParsed && parsedPayload !== null) {
      const parsedInfo = this.parseTopicPayload(topicName, parsedPayload);
      if (parsedInfo !== null) {
        this.logger.info(`Parsed ${topicName}`, parsedInfo);
      }
    }
  }

  parseTopicPayload(topicName, parsedPayload) {
    if (topicName === "getPos") {
      const data = parsedPayload?.body?.data;
      if (!data || Object.keys(data).length === 0) {
        return null;
      }

      return data;
    }

    if (topicName === "getBattery") {
      const data = parsedPayload?.body?.data;
      return data || null;
    }

    if (topicName === "getChargeState") {
      const data = parsedPayload?.body?.data;
      return data || null;
    }

    if (topicName === "getNetInfo") {
      const data = parsedPayload?.body?.data;
      return data || null;
    }

    if (topicName === "getLifeSpan") {
      const data = parsedPayload?.body?.data;
      if (!Array.isArray(data) || data.length === 0) {
        return null;
      }

      // Convert array to object keyed by type: { blade: { left, total }, lensbrush: { left, total } }
      return Object.fromEntries(
        data.map(({ type, left, total }) => [type, { left, total }])
      );
    }

    return parsedPayload;
  }
}
