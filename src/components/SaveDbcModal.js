import React, { Component } from 'react';
import PropTypes from 'prop-types';
import FileSaver from 'file-saver';

import DBC from '../models/can/dbc';
import Modal from './Modals/baseModal';

export default class SaveDbcModal extends Component {
  static propTypes = {
    dbc: PropTypes.instanceOf(DBC).isRequired,
    sourceDbcFilename: PropTypes.string.isRequired,
    handleClose: PropTypes.func.isRequired,
    onDbcSaved: PropTypes.func.isRequired
  };

  constructor(props) {
    super(props);
    this.state = {
      dbcFilename: this.props.sourceDbcFilename
    };

    this.downloadDbcFile = this.downloadDbcFile.bind(this);
    this.renderActions = this.renderActions.bind(this);
  }



  async downloadDbcFile() {
    const blob = new Blob([this.props.dbc.text()], {
      type: 'text/plain;charset=utf-8'
    });
    const filename = `${this.state.dbcFilename.replace(/\.dbc/g, '')}.dbc`;
    FileSaver.saveAs(blob, filename, true);
  }



  renderFilenameField() {
    return (
      <div className="form-field" data-extension=".dbc">
        <label htmlFor="filename">
          <span>Choose a filename:</span>
          <sup>Pick a unique name for your car DBC file</sup>
        </label>
        <input
          type="text"
          id="filename"
          value={this.state.dbcFilename.replace(/\.dbc/g, '')}
          size={this.state.dbcFilename.length + 2}
          onChange={(e) => this.setState({ dbcFilename: e.target.value })}
        />
      </div>
    );
  }



  renderActions() {
    return (
      <div>
        <button className="button--inverted" onClick={this.props.handleClose}>
          <span>Cancel</span>
        </button>
        <button className="button--primary" onClick={this.downloadDbcFile}>
          <span>Download</span>
        </button>
      </div>
    );
  }

  render() {
    return (
      <Modal
        title="Save DBC File"
        subtitle="Save your progress and output to a DBC file"
        handleClose={this.props.handleClose}
        actions={this.renderActions()}
      >
        {this.renderFilenameField()}
      </Modal>
    );
  }
}
