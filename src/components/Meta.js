import React, { Component } from 'react';
import cx from 'classnames';
import PropTypes from 'prop-types';
import Clipboard from 'clipboard';

import MessageBytes from './MessageBytes';

const { ckmeans } = require('simple-statistics');

function calculateFrequency(entries, seekTime, live, csvPlayback) {
  if (entries.length < 2) return 0;

  // For CSV playback, treat frequency as total count divided by total run time
  if (csvPlayback) {
    const lastEntry = entries[entries.length - 1];
    const duration = lastEntry ? lastEntry.relTime : 0;
    if (duration <= 0) return 0;
    return Math.round(entries.length / duration);
  }

  // Live mode: rough recent frequency over the last second up to seekTime
  let relevantEntries = entries;
  if (!live) {
    relevantEntries = entries.filter((e) => e.relTime <= seekTime);
  }

  if (relevantEntries.length < 2) return 0;

  const lastEntry = relevantEntries[relevantEntries.length - 1];
  const oneSecondAgo = lastEntry.relTime - 1.0;

  const messagesInLastSecond = relevantEntries.filter((e) => e.relTime > oneSecondAgo);

  if (messagesInLastSecond.length < 2) return 0;

  return Math.round(messagesInLastSecond.length);
}

export default class Meta extends Component {
  static propTypes = {
    onMessageSelected: PropTypes.func,
    onMessageUnselected: PropTypes.func,
    dongleId: PropTypes.string,
    name: PropTypes.string,
    messages: PropTypes.objectOf(PropTypes.object),
    selectedMessages: PropTypes.array,
    onPartChanged: PropTypes.func,
    partsCount: PropTypes.number,
    showLoadDbc: PropTypes.func,
    showSaveDbc: PropTypes.func,
    unloadDbc: PropTypes.func,
    dbcFilename: PropTypes.string,
    dbcLastSaved: PropTypes.object, // moment.js object,
    showEditMessageModal: PropTypes.func,
    route: PropTypes.object,
    partsLoaded: PropTypes.number,
    currentParts: PropTypes.array,
    seekTime: PropTypes.number,
    loginWithGithub: PropTypes.element,
    isDemo: PropTypes.bool,
    live: PropTypes.bool,
    showJ1939: PropTypes.bool,
    onToggleShowJ1939: PropTypes.func,
    seekIndex: PropTypes.number,

  };

  constructor(props) {
    super(props);

    this.onFilterChanged = this.onFilterChanged.bind(this);
    this.onFilterFocus = this.onFilterFocus.bind(this);
    this.onFilterUnfocus = this.onFilterUnfocus.bind(this);
    this.canMsgFilter = this.canMsgFilter.bind(this);
    this.renderMessageBytes = this.renderMessageBytes.bind(this);
    this.onFilenameEdit = this.onFilenameEdit.bind(this);
    this.onFilenameChange = this.onFilenameChange.bind(this);
    this.onFilenameBlur = this.onFilenameBlur.bind(this);
    this.toggleShowAscii = this.toggleShowAscii.bind(this);
    const { dbcLastSaved } = props;

    this.state = {
      filterText: 'Filter',
      lastSaved:
        dbcLastSaved !== null ? this.props.dbcLastSaved.fromNow() : null,
      hoveredMessages: [],
      orderedMessageKeys: [],
      editingFilename: false,
      tempFilename: props.dbcFilename,
      showAscii: false,
      sortBy: 'name',
      sortDir: 'asc'

    };
  }

  componentDidMount() {
    this.lastSavedTimer = setInterval(() => {
      if (this.props.dbcLastSaved !== null) {
        this.setState({ lastSaved: this.props.dbcLastSaved.fromNow() });
      }
    }, 30000);
  }

  componentWillUnmount() {
    window.clearInterval(this.lastSavedTimer);
  }

