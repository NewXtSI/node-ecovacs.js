import lzma from "lzma";

const BINARY_TOPIC_TTL_MS = 10 * 60 * 1000;

export class TopicCollector {
  constructor({ topicsConfig, logger, logDiscovery = false, logBinaryTopics = false, onDiscoverTopic = null }) {
    this.topicsConfig = topicsConfig;
    this.logger = logger;
    this.logDiscovery = logDiscovery;
    this.logBinaryTopics = logBinaryTopics;
    this.onDiscoverTopic = onDiscoverTopic;
    this.discoveredTopics = new Set();
    this.binaryTopicBuffers = new Map();
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
    if (parts[0] === "iot" && parts[1] === "p2p") {
      return parts[2];
    }

    return null;
  }

  isDeviceReply(fullTopic) {
    const parts = String(fullTopic).split("/");
    // atr topics are always device-originated
    if (parts[1] === "atr") {
      return true;
    }

    // p2p: direction is at index 9 — 'p' = reply from device, 'q' = query to device
    return parts[9] === "p";
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

    if (topicConfig.consoleParsed && parsedPayload !== null && this.isDeviceReply(fullTopic)) {
      const parsedInfo = this.parseTopicPayload(topicName, parsedPayload);
      if (parsedInfo !== null) {
        this.logger.info(`Parsed ${topicName}`, parsedInfo);
      }
    }
  }

