import React, { Component } from 'react';
import Moment from 'moment';
import PropTypes from 'prop-types';
import cx from 'classnames';
import streamSaver from 'streamsaver';
import Panda from '@commaai/pandajs';
import CommaAuth, { storage as CommaAuthStorage, config as AuthConfig } from '@commaai/my-comma-auth';
import { raw as RawDataApi, drives as DrivesApi } from '@commaai/comma-api';
import { timeout, interval } from 'thyming';
import {
  USE_UNLOGGER,
  PART_SEGMENT_LENGTH,
  STREAMING_WINDOW,
  GITHUB_AUTH_TOKEN_KEY
} from './config';
import * as GithubAuth from './api/github-auth';

import DBC from './models/can/dbc';
import Frame from './models/can/frame';
import Meta from './components/Meta';
import Explorer from './components/Explorer';
import OnboardingModal from './components/Modals/OnboardingModal';
import SaveDbcModal from './components/SaveDbcModal';
import LoadDbcModal from './components/LoadDbcModal';
import debounce from './utils/debounce';
import EditMessageModal from './components/EditMessageModal';
import {
  persistDbc,
  fetchPersistedDbc,
  unpersistGithubAuthToken
} from './api/localstorage';
import OpenDbc from './api/OpenDbc';
import UnloggerClient from './api/unlogger';
import { parseCSVLog } from './api/csv-loader';
import { parseGpxTrack } from './api/gpx-loader';
import Signal from './models/can/signal';
import j1939Baseline from './j1939_baseline.json';
import { hash } from './utils/string';
import { modifyQueryParameters } from './utils/url';
import DbcUtils from './utils/dbc';

const NEW_DBC = 'New_DBC';

const RLogDownloader = require('./workers/rlog-downloader.worker');
const LogCSVDownloader = require('./workers/dbc-csv-downloader.worker');
const MessageParser = require('./workers/message-parser.worker');
const CanStreamerWorker = require('./workers/CanStreamerWorker.worker');

streamSaver.mitm = `${window.location.origin}/mitm.html`;

const dataCache = {};


export default class CanExplorer extends Component {
  constructor(props) {
    super(props);
    this.state = {
      messages: {},
      thumbnails: [],
      selectedMessages: [],
      route: null,
      canFrameOffset: 0,
      routeInitTime: 0,
      firstFrameTime: 0,
      carFingerprint: null,
      firstCanTime: null,
      lastBusTime: null,
      selectedMessage: null,
      currentParts: [0, 0],
      currentPart: 0,
      currentWorkers: {},
      loadingParts: [],
      loadedParts: [],
      showOnboarding: false,
      showLoadDbc: false,
      showSaveDbc: false,
      showEditMessageModal: false,
      editMessageModalMessage: null,
      dbc: props.dbc ? props.dbc : new DBC(),
      dbcText: props.dbc ? props.dbc.text() : new DBC().text(),
      dbcFilename: props.dbcFilename ? props.dbcFilename : NEW_DBC,
      dbcLastSaved: null,
      seekTime: props.seekTime || 0,
      seekIndex: 0,
      maxByteStateChangeCount: 0,
      partsLoaded: 0,
      spawnWorkerHash: null,
      attemptingPandaConnection: false,
      pandaNoDeviceSelected: false,
      live: false,
      isGithubAuthenticated:
        props.githubAuthToken !== null && props.githubAuthToken !== undefined,
      shareUrl: null,
      logUrls: null,
      share: null,
      j1939Enabled: false,
      gpsTrack: null,
      gpsOffsetSec: 0,
    };

    this.openDbcClient = new OpenDbc(props.githubAuthToken);
    if (USE_UNLOGGER) {
      this.unloggerClient = new UnloggerClient();
    }

    this.showOnboarding = this.showOnboarding.bind(this);
    this.hideOnboarding = this.hideOnboarding.bind(this);
    this.showLoadDbc = this.showLoadDbc.bind(this);
    this.hideLoadDbc = this.hideLoadDbc.bind(this);
    this.showSaveDbc = this.showSaveDbc.bind(this);
    this.hideSaveDbc = this.hideSaveDbc.bind(this);
    this.showEditMessageModal = this.showEditMessageModal.bind(this);
    this.hideEditMessageModal = this.hideEditMessageModal.bind(this);
    this.onDbcSelected = this.onDbcSelected.bind(this);
    this.onDbcSaved = this.onDbcSaved.bind(this);
    this.onConfirmedSignalChange = this.onConfirmedSignalChange.bind(this);
    this.onPartChange = this.onPartChange.bind(this);
    this.onMessageFrameEdited = this.onMessageFrameEdited.bind(this);
    this.onSeek = this.onSeek.bind(this);
    this.onUserSeek = this.onUserSeek.bind(this);
    this.onMessageSelected = this.onMessageSelected.bind(this);
    this.onMessageUnselected = this.onMessageUnselected.bind(this);
    this.initCanData = this.initCanData.bind(this);
    this.updateSelectedMessages = this.updateSelectedMessages.bind(this);
    this.handlePandaConnect = this.handlePandaConnect.bind(this);
    this.processStreamedCanMessages = this.processStreamedCanMessages.bind(
      this
    );
    this.onStreamedCanMessagesProcessed = this.onStreamedCanMessagesProcessed.bind(
      this
    );
    this.getLiveEpochOffset = this.getLiveEpochOffset.bind(this);
    this.showingModal = this.showingModal.bind(this);
    this.lastMessageEntriesById = this.lastMessageEntriesById.bind(this);
    this.githubSignOut = this.githubSignOut.bind(this);
    this.downloadLogAsCSV = this.downloadLogAsCSV.bind(this);
    this.handleCsvUpload = this.handleCsvUpload.bind(this);
    this.handleGpsUpload = this.handleGpsUpload.bind(this);
    this.clearGpsTrack = this.clearGpsTrack.bind(this);
    this.setGpsOffsetSec = this.setGpsOffsetSec.bind(this);
    this.onDbcFilenameChange = this.onDbcFilenameChange.bind(this);
    this.unloadDbc = this.unloadDbc.bind(this);
    this.applyJ1939Baseline = this.applyJ1939Baseline.bind(this);
    this.buildJ1939FrameFromBaseline = this.buildJ1939FrameFromBaseline.bind(this);
    this.mergeJ1939BaselineIntoDbc = this.mergeJ1939BaselineIntoDbc.bind(this);
    this.stripBaselineFromDbc = this.stripBaselineFromDbc.bind(this);
    this.reparseMessagesWithDbc = this.reparseMessagesWithDbc.bind(this);
    this.toggleJ1939Enabled = this.toggleJ1939Enabled.bind(this);


    this.pandaReader = new Panda();
    this.pandaReader.onMessage(this.processStreamedCanMessages);
  }

  getLiveEpochOffset() {
    if (this.liveEpochOffset !== undefined && this.liveEpochOffset !== null) {
      return this.liveEpochOffset;
    }
    if (window && window.performance && typeof window.performance.now === 'function') {
      this.liveEpochOffset = (Date.now() / 1000) - (window.performance.now() / 1000);
      return this.liveEpochOffset;
    }
    this.liveEpochOffset = 0;
    return this.liveEpochOffset;
  }

