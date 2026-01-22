const SAVVYCAN_LINE_RE = /^\(?\s*([-+]?\d+(?:\.\d+)?)\s*\)?\s+([\w-]+)\s+([0-9A-Fa-f]+)#([0-9A-Fa-f]*)/;

export function parseCSVLog(csvText) {
  const lines = csvText
    .trim()
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l);

  if (!lines.length) {
    throw new Error('CSV file is empty');
  }

  const header = lines[0].replace(/"/g, '').toLowerCase();
  const hasLegacyHeader = header === 'time,addr,bus,data';
  const looksLikeSavvyCan = SAVVYCAN_LINE_RE.test(lines[0]);

  if (!hasLegacyHeader && !looksLikeSavvyCan) {
    throw new Error('Invalid CSV format: expected cabana CSV header or SavvyCAN candump lines');
  }

  const messages = {};
  let firstTime = null;
  let lastTime = null;

  const parser = hasLegacyHeader ? parseLegacyLine : parseSavvyCanLine;
  const startIndex = hasLegacyHeader ? 1 : 0;

  for (let i = startIndex; i < lines.length; i++) {
    const parsed = parser(lines[i]);
    if (!parsed) {
      throw new Error(`Invalid CSV format on line ${i + 1}`);
    }

    const {
      time, address, bus, hexData
    } = parsed;

    if (firstTime === null) {
      firstTime = time;
    }
    lastTime = time;

    const relTime = time - firstTime;
    const messageId = `${bus}:${address}`;
    const entrySize = Math.max(8, Math.ceil(hexData.length / 2));

    if (!messages[messageId]) {
      messages[messageId] = {
        id: messageId,
        address,
        bus,
        entries: [],
        byteStateChangeCounts: new Array(entrySize).fill(0),
        byteColors: new Array(entrySize).fill('rgba(0,0,0,0)'),
        frame: null
      };
    } else if (messages[messageId].byteStateChangeCounts.length < entrySize) {
      const extra = entrySize - messages[messageId].byteStateChangeCounts.length;
      messages[messageId].byteStateChangeCounts =
        messages[messageId].byteStateChangeCounts.concat(new Array(extra).fill(0));
      messages[messageId].byteColors =
        messages[messageId].byteColors.concat(new Array(extra).fill('rgba(0,0,0,0)'));
    }

    const messageSize = messages[messageId].byteStateChangeCounts.length;
    const paddedHexData = hexData.padEnd(messageSize * 2, '0');

    const entryByteChangeCounts = new Array(messageSize).fill(0);
    const lastEntry = messages[messageId].entries[messages[messageId].entries.length - 1];

    if (lastEntry) {
      const lastPaddedHex = lastEntry.hexData.padEnd(messageSize * 2, '0');
      for (let byteIdx = 0; byteIdx < messageSize; byteIdx++) {
        const offset = byteIdx * 2;
        const currentByte = paddedHexData.substr(offset, 2);
        const lastByte = lastPaddedHex.substr(offset, 2);
        if (currentByte !== lastByte) {
          entryByteChangeCounts[byteIdx] = 1;
          messages[messageId].byteStateChangeCounts[byteIdx]++;
        }
      }
    }

    const j1939 = parseJ1939Meta(address);

    messages[messageId].entries.push({
      time,
      relTime,
      address,
      bus,
      data: new Uint8Array(hexToBytes(hexData)),
      hexData,
      signals: {},
      byteStateChangeCounts: entryByteChangeCounts,
      j1939
    });
  }

  if (firstTime === null) {
    throw new Error('No log entries found in CSV');
  }

  Object.values(messages).forEach((message) => {
    const maxChanges = Math.max(...message.byteStateChangeCounts, 1);
    message.byteColors = message.byteStateChangeCounts.map((count) => {
      const intensity = Math.min(255, 75 + 180 * (count / maxChanges));
      return `rgb(${Math.round(intensity)},0,0)`;
    });
  });

  const duration = lastTime !== null ? lastTime - firstTime : 0;

  return {
    messages,
    firstCanTime: firstTime,
    duration
  };
}

function parseJ1939Meta(address) {
  if (!Number.isInteger(address) || address <= 0x7FF || address > 0x1FFFFFFF) {
    return null;
  }

  const priority = (address >> 26) & 0x7;
  const dp = (address >> 24) & 0x1;
  const pf = (address >> 16) & 0xFF;
  const ps = (address >> 8) & 0xFF;
  const sa = address & 0xFF;

  let pgn = (address >> 8) & 0x3FFFF; // includes DP
  if (pf < 0xF0) {
    // PDU1: PS is destination, zero out for PGN
    pgn &= 0x3FF00;
  }

  return {
    priority,
    dp,
    pf,
    ps,
    sa,
    pgn
  };
}

function parseLegacyLine(line) {
  const parts = line.split(',');
  if (parts.length !== 4) return null;

  const time = parseFloat(parts[0]);
  const address = parseAddress(parts[1]);
  const bus = parseInt(parts[2], 10);
  const hexData = normalizeHexData(parts[3]);

  if ([time, address, bus].some((v) => Number.isNaN(v))) {
    return null;
  }

  return {
    time,
    address,
    bus,
    hexData
  };
}

function parseSavvyCanLine(line) {
  const match = SAVVYCAN_LINE_RE.exec(line);
  if (!match) {
    return null;
  }

  const time = parseFloat(match[1]);
  const bus = parseBus(match[2]);
  const address = parseAddress(match[3], 16);
  const hexData = normalizeHexData(match[4]);

  if ([time, address, bus].some((v) => Number.isNaN(v))) {
    return null;
  }

  return {
    time,
    address,
    bus,
    hexData
  };
}

function parseAddress(addressStr, baseHint) {
  if (!addressStr) {
    return NaN;
  }
  const trimmed = addressStr.trim();
  const isHex = baseHint === 16 || trimmed.startsWith('0x') || /[a-f]/i.test(trimmed);
  return parseInt(trimmed, isHex ? 16 : 10);
}

function parseBus(busStr) {
  if (busStr === null || busStr === undefined) {
    return NaN;
  }
  const match = `${busStr}`.match(/(\d+)$/);
  if (match) {
    return parseInt(match[1], 10);
  }
  const busNum = parseInt(busStr, 10);
  return Number.isNaN(busNum) ? NaN : busNum;
}

function normalizeHexData(hex) {
  const normalized = (hex || '').replace(/\s+/g, '').toUpperCase();
  if (!normalized) {
    return normalized;
  }
  return normalized.length % 2 === 1 ? `0${normalized}` : normalized;
}

function hexToBytes(hex) {
  const cleanHex = normalizeHexData(hex);
  if (!cleanHex) return [];
  const bytes = [];
  for (let i = 0; i < cleanHex.length; i += 2) {
    bytes.push(parseInt(cleanHex.substr(i, 2), 16));
  }
  return bytes;
}
