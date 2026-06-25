/**
 * Shared AreaSet subset decoder for API2.
 * Ports the LZMA-based decode logic from TopicCollector without the class dependency.
 */

import lzma from "lzma";

// ─── LZMA helpers ─────────────────────────────────────────────────────────

function parseLzmaJsonBuffer(compressedBuffer) {
  const decompressed = lzma.decompress(compressedBuffer);
  const jsonText = typeof decompressed === "string"
    ? decompressed
    : Buffer.from(decompressed).toString("utf8");
  return JSON.parse(jsonText);
}

function shouldUseLegacyHeader(compressedBuffer, expectedSize) {
  if (!Buffer.isBuffer(compressedBuffer) || compressedBuffer.length < 9) return false;
  if (!Number.isFinite(expectedSize) || expectedSize <= 0) return false;
  return compressedBuffer.readUInt32LE(5) === expectedSize;
}

function patchLegacyHeader(compressedBuffer) {
  return Buffer.concat([
    compressedBuffer.subarray(0, 9),
    Buffer.from([0, 0, 0, 0]),
    compressedBuffer.subarray(9)
  ]);
}

function decodeSubsetsBase64(base64String, expectedSize) {
  const buf = Buffer.from(String(base64String), "base64");
  try {
    return parseLzmaJsonBuffer(buf);
  } catch {
    if (!shouldUseLegacyHeader(buf, expectedSize)) throw new Error("LZMA decode failed");
    return parseLzmaJsonBuffer(patchLegacyHeader(buf));
  }
}

// ─── Type-specific row mappers ─────────────────────────────────────────────

function toMaybeNumber(value) {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return /^-?\d+$/.test(trimmed) ? Number(trimmed) : value;
}

function mapArRow(row) {
  if (!Array.isArray(row)) return row;
  return {
    areaId: toMaybeNumber(row[0]),
    pointIndex: toMaybeNumber(row[1]),
    name: row[2] || "",
    reserved: row[3] || "",
    x: toMaybeNumber(row[4]),
    y: toMaybeNumber(row[5]),
    interval: row[6] || ""
  };
}

function mapVwRow(row) {
  if (!Array.isArray(row)) return row;
  return {
    wallId: toMaybeNumber(row[0]),
    pointIndex: toMaybeNumber(row[1]),
    pointKind: toMaybeNumber(row[2]),
    x: toMaybeNumber(row[3]),
    y: toMaybeNumber(row[4])
  };
}

const ROW_MAPPERS = { ar: mapArRow, vw: mapVwRow };

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Decodes a raw getAreaSet response data payload into a typed, mapped structure.
 * Returns null if the payload is empty/missing, throws on decode failure.
 *
 * @param {{ mid, aid, type, subsets, infoSize }} data
 * @returns {{ type, mid, aid, items: Array } | null}
 */
export function decodeAreaSetPayload(data) {
  if (!data || typeof data !== "object") return null;
  if (!data.type) return null;

  // No subsets (e.g. nc with zero items)
  if (typeof data.subsets !== "string" || data.subsets.length === 0) {
    return { type: data.type, mid: data.mid, aid: data.aid, items: [] };
  }

  const raw = decodeSubsetsBase64(data.subsets, Number(data.infoSize) || 0);
  const rows = Array.isArray(raw) ? raw : [];
  const mapper = ROW_MAPPERS[data.type] ?? ((row) => row);
  const items = rows.map(mapper);

  return { type: data.type, mid: data.mid, aid: data.aid, items };
}
