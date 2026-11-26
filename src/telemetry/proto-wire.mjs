/* Ported from yuhuan-dev/antigravity-usage-monitor (GPL-3.0) with Magpie read-only import paths. */
/**
 * @fileoverview 零外部依赖的二进制 Protobuf Wire 跳读游标与 `prototext` 字符串反转义原语 (`proto-wire.mjs`)。
 *
 * 核心能力：
 * 1. 无需引入 `protobufjs`，以 `O(1)` 游标位移跳过大体积定长/变长/Group 载荷；
 * 2. 基于 `BigInt` 无损解码 64-bit Varint、`google.protobuf.Timestamp` 纳秒级时间戳与 `Duration`；
 * 3. 按原始 UTF-8 字节流无损反转义 `prototext` 的 `\ddd` 八进制、`\xHH` 十六进制与 `\uXXXX` 多字节字符。
 */

const protoUtf8Decoder = typeof TextDecoder === 'function' ? new TextDecoder('utf-8') : null;

/**
 * 解码 Protobuf Text Format (`prototext`) 字符串字面量，兼容 UTF-8 原文与 `\ddd` / `\xHH` 字节转义。
 *
 * @param {string} raw
 * @returns {string}
 */
export function unescapePbtxtString(raw) {
  if (typeof raw !== 'string' || !raw) return '';
  if (!raw.includes('\\')) return raw;
  const bytes = [];
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch !== '\\' || i + 1 >= raw.length) {
      const encoded = Buffer.from(ch, 'utf8');
      for (let b = 0; b < encoded.length; b++) bytes.push(encoded[b]);
      continue;
    }
    const next = raw[++i];
    if (next >= '0' && next <= '7') {
      let oct = next;
      if (i + 1 < raw.length && raw[i + 1] >= '0' && raw[i + 1] <= '7') oct += raw[++i];
      if (i + 1 < raw.length && raw[i + 1] >= '0' && raw[i + 1] <= '7') oct += raw[++i];
      bytes.push(parseInt(oct, 8) & 0xff);
    } else if ((next === 'x' || next === 'X') && i + 2 < raw.length) {
      const hex = raw.slice(i + 1, i + 3);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 2;
      } else {
        bytes.push(next.charCodeAt(0));
      }
    } else if (next === 'u' && i + 4 < raw.length) {
      const uHex = raw.slice(i + 1, i + 5);
      if (/^[0-9a-fA-F]{4}$/.test(uHex)) {
        const encoded = Buffer.from(String.fromCharCode(parseInt(uHex, 16)), 'utf8');
        for (let b = 0; b < encoded.length; b++) bytes.push(encoded[b]);
        i += 4;
      } else {
        bytes.push(next.charCodeAt(0));
      }
    } else if (next === 'n') {
      bytes.push(0x0a);
    } else if (next === 'r') {
      bytes.push(0x0d);
    } else if (next === 't') {
      bytes.push(0x09);
    } else {
      const encoded = Buffer.from(next, 'utf8');
      for (let b = 0; b < encoded.length; b++) bytes.push(encoded[b]);
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

export function toUint8Array(raw) {
  if (!raw) return null;
  if (raw instanceof Uint8Array) return raw;
  if (ArrayBuffer.isView(raw)) {
    return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  }
  if (raw instanceof ArrayBuffer) {
    return new Uint8Array(raw);
  }
  return null;
}

export function decodeUtf8Slice(buf, start, end) {
  if (start >= end) return '';
  if (protoUtf8Decoder) {
    return protoUtf8Decoder.decode(buf.subarray(start, end));
  }
  return Buffer.from(buf.buffer, buf.byteOffset + start, end - start).toString('utf8');
}

export function readProtoVarint(buf, state, limit = buf.length) {
  if (state.off >= limit) return 0n;
  const b0 = buf[state.off];
  if (b0 < 0x80) {
    state.off += 1;
    return BigInt(b0);
  }
  let result = 0n;
  let shift = 0n;
  for (let i = 0; i < 10 && state.off < limit; i++) {
    const byte = buf[state.off++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return BigInt.asUintN(64, result);
    }
    shift += 7n;
  }
  while (state.off < limit && (buf[state.off++] & 0x80) !== 0) {
    // 安全排空超长 varint 延续字节
  }
  return BigInt.asUintN(64, result);
}

export function readSubEnd(buf, state, limit = buf.length) {
  const len = Number(BigInt.asUintN(32, readProtoVarint(buf, state, limit)));
  return Math.min(limit, state.off + len);
}

export function readProtoString(buf, state, limit = buf.length) {
  const end = readSubEnd(buf, state, limit);
  const str = decodeUtf8Slice(buf, state.off, end);
  state.off = end;
  return str;
}

export function skipProtoField(buf, state, wireType, limit = buf.length) {
  if (wireType === 0) {
    readProtoVarint(buf, state, limit);
  } else if (wireType === 1) {
    state.off = Math.min(limit, state.off + 8);
  } else if (wireType === 2) {
    state.off = readSubEnd(buf, state, limit);
  } else if (wireType === 5) {
    state.off = Math.min(limit, state.off + 4);
  } else if (wireType === 3) {
    while (state.off < limit) {
      const innerTag = Number(BigInt.asUintN(32, readProtoVarint(buf, state, limit)));
      const innerWt = innerTag & 7;
      if (innerWt === 4) break;
      skipProtoField(buf, state, innerWt, limit);
    }
  } else if (wireType !== 4) {
    state.off = limit;
  }
}

export function decodeProtoTimestampSlice(buf, state, end) {
  let seconds = 0n;
  let nanos = 0n;
  while (state.off < end) {
    const tag = Number(BigInt.asUintN(32, readProtoVarint(buf, state, end)));
    const fn = tag >>> 3;
    const wt = tag & 7;
    if (fn === 1 && wt === 0) {
      seconds = BigInt.asIntN(64, readProtoVarint(buf, state, end));
    } else if (fn === 2 && wt === 0) {
      nanos = BigInt.asIntN(32, readProtoVarint(buf, state, end));
    } else {
      skipProtoField(buf, state, wt, end);
    }
  }
  state.off = end;
  if (seconds <= 0n || seconds > 253402300799n) return '';
  const baseIso = new Date(Number(seconds) * 1000).toISOString().slice(0, 19);
  if (nanos > 0n && nanos < 1_000_000_000n) {
    const frac = String(nanos).padStart(9, '0').replace(/0+$/, '');
    return frac ? `${baseIso}.${frac}Z` : `${baseIso}Z`;
  }
  return `${baseIso}Z`;
}

export function decodeProtoDurationSlice(buf, state, end) {
  let seconds = 0n;
  let nanos = 0n;
  while (state.off < end) {
    const tag = Number(BigInt.asUintN(32, readProtoVarint(buf, state, end)));
    const fn = tag >>> 3;
    const wt = tag & 7;
    if (fn === 1 && wt === 0) {
      seconds = BigInt.asIntN(64, readProtoVarint(buf, state, end));
    } else if (fn === 2 && wt === 0) {
      nanos = BigInt.asIntN(32, readProtoVarint(buf, state, end));
    } else {
      skipProtoField(buf, state, wt, end);
    }
  }
  state.off = end;
  const totalNs = seconds * 1_000_000_000n + nanos;
  if (totalNs < 0n) return '';
  if (totalNs === 0n) return '0s';
  const wholeSec = totalNs / 1_000_000_000n;
  const remNs = Number(totalNs % 1_000_000_000n);
  if (remNs === 0) return `${wholeSec}s`;
  const frac = String(remNs).padStart(9, '0').replace(/0+$/, '');
  return `${wholeSec}.${frac}s`;
}

export function decodeProtoMapStringEntry(buf, state, end) {
  let key = '';
  let val = '';
  while (state.off < end) {
    const tag = Number(BigInt.asUintN(32, readProtoVarint(buf, state, end)));
    const fn = tag >>> 3;
    const wt = tag & 7;
    if (fn === 1 && wt === 2) {
      key = readProtoString(buf, state, end);
    } else if (fn === 2 && wt === 2) {
      val = readProtoString(buf, state, end);
    } else {
      skipProtoField(buf, state, wt, end);
    }
  }
  state.off = end;
  return [key, val];
}

// ---------------------------------------------------------------------------
// 无损 Protobuf Wire 编码及按字段号定向修补原语（保留所有未知/未触碰字段原字节）
// ---------------------------------------------------------------------------

export function encodeProtoVarint(value) {
  let n = typeof value === 'bigint' ? value : BigInt(Math.trunc(Number(value) || 0));
  if (n < 0n) n = BigInt.asUintN(64, n);
  const bytes = [];
  do {
    let b = Number(n & 0x7fn);
    n >>= 7n;
    if (n > 0n) b |= 0x80;
    bytes.push(b);
  } while (n > 0n);
  return Buffer.from(bytes);
}

export function encodeProtoTag(fieldNumber, wireType) {
  return encodeProtoVarint((BigInt(fieldNumber) << 3n) | BigInt(wireType & 7));
}

export function encodeProtoVarintField(fieldNumber, value) {
  return Buffer.concat([encodeProtoTag(fieldNumber, 0), encodeProtoVarint(value)]);
}

export function encodeProtoBytesField(fieldNumber, payload) {
  const buf = payload instanceof Buffer ? payload : Buffer.from(payload || []);
  return Buffer.concat([encodeProtoTag(fieldNumber, 2), encodeProtoVarint(buf.length), buf]);
}

export function encodeProtoStringField(fieldNumber, text) {
  return encodeProtoBytesField(fieldNumber, Buffer.from(String(text ?? ''), 'utf8'));
}

export function encodeProtoTimestamp(epochMs) {
  const ms = Number(epochMs);
  if (!Number.isFinite(ms) || ms <= 0) return Buffer.alloc(0);
  const seconds = Math.floor(ms / 1000);
  const nanos = Math.floor((ms - seconds * 1000) * 1_000_000);
  const parts = [encodeProtoVarintField(1, seconds)];
  if (nanos > 0) {
    parts.push(encodeProtoVarintField(2, nanos));
  }
  return Buffer.concat(parts);
}

/**
 * 将原始 Protobuf 二进制消息拆分为顶层原始字段切片，确保未知字段零损透传。
 *
 * @param {Uint8Array | Buffer} raw
 * @returns {Array<{ fn: number, wt: number, raw: Buffer, payload: Buffer }>}
 */
export function splitProtoRawFields(raw) {
  const u8 = toUint8Array(raw);
  if (!u8 || u8.byteLength === 0) return [];
  const buf = Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);
  const state = { off: 0 };
  const limit = buf.length;
  const fields = [];
  while (state.off < limit) {
    const start = state.off;
    const tag = Number(BigInt.asUintN(32, readProtoVarint(buf, state, limit)));
    const fn = tag >>> 3;
    const wt = tag & 7;
    if (fn === 0) break;
    let payloadStart = state.off;
    let payloadEnd = state.off;
    if (wt === 0) {
      readProtoVarint(buf, state, limit);
      payloadEnd = state.off;
    } else if (wt === 1) {
      state.off = Math.min(limit, state.off + 8);
      payloadEnd = state.off;
    } else if (wt === 5) {
      state.off = Math.min(limit, state.off + 4);
      payloadEnd = state.off;
    } else if (wt === 2) {
      const end = readSubEnd(buf, state, limit);
      payloadStart = state.off;
      state.off = end;
      payloadEnd = end;
    } else if (wt === 3) {
      skipProtoField(buf, state, 3, limit);
      payloadEnd = state.off;
    } else {
      break;
    }
    fields.push({
      fn,
      wt,
      raw: buf.subarray(start, state.off),
      payload: buf.subarray(payloadStart, payloadEnd),
    });
  }
  return fields;
}

/**
 * 按字段号定向替换、删除（传 `null`）或追加 Protobuf 顶层字段，其余未知字段原字节无损保留。
 *
 * @param {Uint8Array | Buffer} raw
 * @param {Map<number, Buffer | Uint8Array | null>} replacements
 * @returns {Buffer}
 */
export function patchProtoMessageFields(raw, replacements) {
  const fields = splitProtoRawFields(raw);
  const handled = new Set();
  const out = [];
  for (const field of fields) {
    if (replacements.has(field.fn)) {
      if (!handled.has(field.fn)) {
        handled.add(field.fn);
        const rep = replacements.get(field.fn);
        if (rep && rep.length > 0) {
          out.push(Buffer.from(rep));
        }
      }
    } else {
      out.push(field.raw);
    }
  }
  for (const [fn, rep] of replacements.entries()) {
    if (!handled.has(fn) && rep && rep.length > 0) {
      out.push(Buffer.from(rep));
    }
  }
  return Buffer.concat(out);
}