  parseTopicPayload(topicName, parsedPayload) {
    const binaryTopicPayload = this.parseBinaryTopicPayload(topicName, parsedPayload);
    if (binaryTopicPayload !== undefined) {
      return binaryTopicPayload;
    }

    if (topicName === "clean") {
      const body = parsedPayload?.body;
      if (!body) return null;
      // Request: body.data.act present
      if (body.data && typeof body.data.act !== "undefined") {
        return { direction: "request", act: body.data.act, content: body.data.content ?? null };
      }
      // Response: body.code present
      if (typeof body.code !== "undefined") {
        return { direction: "response", code: body.code, msg: body.msg };
      }
      return null;
    }

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

    if (topicName === "getMapState") {
      const data = parsedPayload?.body?.data;
      return data || null;
    }

    if (topicName === "getPIN") {
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

    if (topicName === "getSleep") {
      const data = parsedPayload?.body?.data;
      return data || null;
    }

    if (topicName === "getTotalStats") {
      const data = parsedPayload?.body?.data;
      return data || null;
    }

    if (topicName === "getAreaSet") {
      const data = parsedPayload?.body?.data;
      if (!data) {
        return null;
      }

      if (typeof data.subsets !== "string" || data.subsets.length === 0) {
        return data;
      }

      return this.parseAreaSetSubsets(data);
    }

    if (topicName === "getAreaParameter") {
      const data = parsedPayload?.body?.data;
      return data || null;
    }

    if (topicName === "getScheduleTaskInfo") {
      const data = parsedPayload?.body?.data;
      return data || null;
    }

    if (topicName === "getScheduleLatestTask") {
      const data = parsedPayload?.body?.data;
      return data || null;
    }

    if (topicName === "getRemoteSupport") {
      const data = parsedPayload?.body?.data;
      return data || null;
    }

    if (topicName === "getCleanInfo") {
      const data = parsedPayload?.body?.data;
      if (!data || Object.keys(data).length === 0) {
        return null;
      }

      return data;
    }

    if (topicName === "onCleanInfo") {
      const data = parsedPayload?.body?.data;
      return data || null;
    }

    if (topicName === "onChargeState") {
      const data = parsedPayload?.body?.data;
      return data || null;
    }

    if (topicName === "onChargeInfo") {
      const data = parsedPayload?.body?.data;
      return data || null;
    }

    if (topicName === "onBattery") {
      const data = parsedPayload?.body?.data;
      return data || null;
    }

    if (topicName === "onPos") {
      const data = parsedPayload?.body?.data;
      return data || null;
    }

    if (topicName === "onStats") {
      const data = parsedPayload?.body?.data;
      return data || null;
    }

    if (topicName === "onMapTrace") {
      const data = parsedPayload?.body?.data;
      return data || null;
    }

    if (topicName === "onLastTimeStats") {
      const data = parsedPayload?.body?.data;
      return data || null;
    }

    if (topicName === "onError") {
      const data = parsedPayload?.body?.data;
      return data || null;
    }

    if (topicName === "onFwBuryPoint-bd_basicinfo") {
      return this.parseBuryPointBasicInfo(parsedPayload?.body);
    }

    if (topicName === "onFwBuryPoint-bd_setting") {
      return this.parseBuryPointSetting(parsedPayload?.body);
    }

    if (topicName.startsWith("onFwBuryPoint-")) {
      const data = parsedPayload?.body;
      return data || null;
    }

    if (topicName === "getVolume" || topicName === "onVolume") {
      const data = parsedPayload?.body?.data;
      return data || null;
    }

    if (topicName === "getStats") {
      const data = parsedPayload?.body?.data;
      return data || null;
    }

    if (topicName === "getBreakPointStatus") {
      const data = parsedPayload?.body?.data;
      return data || null;
    }

    if (topicName === "getChargeInfo") {
      const data = parsedPayload?.body?.data;
      return data || null;
    }

    if (topicName === "getProtectState") {
      const data = parsedPayload?.body?.data;
      return data || null;
    }

    if (topicName === "getError") {
      const data = parsedPayload?.body?.data;
      return data || null;
    }

    if (topicName === "getRTK") {
      const data = parsedPayload?.body?.data;
      if (!data) {
        return null;
      }

      const rtks = Array.isArray(data.rtks)
        ? data.rtks.map((rtk) => ({
          ...rtk,
          x: Number.isFinite(Number(rtk?.x)) ? Number(rtk.x) : rtk?.x,
          y: Number.isFinite(Number(rtk?.y)) ? Number(rtk.y) : rtk?.y,
          state: Number.isFinite(Number(rtk?.state)) ? Number(rtk.state) : rtk?.state,
          mode: Number.isFinite(Number(rtk?.mode)) ? Number(rtk.mode) : rtk?.mode,
          star: Number.isFinite(Number(rtk?.star)) ? Number(rtk.star) : rtk?.star,
          versionParts: typeof rtk?.version === "string"
            ? rtk.version.split(",").map((part) => part.trim()).filter(Boolean)
            : []
        }))
        : [];

      return {
        ...data,
        rtks
      };
    }

    if (topicName === "getRTKOta") {
      const data = parsedPayload?.body?.data;
      return data || null;
    }

    if (topicName === "getRobotFeature") {
      const data = parsedPayload?.body?.data;
      return data || null;
    }

    if (topicName === "getGeolocation") {
      const data = parsedPayload?.body?.data;
      return data || null;
    }

    if (topicName === "getTimeZone") {
      const data = parsedPayload?.body?.data;
      return data || null;
    }

    if (topicName === "getMoveupWarning") {
      const data = parsedPayload?.body?.data;
      return data || null;
    }

    if (topicName === "getRecognization") {
      const data = parsedPayload?.body?.data;
      return data || null;
    }

    if (topicName === "getCutEfficiency") {
      const data = parsedPayload?.body?.data;
      return data || null;
    }

    if (topicName === "getObstacleHeight") {
      const data = parsedPayload?.body?.data;
      return data || null;
    }

    if (topicName === "getCutHeight") {
      const data = parsedPayload?.body?.data;
      return data || null;
    }

    if (topicName === "getCutDirection") {
      const data = parsedPayload?.body?.data;
      return data || null;
    }

    if (topicName === "getAutoCutDirection") {
      const data = parsedPayload?.body?.data;
      return data || null;
    }

    if (topicName === "getRainDelay") {
      const data = parsedPayload?.body?.data;
      return data || null;
    }

    if (topicName === "getCustomCutMode") {
      const data = parsedPayload?.body?.data;
      return data || null;
    }

    if (topicName === "getBorderSwitch") {
      const data = parsedPayload?.body?.data;
      return data || null;
    }

    if (topicName === "onRemoteSupport") {
      const data = parsedPayload?.body?.data;
      return data || null;
    }

    if (topicName === "onScheduleLatestTask") {
      const data = parsedPayload?.body?.data;
      return data || null;
    }

    if (topicName === "getCrossMapBorderWarning") {
      const data = parsedPayload?.body?.data;
      return data || null;
    }

    if (topicName === "getAnimProtect") {
      const data = parsedPayload?.body?.data;
      return data || null;
    }

    if (topicName === "getLastTimeStats") {
      const data = parsedPayload?.body?.data;
      return data || null;
    }

    if (topicName === "getInfo") {
      const data = parsedPayload?.body?.data;
      if (!data || Object.keys(data).length === 0) {
        return null;
      }

      const result = {};
      for (const [nestedCommandName, nestedPayload] of Object.entries(data)) {
        if (nestedCommandName.startsWith("get")) {
          // Check if nested command is known
          if (!this.topicsConfig[nestedCommandName]) {
            // Treat unknown nested command like a discovered topic
            if (!this.discoveredTopics.has(nestedCommandName)) {
              this.discoveredTopics.add(nestedCommandName);
              if (this.logDiscovery) {
                this.logger.info("[TOPIC DISCOVERED]", { topic: nestedCommandName, context: "nested in getInfo" });
              }

              if (this.onDiscoverTopic) {
                this.onDiscoverTopic(nestedCommandName);
              }
            }
          }

          const nestedParsed = this.parseTopicPayload(nestedCommandName, { body: nestedPayload });
          result[nestedCommandName] = nestedParsed !== null ? nestedParsed : nestedPayload;
        } else {
          result[nestedCommandName] = nestedPayload;
        }
      }

      return result;
    }

    return parsedPayload;
  }

  parseBinaryTopicPayload(topicName, parsedPayload) {
    const chunkData = parsedPayload?.body?.data;
    if (!this.isBinaryTopicChunk(chunkData)) {
      return undefined;
    }

    this.pruneBinaryTopicBuffers();

    const bufferKey = this.getBinaryTopicBufferKey(topicName, chunkData);
    const binaryTopicBuffer = this.binaryTopicBuffers.get(bufferKey) || {
      expectedSize: 0,
      expectedChunkCount: 0,
      chunks: new Map(),
      updatedAt: Date.now()
    };

    binaryTopicBuffer.expectedSize = Number(chunkData.infoSize) || 0;
    binaryTopicBuffer.expectedChunkCount = Number(chunkData.serial) || 0;
    binaryTopicBuffer.updatedAt = Date.now();
    binaryTopicBuffer.chunks.set(Number(chunkData.index), String(chunkData.info));
    this.binaryTopicBuffers.set(bufferKey, binaryTopicBuffer);

    const progress = this.getBinaryTopicProgress(binaryTopicBuffer);
    if (this.logBinaryTopics) {
      this.logger.info("[BINARY TOPIC CHUNK]", {
        topic: topicName,
        serial: chunkData.serial,
        batid: chunkData.batid || null,
        chunkIndex: Number(chunkData.index),
        expectedSize: binaryTopicBuffer.expectedSize,
        expectedChunkCount: binaryTopicBuffer.expectedChunkCount,
        ...progress
      });
    }

    const assembledBase64 = this.assembleBinaryTopicBuffer(binaryTopicBuffer, progress);
    if (assembledBase64 === null) {
      return null;
    }

    this.binaryTopicBuffers.delete(bufferKey);

    if (this.logBinaryTopics) {
      this.logger.info("[BINARY TOPIC COMPLETE]", {
        topic: topicName,
        serial: chunkData.serial,
        batid: chunkData.batid || null,
        expectedSize: binaryTopicBuffer.expectedSize,
        expectedChunkCount: binaryTopicBuffer.expectedChunkCount,
        completionMode: progress.completeByChunkCount ? "chunks" : (progress.completeByBase64 ? "base64" : "bytes"),
        ...progress
      });
    }

    try {
      const compressedBuffer = Buffer.from(assembledBase64, "base64");
      return this.decodeBinaryTopicJson(compressedBuffer, binaryTopicBuffer.expectedSize);
    } catch (error) {
      this.logger.warn("Failed to decode binary topic payload", {
        topic: topicName,
        serial: chunkData.serial,
        expectedSize: binaryTopicBuffer.expectedSize,
        expectedChunkCount: binaryTopicBuffer.expectedChunkCount,
        compressedByteLength: Buffer.from(assembledBase64, "base64").length,
        lzmaHeaderHex: Buffer.from(assembledBase64, "base64").subarray(0, 13).toString("hex"),
        error: error.message
      });

      return null;
    }
  }

  decodeBinaryTopicJson(compressedBuffer, expectedSize) {
    try {
      return this.parseLzmaJsonBuffer(compressedBuffer);
    } catch (primaryError) {
      if (!this.shouldUseLegacy32BitLzmaHeader(compressedBuffer, expectedSize)) {
        throw primaryError;
      }

      const patchedBuffer = this.patchLegacy32BitLzmaHeader(compressedBuffer);
      return this.parseLzmaJsonBuffer(patchedBuffer);
    }
  }

  parseAreaSetSubsets(data) {
    const expectedSize = Number(data.infoSize) || 0;

    try {
      const compressedBuffer = Buffer.from(String(data.subsets), "base64");
      let subsetsDecoded;

      try {
        subsetsDecoded = this.decodeBinaryTopicJson(compressedBuffer, expectedSize);
      } catch {
        // Some getAreaSet subset payloads use the legacy 32-bit size header without matching infoSize.
        const patchedBuffer = this.patchLegacy32BitLzmaHeader(compressedBuffer);
        subsetsDecoded = this.parseLzmaJsonBuffer(patchedBuffer);
      }

      const subsetsMeta = {
        kind: Array.isArray(subsetsDecoded) ? "array" : typeof subsetsDecoded,
        count: Array.isArray(subsetsDecoded) ? subsetsDecoded.length : null
      };

      const subsetsMapped = this.mapAreaSetSubsets(data.type, subsetsDecoded);

      return {
        ...data,
        subsetsDecodedRaw: subsetsDecoded,
        subsetsDecoded,
        subsetsMapped,
        subsetsMeta
      };
    } catch (error) {
      this.logger.warn("Failed to decode getAreaSet subsets", {
        type: data.type || null,
        infoSize: data.infoSize,
        error: error.message
      });

      return data;
    }
  }

  mapAreaSetSubsets(type, subsetsDecoded) {
    if (!Array.isArray(subsetsDecoded)) {
      return subsetsDecoded;
    }

    if (type === "vw") {
      return subsetsDecoded.map((row) => {
        if (!Array.isArray(row)) {
          return row;
        }

        return {
          wallId: this.toMaybeNumber(row[0]),
          pointIndex: this.toMaybeNumber(row[1]),
          pointKind: this.toMaybeNumber(row[2]),
          x: this.toMaybeNumber(row[3]),
          y: this.toMaybeNumber(row[4]),
          raw: row
        };
      });
    }

    if (type === "ar") {
      return subsetsDecoded.map((row) => {
        if (!Array.isArray(row)) {
          return row;
        }

        return {
          areaId: this.toMaybeNumber(row[0]),
          pointIndex: this.toMaybeNumber(row[1]),
          name: row[2] || "",
          reserved: row[3] || "",
          x: this.toMaybeNumber(row[4]),
          y: this.toMaybeNumber(row[5]),
          interval: row[6] || "",
          raw: row
        };
      });
    }

    return subsetsDecoded;
  }

  toMaybeNumber(value) {
    if (typeof value === "number") {
      return value;
    }

    if (typeof value !== "string") {
      return value;
    }

    const trimmed = value.trim();
    if (/^-?\d+$/.test(trimmed)) {
      return Number(trimmed);
    }

    return value;
  }

  parseBuryPointBasicInfo(body) {
    if (!body || typeof body !== "object") {
      return null;
    }

    return {
      ...body,
      robotPosParsed: this.parsePoseCsv(body.robotPos),
      chargerPosParsed: this.parsePoseCsv(body.chargerPos)
    };
  }

  parseBuryPointSetting(body) {
    if (!body || typeof body !== "object") {
      return null;
    }

    const areaParameters = Array.isArray(body.AreaParameters)
      ? body.AreaParameters.map((areaParameter) => ({
        ...areaParameter,
        areaID: this.toMaybeNumber(areaParameter?.areaID),
        cutMode: this.toMaybeNumber(areaParameter?.cutMode),
        mowHeightLevel: this.toMaybeNumber(areaParameter?.mowHeightLevel),
        obstacleHeight: this.toMaybeNumber(areaParameter?.obstacleHeight)
      }))
      : [];

    return {
      ...body,
      AreaParameters: areaParameters,
      areaParameterCount: areaParameters.length
    };
  }

  parsePoseCsv(value) {
    if (typeof value !== "string" || value.length === 0) {
      return null;
    }

    const parts = value.split(",").map((part) => part.trim());
    if (parts.length < 3) {
      return null;
    }

    const x = Number(parts[0]);
    const y = Number(parts[1]);
    const angleRad = Number(parts[2]);
    const invalid = parts.length >= 4 ? this.toMaybeNumber(parts[3]) : null;

    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(angleRad)) {
      return null;
    }

    return {
      x,
      y,
      angleRad,
      angleDeg: angleRad * (180 / Math.PI),
      invalid
    };
  }