  componentDidUpdate(prevProps) {
    if (prevProps.lastSaved !== this.props.lastSaved) {
      this.setState({ lastSaved: this.props.dbcLastSaved.fromNow() });
    }

    if (JSON.stringify(Object.keys(prevProps.messages)) !== JSON.stringify(Object.keys(this.props.messages))) {
      const orderedMessageKeys = this.sortMessages(this.props.messages);
      this.setState({ hoveredMessages: [], orderedMessageKeys });
    } else if (this.state.orderedMessageKeys.length === 0 || (!this.props.live && prevProps.messages &&
      this.props.messages && this.byteCountsDidUpdate(prevProps.messages, this.props.messages)))
    {
      const orderedMessageKeys = this.sortMessages(this.props.messages);
      if (orderedMessageKeys.length > 0) {
        this.setState({ orderedMessageKeys });
      }
    }
  }

  byteCountsDidUpdate(prevMessages, nextMessages) {
    return Object.entries(nextMessages).some(
      ([msgId, msg]) => JSON.stringify(msg.byteStateChangeCounts)
        !== JSON.stringify(prevMessages[msgId].byteStateChangeCounts)
    );
  }

  sortMessages(messages) {
    // Returns list of message keys, ordered as follows:
    // messages are binned into at most 10 bins based on entry count
    // each bin is sorted by message CAN address
    // then the list of bins is flattened and reversed to
    // yield a count-descending, address-ascending order.

    if (Object.keys(messages).length === 0) return [];
    const messagesByEntryCount = Object.entries(messages).reduce(
      (partialMapping, [msgId, msg]) => {
        const entryCountKey = msg.entries.length.toString(); // js object keys are strings
        if (!partialMapping[entryCountKey]) {
          partialMapping[entryCountKey] = [msg];
        } else {
          partialMapping[entryCountKey].push(msg);
        }
        return partialMapping;
      },
      {}
    );

    const entryCounts = Object.keys(messagesByEntryCount).map((count) => parseInt(count, 10));
    const binnedEntryCounts = ckmeans(
      entryCounts,
      Math.min(entryCounts.length, 10)
    );
    const sortedKeys = binnedEntryCounts
      .map((bin) => bin
        .map((entryCount) => messagesByEntryCount[entryCount.toString()])
        .reduce((messages, partial) => messages.concat(partial), [])
        .sort((msg1, msg2) => {
          if (msg1.address < msg2.address) {
            return 1;
          }
          return -1;
        })
        .map((msg) => msg.id))
      .reduce((keys, bin) => keys.concat(bin), [])
      .reverse();

    return sortedKeys;
  }

  onFilterChanged(e) {
    let val = e.target.value;
    if (val.trim() === 'Filter') val = '';

    this.setState({ filterText: val });
  }

  onFilterFocus(e) {
    if (this.state.filterText.trim() === 'Filter') {
      this.setState({ filterText: '' });
    }
  }

  onFilterUnfocus(e) {
    if (this.state.filterText.trim() === '') {
      this.setState({ filterText: 'Filter' });
    }
  }

  onFilenameEdit() {
    this.setState({ 
      editingFilename: true, 
      tempFilename: this.props.dbcFilename === 'New_DBC' ? '' : this.props.dbcFilename 
    });
  }

  onFilenameChange(e) {
    this.setState({ tempFilename: e.target.value });
  }

  onFilenameBlur() {
    const filename = this.state.tempFilename.trim() || 'New_DBC';
    this.setState({ editingFilename: false });
    if (this.props.onDbcFilenameChange) {
      this.props.onDbcFilenameChange(filename);
    }
  }



  canMsgFilter(msg) {
    const { filterText } = this.state;
    const msgName = msg.frame ? msg.frame.name : '';

    return (
      filterText === 'Filter'
      || filterText === ''
      || msg.id.toLowerCase().indexOf(filterText.toLowerCase()) !== -1
      || msgName.toLowerCase().indexOf(filterText.toLowerCase()) !== -1
    );
  }

  lastSavedPretty() {
    const { dbcLastSaved } = this.props;
    return dbcLastSaved.fromNow();
  }

  onMessageHover(key) {
    const { hoveredMessages } = this.state;
    if (hoveredMessages.indexOf(key) !== -1) return;

    hoveredMessages.push(key);
    this.setState({ hoveredMessages });
  }

  onMessageHoverEnd(key) {
    let { hoveredMessages } = this.state;
    hoveredMessages = hoveredMessages.filter((m) => m !== key);
    this.setState({ hoveredMessages });
  }

