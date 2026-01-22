import React, { Component } from 'react';
import PropTypes from 'prop-types';
import DBC from '../models/can/dbc';
import Modal from './Modals/baseModal';
import DbcUpload from './DbcUpload';

export default class LoadDbcModal extends Component {
  static propTypes = {
    handleClose: PropTypes.func.isRequired,
    onDbcSelected: PropTypes.func.isRequired
  };

  constructor(props) {
    super(props);
    this.state = {
      dbc: null,
      dbcSource: null
    };

    this.onDbcLoaded = this.onDbcLoaded.bind(this);
    this.handleSave = this.handleSave.bind(this);
    this.renderActions = this.renderActions.bind(this);
  }

  onDbcLoaded(dbcSource, dbcText) {
    const dbc = new DBC(dbcText);
    this.setState({ dbcSource, dbc });
  }

  handleSave() {
    const { dbc, dbcSource } = this.state;
    this.props.onDbcSelected(dbcSource, dbc);
  }

  renderActions(disabled) {
    return (
      <div>
        <button className="button--inverted" onClick={this.props.handleClose}>
          <span>Cancel</span>
        </button>
        <button className="button--primary" disabled={ disabled } onClick={ this.handleSave }>
          <span>Load DBC</span>
        </button>
      </div>
    );
  }

  render() {
    return (
      <Modal
        title="Load DBC File"
        subtitle="Modify an existing DBC file with Cabana"
        handleClose={this.props.handleClose}
        actions={this.renderActions(Boolean(this.state.dbc === null))}
      >
        <DbcUpload onDbcLoaded={this.onDbcLoaded} />
      </Modal>
    );
  }
}