  parseLzmaJsonBuffer(compressedBuffer) {
    const decompressedPayload = lzma.decompress(compressedBuffer);
    const jsonText = typeof decompressedPayload === "string"
      ? decompressedPayload
      : Buffer.from(decompressedPayload).toString("utf8");

    return JSON.parse(jsonText);
  }

  shouldUseLegacy32BitLzmaHeader(compressedBuffer, expectedSize) {
    if (!Buffer.isBuffer(compressedBuffer) || compressedBuffer.length < 9) {
      return false;
    }

    if (!Number.isFinite(expectedSize) || expectedSize <= 0) {
      return false;
    }

    const lower32BitSize = compressedBuffer.readUInt32LE(5);
    return lower32BitSize === expectedSize;
  }

  patchLegacy32BitLzmaHeader(compressedBuffer) {
    return Buffer.concat([
      compressedBuffer.subarray(0, 9),
      Buffer.from([0, 0, 0, 0]),
      compressedBuffer.subarray(9)
    ]);
  }

  isBinaryTopicChunk(chunkData) {
    return Boolean(
      chunkData &&
      typeof chunkData === "object" &&
      chunkData.serial !== undefined &&
      chunkData.index !== undefined &&
      chunkData.infoSize !== undefined &&
      typeof chunkData.info === "string"
    );
  }