  onMsgRemoveClick(key) {
    let { selectedMessages } = this.state;
    selectedMessages = selectedMessages.filter((m) => m !== key);
    this.props.onMessageUnselected(key);
    this.setState({ selectedMessages });
  }

  onMessageSelected(key) {
    // uncomment when we support multiple messages
    // const selectedMessages = this.state.selectedMessages.filter((m) => m !== key);
    const selectedMessages = [];
    selectedMessages.push(key);
    this.props.updateSelectedMessages(selectedMessages);
    this.props.onMessageSelected(key);
  }

  orderedMessages() {
    const { orderedMessageKeys } = this.state;
    const { messages } = this.props;
    return orderedMessageKeys.map((key) => messages[key]).filter(msg => msg);
  }

  getJ1939Meta(msg) {
    if (!this.props.showJ1939 || !msg || !msg.entries) {
      return null;
    }
    const first = msg.entries.find((e) => e.j1939);
    return first ? first.j1939 : null;
  }

  sortedMessages() {
    const msgs = this.orderedMessages().filter(this.canMsgFilter);
    const { sortBy, sortDir } = this.state;
    const dir = sortDir === 'desc' ? -1 : 1;
    return [...msgs].sort((a, b) => {
      const nameA = a.frame ? a.frame.name : 'untitled';
      const nameB = b.frame ? b.frame.name : 'untitled';
      const hzA = calculateFrequency(a.entries, this.props.seekTime, this.props.live, this.props.csvPlayback);
      const hzB = calculateFrequency(b.entries, this.props.seekTime, this.props.live, this.props.csvPlayback);
      const jA = this.getJ1939Meta(a);
      const jB = this.getJ1939Meta(b);
      const missing = dir === 1 ? Infinity : -Infinity;
      let va = 0;
      let vb = 0;
      switch (sortBy) {
        case 'name':
          return nameA.localeCompare(nameB) * dir;
        case 'id':
          va = a.address || 0;
          vb = b.address || 0;
          return (va - vb) * dir;
        case 'hz':
          return (hzA - hzB) * dir;
        case 'pri':
          va = jA ? jA.priority : missing;
          vb = jB ? jB.priority : missing;
          return (va - vb) * dir;
        case 'pgn':
          va = jA ? jA.pgn : missing;
          vb = jB ? jB.pgn : missing;
          return (va - vb) * dir;
        case 'sa':
          va = jA ? jA.sa : missing;
          vb = jB ? jB.sa : missing;
          return (va - vb) * dir;
        case 'da':
          va = jA ? (jA.pf < 0xF0 ? jA.ps : missing) : missing;
          vb = jB ? (jB.pf < 0xF0 ? jB.ps : missing) : missing;
          return (va - vb) * dir;
        default:
          return 0;
      }
    });
  }

  toggleSort(field) {
    this.setState((prev) => {
      const nextDir = prev.sortBy === field && prev.sortDir === 'asc' ? 'desc' : 'asc';
      return {
        sortBy: field,
        sortDir: prev.sortBy === field ? nextDir : 'asc'
      };
    });
  }

  sortIndicator(field) {
    if (this.state.sortBy !== field) return '';
    return this.state.sortDir === 'asc' ? '▲' : '▼';
  }

  selectedMessageClass(messageId) {
    return this.props.selectedMessages.includes(messageId)
      ? 'is-selected'
      : null;
  }

  currentEntry(msg) {
    if (!msg || !msg.entries || !msg.entries.length) {
      return null;
    }
    const idx = Math.min(
      Math.max(this.props.seekIndex || 0, 0),
      msg.entries.length - 1
    );
    return msg.entries[idx];
  }

  asciiForMessage(msg) {
    const entry = this.currentEntry(msg);
    if (!entry || !entry.data) return '';
    const slice = entry.data.slice(0, 64); // cap to keep renders snappy
    const chars = Array.from(slice).map((b) => (
      b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.'
    ));
    return chars.join('');
  }