  componentDidMount() {
    this.dataCacheTimer = interval(() => {
      const { currentParts } = this.state;
      let { loadedParts } = this.state;
      if (this.loadMessagesFromCacheRunning || loadedParts.length < 4) {
        return;
      }
      loadedParts.forEach((part) => {
        if (part >= currentParts[0] && part <= currentParts[1]) {
          return;
        }
        if (Date.now() - dataCache[part].lastUsed > 3 * 60 * 1000) {
          console.log('Decaching part', part);
          loadedParts = loadedParts.filter((p) => p !== part);
          this.setState({
            loadedParts
          }, () => { delete dataCache[part]; });
        }
      });
    }, 10000);

    const { dongleId, name } = this.props;
    if (CommaAuth.isAuthenticated() && !name) {
      this.showOnboarding();
    } else if (
      this.props.max
      && this.props.url
      && !this.props.exp
      && !this.props.sig
    ) {
      // legacy share? maybe dead code
      const { max, url } = this.props;
      const startTime = Moment(name, 'YYYY-MM-DD--H-m-s');

      const route = {
        fullname: `${dongleId}|${name}`,
        proclog: max,
        url,
        start_time: startTime
      };
      this.setState(
        {
          route,
          currentParts: [0, Math.min(max, PART_SEGMENT_LENGTH - 1)]
        },
        this.initCanData
      );
    } else if (dongleId && name) {
      const routeName = `${dongleId}|${name}`;
      let routePromise;
      let logUrlsPromise;

      if (this.props.url) {
        routePromise = Promise.resolve({
          maxqcamera: null,
          url: this.props.url,
        });
      } else {
        routePromise = DrivesApi.getRouteInfo(routeName);
      }

      if (this.props.sig && this.props.exp) {
        logUrlsPromise = RawDataApi.getRouteFiles(routeName, false, {
          sig: this.props.sig,
          exp: this.props.exp
        });
      } else {
        logUrlsPromise = RawDataApi.getRouteFiles(routeName);
      }
      Promise.all([routePromise, logUrlsPromise])
        .then((initData) => {
          const [route, logFiles] = initData;
          const logUrls = logFiles['logs'];
          const newState = {
            route: {
              fullname: routeName,
              proclog: logUrls.length - 1,
              start_time: Moment(name, 'YYYY-MM-DD--H-m-s'),
              url: route.url.replace('chffrprivate.blob.core.windows.net', 'chffrprivate.azureedge.net'),
              maxqcamera: route.maxqcamera ? route.maxqcamera : logUrls.length - 1,
            },
            currentParts: [
              0,
              Math.min(logUrls.length - 1, PART_SEGMENT_LENGTH - 1)
            ],
            logUrls
          };
          this.setState(newState, this.initCanData);

          if (!this.props.sig || !this.props.exp) {
            DrivesApi.getShareSignature(routeName).then((shareSignature) => this.setState({
              share: {
                exp: shareSignature.exp,
                sig: shareSignature.sig,
              },
              shareUrl: modifyQueryParameters({
                add: {
                  exp: shareSignature.exp,
                  sig: shareSignature.sig,
                  max: logUrls.length - 1,
                  url: route.url.replace('chffrprivate.blob.core.windows.net', 'chffrprivate.azureedge.net'),
                },
                remove: [GITHUB_AUTH_TOKEN_KEY]
              })
            }));
          } else {
            this.setState({
              share: {
                exp: this.props.exp,
                sig: this.props.sig,
              },
            });
          }
        })
        .catch((err) => {
          console.log(err);
          CommaAuthStorage.logOut().then(() => {
            CommaAuthStorage.isAuthed = false;
            this.showOnboarding();
          });
        });
    } else {
      this.showOnboarding();
    }
  }

  componentWillUnmount() {
    if (this.dataCacheTimer) {
      this.dataCacheTimer();
    }
  }

  initCanData() {
    this.spawnWorker(this.state.currentParts);
  }

  onDbcSelected(dbcFilename, dbc) {
    const { route, csvPlayback, messages, firstCanTime, j1939Enabled } = this.state;
    this.hideLoadDbc();
    dbc.lastUpdated = Date.now();
    this.persistDbc({ dbcFilename, dbc });

    if (route) {
      this.setState(
        {
          dbc,
          dbcFilename,
          dbcText: dbc.text(),
          partsLoaded: 0,
          selectedMessage: null,
          messages: {}
        },
        () => {
          this.loadMessagesFromCache();
        }
      );
    } else if (csvPlayback) {
      if (j1939Enabled) {
        dbc = this.mergeJ1939BaselineIntoDbc(dbc, messages);
      }

      // Re-parse CSV messages with new DBC
      const updatedMessages = { ...messages };
      Object.keys(updatedMessages).forEach((key) => {
        const msg = { ...updatedMessages[key] };
        msg.frame = dbc.getMessageFrame(msg.address);
        if (!msg.frame) {
          // attempt to build from baseline if available
          const firstJ = j1939Enabled && msg.entries && msg.entries.find((e) => e.j1939 && (j1939Baseline || {})[e.j1939.pgn]);
          if (firstJ && j1939Enabled) {
            const def = (j1939Baseline || {})[firstJ.j1939.pgn];
            msg.frame = this.buildJ1939FrameFromBaseline(firstJ.j1939.pgn, def, msg.address);
            dbc.messages.set(msg.address, msg.frame);
          }
        }
        msg.entries = [...msg.entries];
        let prevEntry = null;
        const byteStateChangeCounts = [];
        msg.entries = msg.entries.map((entry) => {
          const parsed = DbcUtils.parseMessage(
            dbc,
            entry.time,
            msg.address,
            entry.data,
            firstCanTime,
            prevEntry
          );
          prevEntry = parsed.msgEntry;
          byteStateChangeCounts.push(parsed.byteStateChangeCounts);
          return {
            ...entry,
            signals: parsed.msgEntry.signals,
            byteStateChangeCounts: parsed.byteStateChangeCounts
          };
        });
        msg.byteStateChangeCounts = byteStateChangeCounts.reduce((memo, val) => {
          if (!memo) return val;
          return memo.map((count, idx) => val[idx] + count);
        }, null);
        updatedMessages[key] = msg;
      });
      
      const maxByteStateChangeCount = DbcUtils.findMaxByteStateChangeCount(updatedMessages);
      Object.keys(updatedMessages).forEach((key) => {
        updatedMessages[key] = DbcUtils.setMessageByteColors(
          updatedMessages[key],
          maxByteStateChangeCount
        );
      });
      
      this.setState({
        dbc,
        dbcFilename,
        dbcText: dbc.text(),
        messages: updatedMessages,
        maxByteStateChangeCount
      });
    } else {
      this.setState({
        dbc,
        dbcFilename,
        dbcText: dbc.text(),
        messages: {}
      });
    }
  }

  onDbcSaved(dbcFilename) {
    const dbcLastSaved = Moment();
    this.setState({ dbcLastSaved, dbcFilename });
    this.hideSaveDbc();
  }

  // async downloadDbcFile() {
  //   const blob = new Blob([this.props.dbc.text()], {type: "text/plain;charset=utf-8"});
  //   const filename = this.state.dbcFilename.replace(/\.dbc/g, '') + '.dbc';
  //   FileSaver.saveAs(blob, filename, true);
  // }

