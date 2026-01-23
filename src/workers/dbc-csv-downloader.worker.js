/* eslint-env worker */
/* eslint-disable no-restricted-globals */
// import Sentry from '../logging/Sentry';

import NumpyLoader from '../utils/loadnpy';

const MAX_CONNECTIONS = 8;

const window = self;

const { Int64LE } = require('int64-buffer');

// Writes CSV lines for all messages, using epochStartTime when provided
// to emit absolute timestamps; falls back to relative/monotonic times.
function transformAndSend(rawData, canStartTime, epochStartTime) {
  let totalSize = 0;
  const maxTime = rawData.reduce((memo, sourceData) => {
    totalSize += sourceData.entries.length;
    sourceData.entries = sourceData.entries.sort((a, b) => {
      if (a.relTime > b.relTime) {
        return 1;
      }
      if (a.relTime < b.relTime) {
        return -1;
      }
      return 0;
    });
    return Math.max(memo, getLastTimeFromEntries(sourceData.entries));
  }, 0);

  const minTime = 0;
  console.log('Exporting from', minTime, 'to', maxTime, 'seconds');
  const curIndexes = {};
  rawData.forEach((sourceData) => {
    if (!sourceData.entries.length) {
      return;
    }
    const sourceId = sourceData.id;
    if (minTime === 0 || sourceData.entries[0].relTime > minTime) {
      curIndexes[sourceId] = 0;
      return;
    }
    curIndexes[sourceId] = findFirstEntryIndex(sourceData.entries, minTime);
  });

  let entryBuffer = [];
  let totalEntries = 0;

  while (!isAtEnd()) {
    const nextSource = rawData.reduce((memo, sourceData) => {
      const curEntry = sourceData.entries[curIndexes[sourceData.id]];
      if (!curEntry) {
        return memo;
      }
      if (memo === -1) {
        return {
          entry: curEntry,
          address: sourceData.address,
          bus: sourceData.bus,
          id: sourceData.id
        };
      }
      if (curEntry.relTime < memo.entry.relTime) {
        return {
          entry: curEntry,
          address: sourceData.address,
          bus: sourceData.bus,
          id: sourceData.id
        };
      }
      return memo;
    }, -1);
    if (nextSource === -1) {
      break;
    }
    curIndexes[nextSource.id]++;
    totalEntries++;

    entryBuffer.push(makeEntry(nextSource, canStartTime, epochStartTime));

    if (entryBuffer.length > 5000) {
      self.postMessage({
        progress: 100 * (totalEntries / totalSize),
        logData: entryBuffer.join('\n'),
        shouldClose: false
      });
      entryBuffer = [];
    }
  }
  if (entryBuffer.length > 0) {
    self.postMessage({
      progress: 99,
      logData: entryBuffer.join('\n'),
      shouldClose: false
    });
    entryBuffer = [];
  }

  console.log('Wrote', totalEntries, 'lines of CSV');
  self.postMessage({
    progress: 100,
    shouldClose: true
  });

  function isAtEnd() {
    return rawData.reduce(
      (memo, sourceData) => memo && curIndexes[sourceData.id] >= sourceData.entries.length
    );
  }
}

function makeEntry(nextSource, canStartTime, epochStartTime) {
  const hasStartTime = Number.isFinite(canStartTime);
  const hasEpochStart = Number.isFinite(epochStartTime);
  const startLooksEpoch = hasStartTime && canStartTime > 1e8;
  const relTime = Number.isFinite(nextSource.entry.relTime) ? nextSource.entry.relTime : 0;
  const timestamp = hasEpochStart
    ? epochStartTime + relTime
    : startLooksEpoch
      ? canStartTime + relTime
      : relTime;

  const addressHex = formatAddress(nextSource.address);
  const dataHex = (nextSource.entry.hexData || '').toUpperCase();
  const busLabel = `can${Number.isFinite(nextSource.bus) ? nextSource.bus : 0}`;

  return `(${timestamp.toFixed(6)}) ${busLabel} ${addressHex}#${dataHex}`;
}

function formatAddress(address) {
  const addr = Number.isFinite(address) ? address : 0;
  const isExtended = addr > 0x7ff;
  const width = isExtended ? 8 : 3;
  return addr.toString(16).toUpperCase().padStart(width, '0');
}

function findFirstEntryIndex(entries, minTime, start, length) {
  start = start || entries.length / 2;
  start = ~~start; // round down
  length = length || entries.length / 2;
  length = Math.round(length); // round up

  if (start === 0) {
    return 0;
  }
  if (start >= entries.length - 1) {
    return entries.length - 1;
  }

  if (entries[start].relTime < minTime) {
    // this entry is too early for the 30s window
    return findFirstEntryIndex(
      entries,
      minTime,
      ~~(start + length / 2),
      length / 2
    );
  }
  if (entries[start].relTime >= minTime) {
    // this entry is within the window! check if it's the first one in the window, else keep searching
    if (entries[start - 1].relTime >= minTime) {
      return findFirstEntryIndex(
        entries,
        minTime,
        ~~(start - length / 2),
        length / 2
      );
    }
    return start;
  }
}

function getLastTimeFromEntries(entries) {
  if (!entries.length) {
    return 0;
  }
  return entries[entries.length - 1].relTime;
}

self.onmessage = function (e) {
  console.log('onmessage worker');
  self.postMessage({
    progress: 0,
    shouldClose: false
  });
  const {
    base,
    parts,
    data,
    canStartTime,
    epochStartTime,
    prevMsgEntries,
    maxByteStateChangeCount
  } = e.data;

  // const dbc = new DBC(dbcText);
  // saveDBC(dbc, base, num, canStartTime);
  if (data) {
    // has raw data from live mode, process this instead
    console.log('Using raw data from memory', canStartTime, epochStartTime);
    transformAndSend(data, canStartTime, epochStartTime);
  } else {
    self.postMessage({
      progress: 100,
      shouldClose: true
    });
    self.close();
  }
};