  renderMessageBytes(msg) {
    const firstJ1939 = this.props.showJ1939 ? msg.entries.find((e) => e.j1939) : null;
    const j = firstJ1939 ? firstJ1939.j1939 : null;
    const ascii = this.state.showAscii ? this.asciiForMessage(msg) : null;
    return (
      <tr
        onClick={() => {
          this.onMessageSelected(msg.id);
        }}
        key={msg.id}
        className={cx(
          'cabana-meta-messages-list-item',
          this.selectedMessageClass(msg.id)
        )}
      >
        <td>
          <span 
            onDoubleClick={() => this.props.showEditMessageModal(msg.id)}
            style={{ cursor: 'pointer' }}
          >
            {msg.frame ? msg.frame.name : 'untitled'}
          </span>
        </td>
        <td>{msg.bus}:{msg.address.toString(16).toUpperCase()}</td>
        {this.props.showJ1939 ? (
          <>
            <td className="t-mono">{j ? j.priority : '--'}</td>
            <td className="t-mono">{j ? `0x${j.pgn.toString(16).toUpperCase().padStart(5, '0')}` : '--'}</td>
            <td className="t-mono">{j ? `0x${j.sa.toString(16).toUpperCase().padStart(2, '0')}` : '--'}</td>
            <td className="t-mono">{j ? (j.pf < 0xF0 ? `0x${j.ps.toString(16).toUpperCase().padStart(2, '0')}` : '--') : '--'}</td>
          </>
        ) : null}
        <td>{msg.entries.length}</td>
        <td style={{ whiteSpace: 'nowrap' }}>{calculateFrequency(msg.entries, this.props.seekTime, this.props.live, this.props.csvPlayback)} Hz</td>
        <td>
          <div className="cabana-meta-messages-list-item-bytes">
            <MessageBytes
              key={msg.id}
              message={msg}
              seekIndex={this.props.seekIndex}
              seekTime={this.props.seekTime}
              live={this.props.live}
              csvPlayback={this.props.csvPlayback}
            />
          </div>
        </td>
        {this.state.showAscii ? (
          <td className="t-mono" style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {ascii}
          </td>
        ) : null}
      </tr>
    );
  }

  renderCanMessages() {
    return this.sortedMessages().map(this.renderMessageBytes);
  }

  renderAvailableMessagesList() {
    if (Object.keys(this.props.messages).length === 0) {
      return <p>Loading messages...</p>;
    }
    return (
      <>
        <table cellPadding="5">
          <thead>
            <tr>
              <td>
                <button className="button--tiny" onClick={() => this.toggleSort('name')}>
                  Name {this.sortIndicator('name')}
                </button>
              </td>
              <td>
                <button className="button--tiny" onClick={() => this.toggleSort('id')}>
                  ID {this.sortIndicator('id')}
                </button>
              </td>
              {this.props.showJ1939 ? (
                <>
                  <td>
                    <button className="button--tiny" onClick={() => this.toggleSort('pri')}>
                      PRI {this.sortIndicator('pri')}
                    </button>
                  </td>
                  <td>
                    <button className="button--tiny" onClick={() => this.toggleSort('pgn')}>
                      PGN {this.sortIndicator('pgn')}
                    </button>
                  </td>
                  <td>
                    <button className="button--tiny" onClick={() => this.toggleSort('sa')}>
                      SA {this.sortIndicator('sa')}
                    </button>
                  </td>
                  <td>
                    <button className="button--tiny" onClick={() => this.toggleSort('da')}>
                      DA {this.sortIndicator('da')}
                    </button>
                  </td>
                </>
              ) : null}
              <td>Count</td>
              <td>
                <button className="button--tiny" onClick={() => this.toggleSort('hz')}>
                  Hz {this.sortIndicator('hz')}
                </button>
              </td>
              <td>Bytes</td>
              {this.state.showAscii ? <td>ASCII</td> : null}
            </tr>
          </thead>
          <tbody>{this.renderCanMessages()}</tbody>
        </table>
      </>
    );
  }

  saveable() {
    try {
      // eslint-disable-next-line
      "serviceWorker" in navigator &&
        !!new ReadableStream()
        && !!new WritableStream(); // eslint-disable-line no-undef
      return 'saveable';
    } catch (e) {
      return false;
    }
  }

  toggleShowAscii() {
    this.setState((prev) => ({ showAscii: !prev.showAscii }));
  }

