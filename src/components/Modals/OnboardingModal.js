import React, { Component } from 'react';
import PropTypes from 'prop-types';
import cx from 'classnames';
import qs from 'query-string';
import CommaAuth, { config as AuthConfig } from '@commaai/my-comma-auth';

import { EXPLORER_URL } from '../../config';
import Modal from './baseModal';

export default class OnboardingModal extends Component {
  static propTypes = {
    handlePandaConnect: PropTypes.func,
    handleCsvUpload: PropTypes.func,
    routes: PropTypes.array
  };

  static instructionalImages = {
    step2: require('../../images/webusb-enable-experimental-features.png'),
    step3: require('../../images/webusb-enable-webusb.png')
  };

  constructor(props) {
    super(props);

    this.state = {
      webUsbEnabled: typeof navigator !== 'undefined' && 'usb' in navigator,
      viewingUsbInstructions: false,
      pandaConnected: false
    };

    this.attemptPandaConnection = this.attemptPandaConnection.bind(this);
    this.toggleUsbInstructions = this.toggleUsbInstructions.bind(this);
    this.navigateToExplorer = this.navigateToExplorer.bind(this);
  }



  attemptPandaConnection() {
    if (!this.state.webUsbEnabled) {
      return;
    }
    this.props.handlePandaConnect();
  }

  toggleUsbInstructions() {
    this.setState({
      viewingUsbInstructions: !this.state.viewingUsbInstructions
    });
  }

  navigateToExplorer() {
    window.location.href = EXPLORER_URL;
  }

  filterRoutesWithCan(drive) {
    return drive.can === true;
  }

  renderPandaEligibility() {
    const { webUsbEnabled, pandaConnected } = this.state;
    const { attemptingPandaConnection } = this.props;
    if (!webUsbEnabled) {
      return (
        <p>
          <i className="fa fa-exclamation-triangle" />
          <span onClick={this.toggleUsbInstructions}>
            <span>WebUSB is not enabled in your Chrome settings</span>
          </span>
        </p>
      );
    }
    if (!pandaConnected && attemptingPandaConnection) {
      return (
        <p>
          <i className="fa fa-spinner animate-spin" />
          <span className="animate-pulse-opacity">
            Waiting for panda USB connection
          </span>
        </p>
      );
    }
  }

  renderLogin() {
    if (CommaAuth.isAuthenticated()) {
      return (
        <button onClick={this.navigateToExplorer} className="button--primary button--kiosk">
          <i className="fa fa-video-camera" />
          <strong>Find a drive in connect</strong>
          <sup>Click "View in cabana" while replaying a drive</sup>
        </button>
      );
    }
    return null;
  }

  renderOnboardingOptions() {
    return (
      <div className="cabana-onboarding-modes">
        <div className="cabana-onboarding-mode">{this.renderLogin()}</div>
        <div className="cabana-onboarding-mode">
          <button
            className={cx('button--secondary button--kiosk', {
              'is-disabled':
                !this.state.webUsbEnabled
                || this.props.attemptingPandaConnection
            })}
            onClick={this.attemptPandaConnection}
          >
            <i className="fa fa-bolt" />
            <strong>Launch Realtime Streaming</strong>
            <sup>
              Interactively stream car data over USB with
              {' '}
              <em>panda</em>
            </sup>
            {this.renderPandaEligibility()}
          </button>
        </div>
        <div className="cabana-onboarding-mode">
          <button
            className="button--secondary button--kiosk"
            onClick={() => this.fileInput.click()}
          >
            <i className="fa fa-upload" />
            <strong>Upload CSV Log</strong>
            <sup>Load an exported CSV log file for replay</sup>
          </button>
          <input
            ref={(input) => { this.fileInput = input; }}
            type="file"
            accept=".csv"
            style={{ display: 'none' }}
            onChange={(e) => {
              if (e.target.files && e.target.files[0]) {
                this.props.handleCsvUpload(e.target.files[0]);
              }
            }}
          />
        </div>
      </div>
    );
  }

  renderUsbInstructions() {
    return (
      <div className="cabana-onboarding-instructions">
        <button
          className="button--small button--inverted"
          onClick={this.toggleUsbInstructions}
        >
          <i className="fa fa-chevron-left" />
          <span> Go back</span>
        </button>
        <h3>Follow these directions to enable WebUSB:</h3>
        <ol className="cabana-onboarding-instructions-list list--bubbled">
          <li>
            <p>
              <strong>Open your Chrome settings:</strong>
            </p>
            <div className="inset">
              <span>
                chrome://flags/#enable-experimental-web-platform-features
              </span>
            </div>
          </li>
          <li>
            <p>
              <strong>Enable Experimental Platform features:</strong>
            </p>
            <img
              alt="Screenshot of Google Chrome Experimental Platform features"
              src={OnboardingModal.instructionalImages.step2}
            />
          </li>
          <li>
            <p>
              <strong>Enable WebUSB:</strong>
            </p>
            <img
              alt="Screenshot of Google Chrome enable WebUSB"
              src={OnboardingModal.instructionalImages.step3}
            />
          </li>
          <li>
            <p>
              <strong>
                Relaunch your Chrome browser and try enabling live mode again.
              </strong>
            </p>
          </li>
        </ol>
      </div>
    );
  }

  renderModalContent() {
    if (this.state.viewingUsbInstructions) {
      return this.renderUsbInstructions();
    }
    return this.renderOnboardingOptions();
  }

  renderModalFooter() {
    return (
      <p>
        <span>
          Don't have a
          {' '}
          <a
            href="https://comma.ai/shop/products/panda"
            target="_blank"
            rel="noopener noreferrer"
          >
            panda
          </a>
          ?
          {' '}
        </span>
        <span>
          <a
            href="https://comma.ai/shop/products/panda"
            target="_blank"
            rel="noopener noreferrer"
          >
            Get one here
          </a>
          {' '}
        </span>
        <span>
          or
          {' '}
          <a href={`${window.location.href}?demo=1`}>try the demo</a>
.
        </span>
      </p>
    );
  }

  render() {
    return (
      <Modal
        title="Welcome to Cabana"
        subtitle="Get started by selecting a drive from connect or enabling live mode"
        footer={this.renderModalFooter()}
        disableClose
        variations={['wide', 'dark']}
      >
        {this.renderModalContent()}
      </Modal>
    );
  }
}