  downloadLogAsCSV() {
    console.log('downloadLogAsCSV:start');
    const { dbcFilename } = this.state;
    const csvData = [];

    function dataHandler(e) {
      const { logData, shouldClose, progress } = e.data;
      if (shouldClose) {
        console.log('downloadLogAsCSV:close');
        const blob = new Blob([csvData.join('\n')], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${dbcFilename.replace(/\.dbc/g, '-')}${+new Date()}.csv`;
        a.click();
        URL.revokeObjectURL(url);
        return;
      }
      console.log('CSV export progress:', progress);
      if (logData) {
        csvData.push(logData);
      }
    }

    if (this.state.live) {
      return this.downloadLiveLogAsCSV(dataHandler);
    }
    return this.downloadRawLogAsCSV(dataHandler);
  }

  downloadRawLogAsCSV(handler) {
    return this.downloadLiveLogAsCSV(handler);
  }

  downloadLiveLogAsCSV(handler) {
    // Trigger processing of in-memory data in worker
    // this method *could* just fetch the data needed for the worked, but
    // eventually this might be in it's own worker instead of the shared one
    const {
      firstCanTime,
      canFrameOffset,
      route,
      csvPlayback,
      routeInitTime,
    } = this.state;
    const worker = new LogCSVDownloader();

    worker.onmessage = handler;

    // Derive an epoch anchor if possible.
    // Preference order:
    // 1) route.start_time (from server) for route playback
    // 2) firstCanTime if it already looks like epoch seconds
    // 3) host clock aligned to current firstCanTime (live panda best-effort)
    // 4) as a last resort, align relative CSV times to current wall clock so the
    //    exported file still has epoch-ish timestamps.
    let epochStartTime = null;
    const looksLikeEpoch = (t) => Number.isFinite(t) && t > 1e8; // ~2003+

    if (route && route.start_time && Number.isFinite(firstCanTime) && Number.isFinite(routeInitTime)) {
      // Align epoch to the first CAN message using monotonic route init time
      epochStartTime = (route.start_time.valueOf() / 1000) + (firstCanTime - routeInitTime);
    } else if (route && route.start_time) {
      epochStartTime = route.start_time.valueOf() / 1000;
    } else if (csvPlayback && Number.isFinite(firstCanTime)) {
      epochStartTime = looksLikeEpoch(firstCanTime)
        ? firstCanTime
        : (Date.now() / 1000) - firstCanTime;
    } else if (Number.isFinite(firstCanTime)) {
      // attempt a live alignment using current wall clock
      epochStartTime = (Date.now() / 1000) - firstCanTime;
      // If routeInitTime is available, prefer it for stability
      if (Number.isFinite(routeInitTime)) {
        epochStartTime = (Date.now() / 1000) - (firstCanTime - routeInitTime);
      }
    }
    
    // Use full message history if available (live streaming), otherwise use current messages
    const messagesToExport = this.fullMessageHistory || this.state.messages;

    worker.postMessage({
      data: Object.keys(messagesToExport).map((sourceId) => {
        const source = messagesToExport[sourceId];
        return {
          id: source.id,
          bus: source.bus,
          address: source.address,
          entries: source.entries.slice()
        };
      }),
      canStartTime: Number.isFinite(firstCanTime) ? firstCanTime - canFrameOffset : null,
      epochStartTime
    });
  }

  mergeThumbnails(newThumbnails) {
    const { thumbnails } = this.state;
    if (!newThumbnails || !newThumbnails.length) {
      return thumbnails;
    }
    if (!thumbnails.length) {
      return newThumbnails;
    }

    let oldIndex = 0;
    let newIndex = 0;

    // is old immediately after new?
    if (newThumbnails[0].monoTime > thumbnails[thumbnails.length - 1]) {
      return thumbnails.concat(newThumbnails);
    }
    // is new immediately after old?
    if (newThumbnails[newThumbnails.length - 1] < thumbnails[0]) {
      return newThumbnails.concat(thumbnails);
    }
    let result = [];
    while (oldIndex < thumbnails.length && newIndex < newThumbnails.length) {
      if (thumbnails[oldIndex].monoTime < newThumbnails[newIndex].monoTime) {
        result.push(thumbnails[oldIndex]);
        oldIndex += 1;
      } else {
        result.push(newThumbnails[newIndex]);
        newIndex += 1;
      }
    }
    if (oldIndex < thumbnails.length) {
      result = result.concat(thumbnails.slice(oldIndex));
    } else if (newIndex < newThumbnails.length) {
      result = result.concat(newThumbnails.slice(newIndex));
    }

    return result;
  }

  cancelWorker(workerHash) {
    // actually don't...
    return;
  }

  spawnWorker(options) {
    let { currentParts, currentWorkers, loadingParts } = this.state;
    console.log('Checking worker for', currentParts);
    if (loadingParts.length > 1) {
      // only 2 workers at a time pls
      return;
    }
    const [minPart, maxPart] = currentParts;

    // updated worker list (post canceling, and this time a copy)
    currentWorkers = { ...this.state.currentWorkers };

    const { loadedParts, currentPart } = this.state;

    let part = -1;
    const allWorkerParts = loadingParts.concat(loadedParts);

    for (let partOffset = 0; partOffset <= maxPart - minPart; ++partOffset) {
      let tempPart = currentPart + partOffset;
      if (tempPart > maxPart) {
        tempPart = minPart + ((tempPart - minPart) % (maxPart - minPart + 1));
      }
      if (allWorkerParts.indexOf(tempPart) === -1) {
        part = tempPart;
        break;
      }
    }
    if (part === -1) {
      return;
    }

    console.log('Starting worker for part', part);
    // options is object of {part, prevMsgEntries, spawnWorkerHash, prepend}
    options = options || {};
    let { prevMsgEntries } = options;
    const prepend = false;

    const {
      dbc,
      route,
      firstCanTime,
      canFrameOffset
    } = this.state;
    let { maxByteStateChangeCount } = this.state;

    if (!prevMsgEntries) {
      // we have previous messages loaded
      const { messages } = this.state;
      prevMsgEntries = {};
      Object.keys(messages).forEach((key) => {
        const { entries } = messages[key];
        prevMsgEntries[key] = entries[entries.length - 1];
      });
    }

    // var worker = new CanFetcher();
    const worker = new RLogDownloader();

    const spawnWorkerHash = hash(Math.random().toString(16));
    currentWorkers[spawnWorkerHash] = {
      part,
      worker
    };

    loadingParts = [part, ...loadingParts];

    this.setState({
      currentWorkers,
      loadingParts
    });

    worker.onmessage = (e) => {
      if (this.state.currentWorkers[spawnWorkerHash] === undefined) {
        console.log('Worker was canceled');
        return;
      }

      maxByteStateChangeCount = e.data.maxByteStateChangeCount;
      const {
        newMessages,
        newThumbnails,
        isFinished,
        routeInitTime,
        firstFrameTime,
        carParams,
      } = e.data;
      if (maxByteStateChangeCount > this.state.maxByteStateChangeCount) {
        this.setState({ maxByteStateChangeCount });
      } else {
        maxByteStateChangeCount = this.state.maxByteStateChangeCount;
      }
      if (routeInitTime !== this.state.routeInitTime) {
        this.setState({ routeInitTime });
      }
      if (firstFrameTime && firstFrameTime !== this.state.firstFrameTime) {
        this.setState({ firstFrameTime });
      }
      if (carParams && carParams.CarFingerprint !== this.state.carFingerprint) {
        this.setState({ carFingerprint: carParams.CarFingerprint });

        if (this.state.dbcFilename === NEW_DBC) {
          const dbcFilename = DbcUtils.findDbcForCar(carParams.CarFingerprint);
          if (dbcFilename) {
            this.openDbcClient.getDbcContents(dbcFilename + '.dbc', 'commaai/opendbc').then((dbcText) => {
              this.onDbcSelected(dbcFilename, new DBC(dbcText));
            });
          }
        }
      }

      if (newMessages) {
        this.addMessagesToDataCache(part, newMessages, newThumbnails);
      }

      // const messages = this.addAndRehydrateMessages(
      //   newMessages,
      //   maxByteStateChangeCount
      // );
      // const prevMsgEntries = {};
      // Object.keys(newMessages).forEach((key) => {
      //   prevMsgEntries[key] = newMessages[key].entries[newMessages[key].entries.length - 1];
      // });

      // const thumbnails = this.mergeThumbnails(newThumbnails);

      if (isFinished) {
        const loadingParts = this.state.loadingParts.filter((p) => p !== part);
        const loadedParts = [part, ...this.state.loadedParts];

        this.setState(
          {
            partsLoaded: this.state.partsLoaded + 1,
            loadingParts,
            loadedParts
          },
          () => {
            this.spawnWorker({
              prevMsgEntries,
              spawnWorkerHash,
              prepend
            });
            if (window.dataCallback) {
              window.dataCallback();
              window.dataCallback = null;
            }
          }
        );
      }
    };

    worker.postMessage({
      // old stuff for reverse compatibility for easier testing
      base: route.url,
      num: part,

      // so that we don't try to read metadata about it...
      isLegacyShare: this.props.isLegacyShare,
      logUrls: this.state.logUrls,

      // data that is used
      dbcText: dbc.text(),
      route: route.fullname,
      part,
      canStartTime: firstCanTime != null ? firstCanTime - canFrameOffset : null,
      prevMsgEntries,
      maxByteStateChangeCount
    });
  }

  addAndRehydrateMessages(newMessages, options) {
    // Adds new message entries to messages state
    // and "rehydrates" ES6 classes (message frame)
    // lost from JSON serialization in webworker data cloning.
    // handles merging the data in correct order
    options = options || {};

    const messages = { ...this.state.messages };

    Object.keys(newMessages).forEach((key) => {
      // add message
      if (options.replace !== true && key in messages) {
        // should merge here instead of concat
        // assumes messages are always sequential
        const msgEntries = messages[key].entries;
        const newMsgEntries = newMessages[key].entries;
        const msgLength = msgEntries.length;
        const newMsgLength = newMsgEntries.length;
        const entryLength = msgLength + newMsgLength;
        messages[key] = {
          ...messages[key],
          entries: Array(entryLength)
        };

        let msgIndex = 0;
        let newMsgIndex = 0;

        for (let i = 0; i < entryLength; ++i) {
          if (newMsgIndex >= newMsgLength) {
            messages[key].entries[i] = msgEntries[msgIndex++];
          } else if (msgIndex >= msgLength) {
            messages[key].entries[i] = newMsgEntries[newMsgIndex++];
          } else if (
            msgEntries[msgIndex].relTime <= newMsgEntries[newMsgIndex].relTime
          ) {
            messages[key].entries[i] = msgEntries[msgIndex++];
          } else if (
            msgEntries[msgIndex].relTime >= newMsgEntries[newMsgIndex].relTime
          ) {
            messages[key].entries[i] = newMsgEntries[newMsgIndex++];
          }
        }
        messages[key].byteStateChangeCounts = newMessages[key].byteStateChangeCounts;
      } else {
        messages[key] = newMessages[key];
        messages[key].frame = this.state.dbc.getMessageFrame(
          messages[key].address
        );
      }
    });

    const maxByteStateChangeCount = DbcUtils.findMaxByteStateChangeCount(
      messages
    );
    this.setState({
      maxByteStateChangeCount
    });

    Object.keys(messages).forEach((key) => {
      // console.log(key);
      messages[key] = DbcUtils.setMessageByteColors(
        messages[key],
        maxByteStateChangeCount
      );
    });

    return messages;
  }

  async addMessagesToDataCache(part, newMessages, newThumbnails) {
    const { dbc, currentParts } = this.state;
    const entry = await this.getParseSegment(part);
    if (!entry) {
      // first chunk of data returned from this segment
      Object.keys(newMessages).forEach((key) => {
        newMessages[key] = this.parseMessageEntry(newMessages[key], dbc);
      });
      dataCache[part] = {
        messages: newMessages,
        thumbnails: newThumbnails,
        lastUpdated: Date.now(),
        lastUsed: Date.now()
      };
      if (part >= currentParts[0] && part <= currentParts[1]) {
        this.setState({
          messages: this.addAndRehydrateMessages(newMessages)
        });
      }
      return;
    }

    entry.lastUsed = Date.now();

    // data is always append only, and always per segment
    Object.keys(newMessages).forEach((key) => {
      let msgs = newMessages[key];
      if (!dataCache[part].messages[key]) {
        msgs = this.parseMessageEntry(msgs, dbc);
        dataCache[part].messages[key] = msgs;
      } else {
        let { entries } = dataCache[part].messages[key];
        const lastEntry = entries.length ? entries[entries.length - 1] : null;
        msgs = this.parseMessageEntry(msgs, dbc, lastEntry);
        entries = entries.concat(msgs.entries);
        dataCache[part].messages[key].entries = entries;
      }
      newMessages[key] = msgs;
    });
    dataCache[part].thumbnails = dataCache[part].thumbnails.concat(newThumbnails);

    if (part >= currentParts[0] && part <= currentParts[1]) {
      this.setState({
        messages: this.addAndRehydrateMessages(newMessages)
      });
    }
  }

  async loadMessagesFromCache() {
    // create a new messages object for state
    if (this.loadMessagesFromCacheRunning) {
      if (!this.loadMessagesFromCacheTimer) {
        this.loadMessagesFromCacheTimer = timeout(() => this.loadMessagesFromCache(), 10);
      }
      return;
    }
    this.loadMessagesFromCacheRunning = true;
    if (this.loadMessagesFromCacheTimer) {
      this.loadMessagesFromCacheTimer();
      this.loadMessagesFromCacheTimer = null;
    }
    const { currentParts, dbc } = this.state;
    const { lastUpdated } = dbc;
    const [minPart, maxPart] = currentParts;
    const messages = {};
    let thumbnails = [];
    let isCanceled = false;

    let start = performance.now();

    const promises = [];

    for (let i = minPart, l = maxPart; i <= l; ++i) {
      promises.push(this.getParseSegment(i));
    }
    await promises.reduce(async (prev, p) => {
      await prev;
      if (isCanceled) {
        return;
      }
      const cacheEntry = await p;
      if (this.state.dbc.lastUpdated !== lastUpdated) {
        if (!isCanceled) {
          isCanceled = true;
          this.loadMessagesFromCacheRunning = false;
          console.log('Canceling!');
          this.loadMessagesFromCache();
        }
        return;
      }
      if (cacheEntry) {
        const newMessages = cacheEntry.messages;
        thumbnails = thumbnails.concat(cacheEntry.thumbnails);
        Object.keys(newMessages).forEach((key) => {
          if (!messages[key]) {
            messages[key] = { ...newMessages[key] };
          } else {
            const newMessageEntries = newMessages[key].entries;
            const messageEntries = messages[key].entries;
            if (newMessageEntries.length
              && newMessageEntries[0].relTime < messageEntries[messageEntries.length - 1].relTime) {
              console.error('Found out of order messages', newMessageEntries[0], messageEntries[messageEntries.length - 1]);
            }
            messages[key].entries = messages[key].entries.concat(newMessages[key].entries);
          }
        });
      }
      console.log('Done with', performance.now() - start);
      start = performance.now();
    }, Promise.resolve());

    if (isCanceled) {
      return;
    }

    Object.keys(this.state.messages).forEach((key) => {
      if (!messages[key]) {
        messages[key] = this.state.messages[key];
        messages[key].entries = [];
      }
    });

    Object.keys(messages).forEach((key) => {
      messages[key].frame = dbc.getMessageFrame(
        messages[key].address
      );
    });

    const maxByteStateChangeCount = DbcUtils.findMaxByteStateChangeCount(
      messages
    );

    this.setState({
      maxByteStateChangeCount
    });

    Object.keys(messages).forEach((key) => {
      // console.log(key);
      messages[key] = DbcUtils.setMessageByteColors(
        messages[key],
        maxByteStateChangeCount
      );
    });

    console.log('Done with old messages', performance.now() - start);

    this.setState({ messages, thumbnails });

    this.loadMessagesFromCacheRunning = false;
  }

  async getParseSegment(part) {
    if (!dataCache[part]) {
      return null;
    }
    if (dataCache[part].promise) {
      await dataCache[part].promise;
    }
    dataCache[part].promise = this.getParseSegmentInternal(part);

    return dataCache[part].promise;
  }

  async getParseSegmentInternal(part) {
    const start = performance.now();
    const { dbc } = this.state;
    if (!dbc.lastUpdated) {
      dbc.lastUpdated = Date.now();
    }
    const { lastUpdated } = dbc;
    let { messages } = dataCache[part];

    let reparseMessages = {};

    // if (lastUpdated > dataCache[part].lastUpdated) {
    //   dataCache[part].lastUpdated = Date.now();
    //   return await this.reparseMessages(messages);
    // }

    Object.keys(messages).forEach((key) => {
      if (messages[key].lastUpdated >= lastUpdated) {
        return;
      }
      reparseMessages[key] = messages[key];
    });

    if (Object.keys(reparseMessages).length) {
      console.log('Reparsing messages!', Object.keys(reparseMessages).length);
      reparseMessages = await this.reparseMessages(reparseMessages);
    }

    messages = {
      ...messages,
      ...reparseMessages
    };

    dataCache[part].messages = messages;

    const end = performance.now();
    if (end - start > 200) {
      // warn about anything over 200ms
      console.warn('getParseSegment took', part, end - start, Object.keys(messages).length);
    }

    return dataCache[part];
  }

  decacheMessageId(messageId) {
    Object.keys(dataCache).forEach((part) => {
      if (dataCache[part].messages[messageId]) {
        dataCache[part].messages[messageId].lastUpdated = 0;
      }
    });
  }

  async reparseMessages(_messages) {
    const messages = _messages;
    const { dbc } = this.state;
    dbc.lastUpdated = dbc.lastUpdated || Date.now();

    Object.keys(messages).forEach((key) => {
      messages[key].frame = dbc.getMessageFrame(messages[key].address);
    });

    return new Promise((resolve, reject) => {
      const worker = new MessageParser();
      worker.onmessage = (e) => {
        const newMessages = e.data.messages;
        Object.keys(newMessages).forEach((key) => {
          newMessages[key].lastUpdated = dbc.lastUpdated;
          newMessages[key].frame = dbc.getMessageFrame(newMessages[key].address);
        });
        resolve(newMessages);
      };

      worker.postMessage({
        messages,
        dbcText: dbc.text(),
        canStartTime: this.state.firstCanTime
      });
    });
  }

  parseMessageEntry(_entry, dbc, lastMsg) {
    const entry = _entry;
    dbc.lastUpdated = dbc.lastUpdated || Date.now();
    entry.lastUpdated = dbc.lastUpdated;
    entry.frame = dbc.getMessageFrame(
      entry.address
    );

    let prevMsgEntry = lastMsg || null;
    const byteStateChangeCounts = [];
    // entry.messages[id].byteStateChangeCounts = byteStateChangeCounts.map(
    //   (count, idx) => entry.messages[id].byteStateChangeCounts[idx] + count
    // );
    entry.entries = entry.entries.map((message) => {
      if (message.hexData) {
        prevMsgEntry = DbcUtils.reparseMessage(dbc, message, prevMsgEntry);
      } else {
        prevMsgEntry = DbcUtils.parseMessage(
          dbc,
          message.time,
          message.address,
          message.data,
          message.timeStart,
          prevMsgEntry
        );
      }
      byteStateChangeCounts.push(prevMsgEntry.byteStateChangeCounts);
      prevMsgEntry = prevMsgEntry.msgEntry;
      return prevMsgEntry;
    });
    entry.byteStateChangeCounts = byteStateChangeCounts.reduce((memo, val) => {
      if (!memo) {
        return val;
      }
      return memo.map((count, idx) => val[idx] + count);
    }, null);

    return entry;
  }

  showingModal() {
    const {
      showOnboarding,
      showLoadDbc,
      showSaveDbc,
      showAddSignal,
      showEditMessageModal
    } = this.state;
    return (
      showOnboarding
      || showLoadDbc
      || showSaveDbc
      || showAddSignal
      || showEditMessageModal
    );
  }

  showOnboarding() {
    if (!CommaAuth.isAuthenticated() && window.sessionStorage && window.location &&
      window.location.pathname !== AuthConfig.AUTH_PATH)
    {
      window.sessionStorage.setItem('onboardingPath', window.location.href);
    }
    this.setState({ showOnboarding: true });
  }

  hideOnboarding() {
    this.setState({ showOnboarding: false });
  }

  showLoadDbc() {
    this.setState({ showLoadDbc: true });
  }

  hideLoadDbc() {
    this.setState({ showLoadDbc: false });
  }

  showSaveDbc() {
    this.setState({ showSaveDbc: true });
  }

  hideSaveDbc() {
    this.setState({ showSaveDbc: false });
  }

  updateMessageFrame(messageId, frame) {
    const { messages } = this.state;

    messages[messageId].frame = frame;
    this.setState({ messages });
  }

  persistDbc({ dbcFilename, dbc }) {
    const { route, csvPlayback } = this.state;
    if (route) {
      persistDbc(route.fullname, { dbcFilename, dbc });
    } else {
      persistDbc('live', { dbcFilename, dbc });
    }

    if (!csvPlayback) {
      this.loadMessagesFromCache();
    }
  }

  onConfirmedSignalChange(message, signals) {
    const { dbc, dbcFilename, csvPlayback, messages, firstCanTime } = this.state;
    const frameSize = DbcUtils.maxMessageSize(message);
    dbc.setSignals(message.address, { ...signals }, frameSize);

    this.persistDbc({ dbcFilename, dbc });

    this.updateMessageFrame(message.id, dbc.getMessageFrame(message.address));

    if (csvPlayback) {
      // Re-parse CSV messages with new signal definitions
      const updatedMessages = { ...messages };
      const msg = { ...updatedMessages[message.id] };
      msg.frame = dbc.getMessageFrame(msg.address);
      msg.entries = [...msg.entries];
      let prevEntry = null;
      msg.entries = msg.entries.map((entry) => {
        const parsed = DbcUtils.parseMessage(
          dbc,
          entry.time,
          msg.address,
          entry.data,
          firstCanTime,
          prevEntry
        );
        prevEntry = parsed.msgEntry;
        return {
          ...entry,
          signals: parsed.msgEntry.signals,
          byteStateChangeCounts: parsed.byteStateChangeCounts
        };
      });
      updatedMessages[message.id] = msg;
      this.setState({ dbc, dbcText: dbc.text(), messages: updatedMessages });
    } else {
      this.setState({ dbc, dbcText: dbc.text() }, () => {
        this.decacheMessageId(message.id);
        this.loadMessagesFromCache();
      });
    }
  }

  partChangeDebounced = debounce(() => {
    this.loadMessagesFromCache();

    this.spawnWorker();
  }, 500);

  onPartChange(part) {
    let {
      currentParts, currentPart, canFrameOffset, route
    } = this.state;
    if (canFrameOffset === -1 || part === currentPart || !route) {
      return;
    }

    // determine new parts to load, whether to prepend or append
    let maxPart = Math.min(route.proclog, part + 1);
    const minPart = Math.max(0, maxPart - PART_SEGMENT_LENGTH + 1);
    if (minPart === 0) {
      maxPart = Math.min(route.proclog, 2);
    }

    // update current parts
    currentParts = [minPart, maxPart];
    currentPart = part;

    if (
      currentPart !== this.state.currentPart
      || currentParts[0] !== this.state.currentParts[0]
      || currentParts[1] !== this.state.currentParts[1]
    ) {
      // update state then load new parts
      this.setState({ currentParts, currentPart }, this.partChangeDebounced);
    }
  }

  showEditMessageModal(msgKey) {
    const msg = this.state.messages[msgKey];
    console.log(msg);
    
    this.setState({
      showEditMessageModal: true,
      editMessageModalMessage: msgKey,
      messages: this.state.messages,
      dbcText: this.state.dbc.text()
    });
  }

  hideEditMessageModal() {
    this.setState({ showEditMessageModal: false });
  }

  onMessageFrameEdited(messageFrame) {
    const {
      messages, dbcFilename, dbc, editMessageModalMessage
    } = this.state;

    const frameToSave = messageFrame instanceof Frame
      ? messageFrame
      : new Frame({
        ...messageFrame,
        transmitters: [...(messageFrame.transmitters || [])],
        signals: { ...(messageFrame.signals || {}) }
      });

    const message = { ...messages[editMessageModalMessage] };
    message.frame = frameToSave;
    dbc.messages.set(frameToSave.id, frameToSave);
    this.persistDbc({ dbcFilename, dbc });

    const updatedMessages = { ...messages };
    updatedMessages[editMessageModalMessage] = message;
    this.setState({ messages: updatedMessages, dbc, dbcText: dbc.text() });
    this.hideEditMessageModal();
  }

  onSeek(seekIndex, seekTime) {
    this.setState({ seekIndex, seekTime });

    const { currentPart } = this.state;
    const part = ~~(seekTime / 60);
    if (part !== currentPart) {
      this.onPartChange(part);
    }
  }

  onUserSeek(seekTime) {
    if (USE_UNLOGGER) {
      this.unloggerClient.seek(this.props.dongleId, this.props.name, seekTime);
    }

    const msg = this.state.messages[this.state.selectedMessage];
    let seekIndex;
    if (msg) {
      seekIndex = msg.entries.findIndex((e) => e.relTime >= seekTime);
      if (seekIndex === -1) {
        seekIndex = 0;
      }
    } else {
      seekIndex = 0;
    }

    this.onSeek(seekIndex, seekTime);
  }

  onMessageSelected(msgKey) {
    let { seekTime, seekIndex, messages } = this.state;
    const msg = messages[msgKey];

    if (seekTime > 0 && msg.entries.length > 0) {
      seekIndex = msg.entries.findIndex((e) => e.relTime >= seekTime);
      if (seekIndex === -1) {
        seekIndex = 0;
      }

      seekTime = msg.entries[seekIndex].relTime;
    }

    this.setState({ seekTime, seekIndex, selectedMessage: msgKey });
  }

  updateSelectedMessages(selectedMessages) {
    this.setState({ selectedMessages });
  }

  onMessageUnselected(msgKey) {
    this.setState({ selectedMessage: null });
  }

  loginWithGithub() {
    const { route } = this.state;
    return (
      <a
        href={GithubAuth.authorizeUrl(
          route && route.fullname ? route.fullname : ''
        )}
        className="button button--dark button--inline"
      >
        <i className="fa fa-github" />
        <span> Log in with Github</span>
      </a>
    );
  }

  lastMessageEntriesById(obj, [msgId, message]) {
    obj[msgId] = message.entries[message.entries.length - 1];
    return obj;
  }

  processStreamedCanMessages(newCanMessages) {
    const { dbcText } = this.state;
    const {
      firstCanTime,
      lastBusTime,
      messages,
      maxByteStateChangeCount
    } = this.state;
    const epochOffset = this.getLiveEpochOffset();
    const epochCanMessages = Array.isArray(newCanMessages)
      ? newCanMessages.map((batch) => ({
        ...batch,
        time: batch.time + epochOffset
      }))
      : newCanMessages;
    // map msg id to arrays
    const prevMsgEntries = Object.entries(messages).reduce(
      this.lastMessageEntriesById,
      {}
    );

    const byteStateChangeCountsByMessage = Object.entries(messages).reduce(
      (obj, [msgId, msg]) => {
        obj[msgId] = msg.byteStateChangeCounts;
        return obj;
      },
      {}
    );

    this.canStreamerWorker.postMessage({
      newCanMessages: epochCanMessages,
      prevMsgEntries,
      firstCanTime,
      dbcText,
      lastBusTime,
      byteStateChangeCountsByMessage,
      maxByteStateChangeCount
    });
  }

  firstEntryIndexInsideStreamingWindow(entries) {
    const lastEntryTime = entries[entries.length - 1].relTime;
    const windowFloor = lastEntryTime - STREAMING_WINDOW;

    for (let i = 0; i < entries.length; i++) {
      if (entries[i].relTime > windowFloor) {
        return i;
      }
    }

    return 0;
  }

  enforceStreamingMessageWindow(messages) {
    const messageIds = Object.keys(messages);
    for (let i = 0; i < messageIds.length; i++) {
      const messageId = messageIds[i];
      const message = messages[messageId];
      if (message.entries.length < 2) {
        continue;
      }

      const lastEntryTime = message.entries[message.entries.length - 1].relTime;
      const entrySpan = lastEntryTime - message.entries[0].relTime;
      if (entrySpan > STREAMING_WINDOW) {
        const newEntryFloor = this.firstEntryIndexInsideStreamingWindow(
          message.entries
        );
        message.entries = message.entries.slice(newEntryFloor);
        messages[messageId] = message;
      }
    }

    return messages;
  }

  _onStreamedCanMessagesProcessed(data) {
    let {
      newMessages,
      seekTime,
      lastBusTime,
      firstCanTime,
      maxByteStateChangeCount
    } = data;

    if (maxByteStateChangeCount < this.state.maxByteStateChangeCount) {
      maxByteStateChangeCount = this.state.maxByteStateChangeCount;
    }

    let messages = this.addAndRehydrateMessages(newMessages);
    
    // Store full history for CSV export (before windowing)
    if (!this.fullMessageHistory) {
      this.fullMessageHistory = {};
    }
    Object.keys(newMessages).forEach(key => {
      if (!this.fullMessageHistory[key]) {
        this.fullMessageHistory[key] = { ...messages[key], entries: [...messages[key].entries] };
      } else {
        this.fullMessageHistory[key].entries = this.fullMessageHistory[key].entries.concat(newMessages[key].entries);
      }
    });
    
    // Only trim displayed data for live streaming, not CSV playback
    if (!this.state.csvPlayback) {
      messages = this.enforceStreamingMessageWindow(messages);
    }
    let { seekIndex, selectedMessages } = this.state;
    if (
      selectedMessages.length > 0
      && messages[selectedMessages[0]] !== undefined
    ) {
      seekIndex = Math.max(0, messages[selectedMessages[0]].entries.length - 1);
    }
    this.setState({
      messages,
      seekTime,
      seekIndex,
      lastBusTime,
      firstCanTime,
      maxByteStateChangeCount
    });
  }

  onStreamedCanMessagesProcessed(e) {
    this._onStreamedCanMessagesProcessed(e.data);
  }

  async handlePandaConnect(e) {
    this.setState({ attemptingPandaConnection: true, live: true });

    const persistedDbc = fetchPersistedDbc('live');
    if (persistedDbc) {
      const { dbc, dbcText } = persistedDbc;
      this.setState({ dbc, dbcText });
    }
    this.canStreamerWorker = new CanStreamerWorker();
    this.canStreamerWorker.onmessage = this.onStreamedCanMessagesProcessed;

    // if any errors go off during connection, mark as not trying to connect anymore...
    const unlisten = this.pandaReader.onError((err) => {
      console.error(err.stack || err);
      this.setState({ attemptingPandaConnection: false });
    });
    try {
      await this.pandaReader.start();
      this.setState({
        showOnboarding: false,
        showLoadDbc: true
      });
    } catch (e) {}
    this.setState({ attemptingPandaConnection: false });
    unlisten();
  }

  githubSignOut(e, dataArray) {
    unpersistGithubAuthToken();
    this.setState({ isGithubAuthenticated: false });

    e.preventDefault();
  }

  onDbcFilenameChange(filename) {
    this.setState({ dbcFilename: filename });
  }

  applyJ1939Baseline(messages, dbc, timeStart) {
    if (!messages) {
      return { messages, dbc };
    }

    const baseline = j1939Baseline || {};

    const mutatedMessages = { ...messages };
    Object.values(mutatedMessages).forEach((msg) => {
      if (msg.frame) {
        return;
      }
      const firstJ = msg.entries && msg.entries.find((e) => e.j1939 && baseline[e.j1939.pgn]);
      if (!firstJ) {
        return;
      }
      const def = baseline[firstJ.j1939.pgn];
      if (!def) {
        return;
      }

      const address = msg.address;
      const frame = this.buildJ1939FrameFromBaseline(firstJ.j1939.pgn, def, address);
      dbc.messages.set(address, frame);
      msg.frame = frame;

      // Populate signal values for each entry
      msg.entries = msg.entries.map((entry) => ({
        ...entry,
        signals: dbc.getSignalValues(address, entry.data)
      }));
    });

    return { messages: mutatedMessages, dbc };
  }

  buildJ1939FrameFromBaseline(pgn, def, address) {
    const signals = {};
    let maxBit = 0;
    (def.signals || []).forEach((sigDef) => {
      const valueDescriptions = new Map(
        sigDef.type === 'lookup' && sigDef.map
          ? Object.entries(sigDef.map)
          : []
      );
      const size = sigDef.bit_length || 0;
      const startBit = sigDef.start_bit || 0;
      maxBit = Math.max(maxBit, startBit + size);
      const sig = new Signal({
        name: sigDef.name,
        startBit,
        size,
        factor: sigDef.factor !== undefined ? sigDef.factor : 1,
        offset: sigDef.offset !== undefined ? sigDef.offset : 0,
        unit: sigDef.unit || '',
        isLittleEndian: true,
        isSigned: sigDef.type === 'signed',
        valueDescriptions
      });
      signals[sig.name] = sig;
    });
    const sizeBytes = Math.max(8, Math.ceil(maxBit / 8));
    return new Frame({
      name: def.acronym || `PGN_${pgn}`,
      id: address,
      size: sizeBytes,
      transmitters: ['J1939'],
      extended: 1,
      comment: def.name || null,
      signals,
      _j1939Baseline: true
    });
  }

  mergeJ1939BaselineIntoDbc(dbc, messages) {
    if (!messages || !dbc) {
      return dbc;
    }
    const baseline = j1939Baseline || {};

    const mutatedMessages = { ...messages };
    Object.values(mutatedMessages).forEach((msg) => {
      const firstJ = msg.entries && msg.entries.find((e) => e.j1939 && baseline[e.j1939.pgn]);
      if (!firstJ) {
        return;
      }
      const def = baseline[firstJ.j1939.pgn];
      if (!def) {
        return;
      }

      const address = msg.address;
      const frame = this.buildJ1939FrameFromBaseline(firstJ.j1939.pgn, def, address);
      dbc.messages.set(address, frame); // baseline wins on conflict
    });

    return dbc;
  }

  stripBaselineFromDbc(dbc) {
    if (!dbc) {
      return dbc;
    }
    const newDbc = new DBC();
    newDbc.boardUnits = [...dbc.boardUnits];
    newDbc.comments = [...dbc.comments];
    newDbc.messages = new Map();
    dbc.messages.forEach((frame, id) => {
      if (!frame || frame._j1939Baseline) {
        return;
      }
      newDbc.messages.set(id, frame);
    });
    return newDbc;
  }

  reparseMessagesWithDbc(messages, dbc, firstCanTime) {
    const updatedMessages = { ...messages };
    Object.keys(updatedMessages).forEach((key) => {
      const msg = { ...updatedMessages[key] };
      msg.frame = dbc.getMessageFrame(msg.address);
      msg.entries = [...msg.entries];
      let prevEntry = null;
      const byteStateChangeCounts = [];
      msg.entries = msg.entries.map((entry) => {
        const parsed = DbcUtils.parseMessage(
          dbc,
          entry.time,
          msg.address,
          entry.data,
          firstCanTime,
          prevEntry
        );
        prevEntry = parsed.msgEntry;
        byteStateChangeCounts.push(parsed.byteStateChangeCounts);
        return {
          ...entry,
          signals: parsed.msgEntry.signals,
          byteStateChangeCounts: parsed.byteStateChangeCounts
        };
      });
      msg.byteStateChangeCounts = byteStateChangeCounts.reduce((memo, val) => {
        if (!memo) return val;
        return memo.map((count, idx) => val[idx] + count);
      }, null);
      updatedMessages[key] = msg;
    });

    const maxByteStateChangeCount = DbcUtils.findMaxByteStateChangeCount(updatedMessages);
    Object.keys(updatedMessages).forEach((key) => {
      updatedMessages[key] = DbcUtils.setMessageByteColors(
        updatedMessages[key],
        maxByteStateChangeCount
      );
    });
    return updatedMessages;
  }

  toggleJ1939Enabled(show) {
    if (show === this.state.j1939Enabled) return;

    let { dbc, messages, firstCanTime } = this.state;

    if (show) {
      dbc = this.mergeJ1939BaselineIntoDbc(dbc, messages);
      messages = this.reparseMessagesWithDbc(messages, dbc, firstCanTime);
    } else {
      dbc = this.stripBaselineFromDbc(dbc);
      messages = this.reparseMessagesWithDbc(messages, dbc, firstCanTime);
    }

    this.setState({
      j1939Enabled: show,
      dbc,
      dbcText: dbc.text(),
      messages
    });
  }

  unloadDbc() {
    const newDbc = new DBC();
    const clearedMessages = {};

    Object.keys(this.state.messages).forEach((key) => {
      const msg = this.state.messages[key];
      const entries = (msg.entries || []).map((entry) => ({
        ...entry,
        signals: {}
      }));
      clearedMessages[key] = {
        ...msg,
        frame: null,
        entries
      };
    });

    if (this.fullMessageHistory) {
      const history = {};
      Object.keys(this.fullMessageHistory).forEach((key) => {
        const msg = this.fullMessageHistory[key];
        const entries = (msg.entries || []).map((entry) => ({
          ...entry,
          signals: {}
        }));
        history[key] = { ...msg, frame: null, entries };
      });
      this.fullMessageHistory = history;
    }

    this.setState({
      dbc: newDbc,
      dbcFilename: NEW_DBC,
      dbcText: newDbc.text(),
      dbcLastSaved: null,
      messages: clearedMessages
    }, () => {
      this.persistDbc({ dbcFilename: NEW_DBC, dbc: newDbc });
    });
  }



  handleCsvUpload(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        let { messages, firstCanTime, duration } = parseCSVLog(e.target.result);
        // Reset to new DBC for new CSV
        let newDbc = new DBC();

        if (this.state.j1939Enabled) {
          const applied = this.applyJ1939Baseline(messages, newDbc, firstCanTime);
          messages = applied.messages;
          newDbc = applied.dbc;
        }

        this.setState({
          messages,
          firstCanTime,
          canFrameOffset: 0,
          route: null,
          csvDuration: duration,
          csvPlayback: true,
          showOnboarding: false,
          showLoadDbc: true,
          live: true,
          dbc: newDbc,
          dbcFilename: NEW_DBC,
          dbcText: newDbc.text(),
          selectedMessage: null,
          selectedMessages: [],
          seekTime: 0,
          seekIndex: 0
        });
      } catch (err) {
        alert('Error parsing CSV: ' + err.message);
      }
    };
    reader.readAsText(file);
  }

  looksLikeEpochSeconds(t) {
    return Number.isFinite(t) && t > 1e8;
  }

  handleGpsUpload(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const track = parseGpxTrack(e.target.result);
        const { firstCanTime } = this.state;
        let gpsOffsetSec = 0;
        if (this.looksLikeEpochSeconds(firstCanTime) && this.looksLikeEpochSeconds(track.startEpoch)) {
          // Align CAN t=0 to track t=0 by default
          gpsOffsetSec = firstCanTime - track.startEpoch;
        }
        this.setState({ gpsTrack: track, gpsOffsetSec });
      } catch (err) {
        alert('Error parsing GPX: ' + err.message);
      }
    };
    reader.readAsText(file);
  }

  clearGpsTrack() {
    this.setState({ gpsTrack: null, gpsOffsetSec: 0 });
  }

  setGpsOffsetSec(offset) {
    const value = Number(offset);
    if (Number.isNaN(value) || !Number.isFinite(value)) {
      return;
    }
    this.setState({ gpsOffsetSec: value });
  }

  render() {
    const {
      route,
      messages,
      selectedMessages,
      currentParts,
      dbcFilename,
      dbcLastSaved,
      seekTime,
      seekIndex,
      shareUrl,
      maxByteStateChangeCount,
      live,
      thumbnails,
      selectedMessage,
      canFrameOffset,
      firstCanTime,
      currentPart,
      partsLoaded,
      share,
    } = this.state;

    const { startTime, segments } = this.props;

    return (
      <div
        id="cabana"
        className={cx({ 'is-showing-modal': this.showingModal() })}
      >
        <div className="cabana-header">
          <a className="cabana-header-logo" href="/">
            RetroPilot Cabana
          </a>
        </div>
        <div className="cabana-window">
        <Meta
          url={this.state.route ? route.url : null}
          messages={messages}
          selectedMessages={selectedMessages}
          updateSelectedMessages={this.updateSelectedMessages}
          showJ1939={this.state.j1939Enabled}
          onToggleShowJ1939={this.toggleJ1939Enabled}
          seekIndex={seekIndex}
          showEditMessageModal={this.showEditMessageModal}
          currentParts={currentParts}
          onMessageSelected={this.onMessageSelected}
          onMessageUnselected={this.onMessageUnselected}
          showLoadDbc={this.showLoadDbc}
            showSaveDbc={this.showSaveDbc}
            unloadDbc={this.unloadDbc}
            dbcFilename={dbcFilename}
            dbcLastSaved={dbcLastSaved}
            dongleId={this.props.dongleId}
            name={this.props.name}
          route={route}
          seekTime={seekTime}
          shareUrl={shareUrl}
          maxByteStateChangeCount={maxByteStateChangeCount}
          live={live}
          csvPlayback={this.state.csvPlayback}
          saveLog={debounce(this.downloadLogAsCSV, 500)}
          handleCsvUpload={this.handleCsvUpload}
          handleGpsUpload={this.handleGpsUpload}
          gpsTrack={this.state.gpsTrack}
          onClearGpsTrack={this.clearGpsTrack}
          onDbcFilenameChange={this.onDbcFilenameChange}
        />
          {route || live ? (
            <Explorer
              url={route ? route.url : null}
              live={live}
              messages={messages}
              thumbnails={thumbnails}
              selectedMessage={selectedMessage}
              onConfirmedSignalChange={this.onConfirmedSignalChange}
              onSeek={this.onSeek}
              onUserSeek={this.onUserSeek}
              canFrameOffset={canFrameOffset}
              firstCanTime={firstCanTime}
              seekTime={seekTime}
              startTime={startTime}
              startSegments={segments}
              seekIndex={seekIndex}
              currentParts={currentParts}
              selectedPart={currentPart}
              partsLoaded={partsLoaded}
              autoplay={this.props.autoplay}
              showEditMessageModal={this.showEditMessageModal}
              onPartChange={this.onPartChange}
              routeStartTime={
                route ? route.start_time : Moment()
              }
              videoOffset={ (this.state.firstFrameTime && this.state.routeInitTime) ? this.state.firstFrameTime - this.state.routeInitTime : 0 }
              partsCount={route ? route.proclog : 0}
              maxqcamera={route ? route.maxqcamera : 0}
              route={route}
              share={share}
              csvDuration={this.state.csvDuration}
              csvPlayback={this.state.csvPlayback}
              gpsTrack={this.state.gpsTrack}
              gpsOffsetSec={this.state.gpsOffsetSec}
              onGpsOffsetChange={this.setGpsOffsetSec}
            />
          ) : null}
        </div>

        {this.state.showOnboarding ? (
          <OnboardingModal
            handlePandaConnect={this.handlePandaConnect}
            handleCsvUpload={this.handleCsvUpload}
            attemptingPandaConnection={this.state.attemptingPandaConnection}
            routes={this.state.routes}
          />
        ) : null}

        {this.state.showLoadDbc ? (
          <LoadDbcModal
            onDbcSelected={this.onDbcSelected}
            handleClose={this.hideLoadDbc}
          />
        ) : null}

        {this.state.showSaveDbc ? (
          <SaveDbcModal
            dbc={this.state.dbc}
            sourceDbcFilename={this.state.dbcFilename}
            onDbcSaved={this.onDbcSaved}
            handleClose={this.hideSaveDbc}
          />
        ) : null}

        {this.state.showEditMessageModal ? (
          <EditMessageModal
            handleClose={this.hideEditMessageModal}
            handleSave={this.onMessageFrameEdited}
            message={this.state.messages[this.state.editMessageModalMessage]}
          />
        ) : null}
      </div>
    );
  }
}

CanExplorer.propTypes = {
  dongleId: PropTypes.string,
  name: PropTypes.string,
  dbc: PropTypes.instanceOf(DBC),
  dbcFilename: PropTypes.string,
  githubAuthToken: PropTypes.string,
  autoplay: PropTypes.bool,
  max: PropTypes.number,
  url: PropTypes.string,
  startTime: PropTypes.number,
  segments: PropTypes.array
};