  getBinaryTopicBufferKey(topicName, chunkData) {
    return [
      topicName,
      chunkData.batid || "",
      chunkData.mid || "",
      chunkData.type || ""
    ].join(":");
  }

  getBinaryTopicProgress(binaryTopicBuffer) {
    const orderedChunks = [...binaryTopicBuffer.chunks.entries()].sort((left, right) => left[0] - right[0]);
    const chunkIndexes = orderedChunks.map(([chunkIndex]) => chunkIndex);
    const chunkCount = orderedChunks.length;
    const highestIndex = chunkCount === 0 ? -1 : orderedChunks[chunkCount - 1][0];

    let contiguousChunks = 0;
    let assembledBase64Length = 0;
    let decodedByteLength = 0;

    for (let expectedIndex = 0; expectedIndex < orderedChunks.length; expectedIndex += 1) {
      const [chunkIndex, chunkValue] = orderedChunks[expectedIndex];
      if (chunkIndex !== expectedIndex) {
        break;
      }

      contiguousChunks += 1;
      assembledBase64Length += chunkValue.length;
      decodedByteLength = Buffer.from(orderedChunks.slice(0, contiguousChunks).map(([, value]) => value).join(""), "base64").length;
    }

    return {
      chunkCount,
      chunkIndexes,
      highestIndex,
      contiguousChunks,
      assembledBase64Length,
      decodedByteLength,
      completeByChunkCount: Number.isFinite(binaryTopicBuffer.expectedChunkCount) && binaryTopicBuffer.expectedChunkCount > 0
        ? contiguousChunks >= binaryTopicBuffer.expectedChunkCount
        : false,
      completeByBase64: assembledBase64Length >= binaryTopicBuffer.expectedSize,
      completeByBytes: decodedByteLength >= binaryTopicBuffer.expectedSize
    };
  }

