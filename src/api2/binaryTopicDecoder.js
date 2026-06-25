import lzma from "lzma";

export function parseLzmaJsonBuffer(compressedBuffer) {
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

export function decodeBinaryTopicBase64(base64String, expectedSize) {
  const buf = Buffer.from(String(base64String), "base64");
  try {
    return parseLzmaJsonBuffer(buf);
  } catch (primaryError) {
    if (shouldUseLegacyHeader(buf, expectedSize)) {
      return parseLzmaJsonBuffer(patchLegacyHeader(buf));
    }

    try {
      return parseLzmaJsonBuffer(patchLegacyHeader(buf));
    } catch {
      throw primaryError;
    }
  }
}
