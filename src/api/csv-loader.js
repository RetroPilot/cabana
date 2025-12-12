export function parseCSVLog(csvText) {
  const lines = csvText.trim().split('\n').filter(l => l);
  if (lines.length < 2) {
    throw new Error('CSV file is empty');
  }

  const header = lines[0].split(',');
  if (header[0] !== 'time' || header[1] !== 'addr' || header[2] !== 'bus' || header[3] !== 'data') {
    throw new Error('Invalid CSV format');
  }

  const messages = {};
  let firstTime = null;

  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    if (parts.length !== 4) continue;

    const time = parseFloat(parts[0]);
    const address = parseInt(parts[1], 10);
    const bus = parseInt(parts[2]);
    const hexData = parts[3].trim();

    if (firstTime === null) {
      firstTime = time;
    }

    const data = hexToBytes(hexData);
    const messageId = `${bus}:${address}`;

    if (!messages[messageId]) {
      messages[messageId] = {
        id: messageId,
        address,
        bus,
        entries: [],
        byteStateChangeCounts: new Array(8).fill(0),
        byteColors: new Array(8).fill('rgba(0,0,0,0)'),
        frame: null
      };
    }

    const paddedHexData = hexData.padEnd(16, '0');
    const relTime = time - firstTime;
    
    // Calculate byte state changes
    const entryByteChangeCounts = new Array(8).fill(0);
    const lastEntry = messages[messageId].entries[messages[messageId].entries.length - 1];
    
    if (lastEntry) {
      for (let byteIdx = 0; byteIdx < Math.min(8, paddedHexData.length / 2); byteIdx++) {
        const currentByte = paddedHexData.substr(byteIdx * 2, 2);
        const lastByte = lastEntry.hexData.substr(byteIdx * 2, 2);
        if (currentByte !== lastByte) {
          entryByteChangeCounts[byteIdx] = 1;
          messages[messageId].byteStateChangeCounts[byteIdx]++;
        }
      }
    }

    messages[messageId].entries.push({
      time,
      relTime,
      address,
      bus,
      data: new Uint8Array(data),
      hexData: paddedHexData,
      signals: {},
      byteStateChangeCounts: entryByteChangeCounts
    });
  }

  // Calculate byte colors based on state change counts
  Object.values(messages).forEach(message => {
    const maxChanges = Math.max(...message.byteStateChangeCounts, 1);
    message.byteColors = message.byteStateChangeCounts.map(count => {
      const intensity = Math.min(255, 75 + 180 * (count / maxChanges));
      return `rgb(${Math.round(intensity)},0,0)`;
    });
  });

  const lastTime = lines.length > 1 ? parseFloat(lines[lines.length - 1].split(',')[0]) : firstTime;
  const duration = lastTime - firstTime;
  
  return {
    messages,
    firstCanTime: firstTime || 0,
    duration
  };
}

function hexToBytes(hex) {
  if (!hex) return [];
  const bytes = [];
  for (let i = 0; i < hex.length; i += 2) {
    bytes.push(parseInt(hex.substr(i, 2), 16));
  }
  return bytes;
}