  assembleBinaryTopicBuffer(binaryTopicBuffer, progress = null) {
    if (!Number.isFinite(binaryTopicBuffer.expectedSize) || binaryTopicBuffer.expectedSize <= 0) {
      return null;
    }

    const orderedChunks = [...binaryTopicBuffer.chunks.entries()].sort((left, right) => left[0] - right[0]);
    if (orderedChunks.length === 0 || orderedChunks[0][0] !== 0) {
      return null;
    }

    if (
      Number.isFinite(binaryTopicBuffer.expectedChunkCount) &&
      binaryTopicBuffer.expectedChunkCount > 0 &&
      orderedChunks.length >= binaryTopicBuffer.expectedChunkCount &&
      orderedChunks[binaryTopicBuffer.expectedChunkCount - 1]?.[0] === binaryTopicBuffer.expectedChunkCount - 1
    ) {
      return orderedChunks
        .slice(0, binaryTopicBuffer.expectedChunkCount)
        .map(([, chunkValue]) => chunkValue)
        .join("");
    }

    let assembledBase64 = "";

    for (let expectedIndex = 0; expectedIndex < orderedChunks.length; expectedIndex += 1) {
      const [chunkIndex, chunkValue] = orderedChunks[expectedIndex];
      if (chunkIndex !== expectedIndex) {
        return null;
      }

      assembledBase64 += chunkValue;

      const decodedByteLength = Buffer.from(assembledBase64, "base64").length;
      if (assembledBase64.length >= binaryTopicBuffer.expectedSize) {
        return assembledBase64.slice(0, binaryTopicBuffer.expectedSize);
      }

      if (decodedByteLength >= binaryTopicBuffer.expectedSize) {
        return assembledBase64;
      }
    }

    if (progress && (progress.completeByBase64 || progress.completeByBytes)) {
      return assembledBase64;
    }

    return null;
  }

  pruneBinaryTopicBuffers() {
    const expireBefore = Date.now() - BINARY_TOPIC_TTL_MS;

    for (const [bufferKey, binaryTopicBuffer] of this.binaryTopicBuffers.entries()) {
      if (binaryTopicBuffer.updatedAt < expireBefore) {
        this.binaryTopicBuffers.delete(bufferKey);
      }
    }
  }
}