  render() {
    return (
      <div className="cabana-meta" style={{ minWidth: '800px' }}>
        <div className="cabana-meta-header">
          <h5 className="cabana-meta-header-label t-capline">
            Currently editing:
          </h5>
          {this.state.editingFilename ? (
            <input
              type="text"
              value={this.state.tempFilename}
              onChange={this.onFilenameChange}
              onBlur={this.onFilenameBlur}
              onKeyPress={(e) => e.key === 'Enter' && e.target.blur()}
              autoFocus
              style={{ fontSize: '14px', fontWeight: 'bold' }}
            />
          ) : (
            <strong 
              className="cabana-meta-header-filename"
              onClick={this.onFilenameEdit}
              style={{ cursor: 'pointer' }}
            >
              {this.props.dbcFilename}
            </strong>
          )}
          {this.props.dbcLastSaved !== null ? (
            <div className="cabana-meta-header-last-saved">
              <p>
                Last saved:
                {this.lastSavedPretty()}
              </p>
            </div>
          ) : null}
          <div className="cabana-meta-header-actions" style={{ minWidth: '400px' }}>
            {this.props.csvPlayback ? (
              <div className="cabana-meta-header-action">
                <input
                  type="file"
                  accept=".csv"
                  onChange={(e) => {
                    if (e.target.files[0]) {
                      this.props.handleCsvUpload(e.target.files[0]);
                      e.target.value = '';
                    }
                  }}
                  style={{ display: 'none' }}
                  ref={(input) => { this.csvFileInput = input; }}
                />
                <button className="button--wide" onClick={() => this.csvFileInput.click()}>
                  <i className="fa fa-upload" /> Load Log
                </button>
              </div>
            ) : (
              this.saveable() && (
                <div className="cabana-meta-header-action">
                  <button className="button--wide" onClick={this.props.saveLog}>
                    <i className="fa fa-download" /> Save Log
                  </button>
                </div>
              )
            )}
            <div className="cabana-meta-header-action">
              <button className="button--wide" onClick={this.props.showLoadDbc}>
                <i className="fa fa-folder-open" /> Load DBC
              </button>
            </div>
            <div className="cabana-meta-header-action">
              <button className="button--wide" onClick={this.props.showSaveDbc}>
                <i className="fa fa-save" /> Save DBC
              </button>
            </div>
            <div className="cabana-meta-header-action">
              <button className="button--wide" onClick={this.props.unloadDbc}>
                <i className="fa fa-eject" /> Unload DBC
              </button>
            </div>
            <div className="cabana-meta-header-action j1939-toggle">
              <label className="t-smallcaps" style={{ display: 'flex', alignItems: 'center', gap: 6, margin: 0 }}>
                <input
                  type="checkbox"
                  checked={this.props.showJ1939}
                  onChange={(e) => this.props.onToggleShowJ1939 && this.props.onToggleShowJ1939(e.target.checked)}
                  />
                Show J1939
              </label>
            </div>
            <div className="cabana-meta-header-action j1939-toggle">
              <label className="t-smallcaps" style={{ display: 'flex', alignItems: 'center', gap: 6, margin: 0 }}>
                <input
                  type="checkbox"
                  checked={this.state.showAscii}
                  onChange={this.toggleShowAscii}
                />
                Show ASCII
              </label>
            </div>
            {this.props.shareUrl ? (
              <div
                className="cabana-meta-header-action special-wide"
                data-clipboard-text={this.props.shareUrl}
                data-clipboard-action="copy"
                ref={(ref) => (ref ? new Clipboard(ref) : null)}
              >
                <a
                  className="button button--wide"
                  href={this.props.shareUrl}
                  onClick={(e) => e.preventDefault()}
                >
                  <i className="fa fa-share" /> Copy Share Link
                </a>
              </div>
            ) : null}
          </div>
        </div>
        <div className="cabana-meta-messages-header">
          <h5 className="t-capline">Available messages</h5>
        </div>
        <div className="cabana-meta-messages-filter">
          <div className="form-field form-field--small">
            <input
              type="text"
              value={this.state.filterText}
              onFocus={this.onFilterFocus}
              onBlur={this.onFilterUnfocus}
              onChange={this.onFilterChanged}
            />
          </div>
        </div>
        <div className="cabana-meta-messages-list">
          {this.renderAvailableMessagesList()}
        </div>
      </div>
    );
  }
}
