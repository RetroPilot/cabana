import React, { Component } from 'react';
import cx from 'classnames';
import PropTypes from 'prop-types';
import Clipboard from 'clipboard';

import MessageBytes from './MessageBytes';

const { ckmeans } = require('simple-statistics');

function calculateFrequency(entries, seekTime, live, csvPlayback) {
  if (entries.length < 2) return 0;
  
  let relevantEntries = entries;
  if (!live || csvPlayback) {
    relevantEntries = entries.filter(e => e.relTime <= seekTime);
  }
  
  if (relevantEntries.length < 2) return 0;
  
  const lastEntry = relevantEntries[relevantEntries.length - 1];
  const oneSecondAgo = lastEntry.relTime - 1.0;
  
  const messagesInLastSecond = relevantEntries.filter(e => e.relTime > oneSecondAgo);
  
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


    const { dbcLastSaved } = props;

    this.state = {
      filterText: 'Filter',
      lastSaved:
        dbcLastSaved !== null ? this.props.dbcLastSaved.fromNow() : null,
      hoveredMessages: [],
      orderedMessageKeys: [],
      editingFilename: false,
      tempFilename: props.dbcFilename,

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

  selectedMessageClass(messageId) {
    return this.props.selectedMessages.includes(messageId)
      ? 'is-selected'
      : null;
  }

  renderMessageBytes(msg) {
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
      </tr>
    );
  }

  renderCanMessages() {
    return this.orderedMessages()
      .filter(this.canMsgFilter)
      .map(this.renderMessageBytes);
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
              <td>Name</td>
              <td>ID</td>
              <td>Count</td>
              <td>Hz</td>
              <td>Bytes</td>
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

  render() {
    return (
      <div className="cabana-meta" style={{ minWidth: '500px' }}>
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
