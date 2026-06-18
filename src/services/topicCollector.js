export class TopicCollector {
  constructor({ topicsConfig, logger }) {
    this.topicsConfig = topicsConfig;
    this.logger = logger;
    this.seenTopics = new Set();
  }

  resolveTopicName(fullTopic) {
    const parts = String(fullTopic).split("/");
    if (parts.length < 3) {
      return null;
    }

    // iot/atr/[command]/...
    // iot/p2p/[command]/...
    if (parts[0] === "iot" && (parts[1] === "atr" || parts[1] === "p2p")) {
      return parts[2];
    }

    return null;
  }

  collect(fullTopic, payloadString) {
    const topicName = this.resolveTopicName(fullTopic);
    if (!topicName) {
      return;
    }

    const parts = fullTopic.split("/");
    const topicType = parts[1]; // "atr" or "p2p"

    // Discovery: log every ATR/P2P command name the first time it appears
    const seenKey = `${topicType}:${topicName}`;
    if (!this.seenTopics.has(seenKey)) {
      this.seenTopics.add(seenKey);
      this.logger.info(`[${topicType.toUpperCase()} DISCOVERED]`, {
        command: topicName,
        did: parts[3] || null
      });
    }

    const topicConfig = this.topicsConfig[topicName];
    if (!topicConfig?.enabled) {
      return;
    }

    let parsedPayload = null;

    try {
      parsedPayload = JSON.parse(payloadString);
    } catch {
      parsedPayload = null;
    }

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
      this.logger.info("Parsed payload", parsedPayload);
    }
  }
}
