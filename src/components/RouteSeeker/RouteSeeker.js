import React, { Component } from 'react';
import PropTypes from 'prop-types';
import PlayButton from '../PlayButton';
import debounce from '../../utils/debounce';

export default class RouteSeeker extends Component {
  static propTypes = {
    videoLength: PropTypes.number.isRequired,
    segmentIndices: PropTypes.arrayOf(PropTypes.number),
    segment: PropTypes.arrayOf(PropTypes.number),
    onUserSeek: PropTypes.func,
    onPlaySeek: PropTypes.func,
    video: PropTypes.node,
    onPause: PropTypes.func,
    onPlay: PropTypes.func,
    playing: PropTypes.bool,
    segmentProgress: PropTypes.func,
    ratioTime: PropTypes.func,
    nearestFrameTime: PropTypes.number,
    playSpeed: PropTypes.number
  };

  static hiddenMarkerStyle = { display: 'none', left: 0 };

  static zeroSeekedBarStyle = { width: 0 };

  static hiddenTooltipStyle = { display: 'none', left: 0 };

  static markerWidth = 20;

  static tooltipWidth = 50;

  constructor(props) {
    super(props);
    this.state = {
      seekedBarStyle: RouteSeeker.zeroSeekedBarStyle,
      markerStyle: RouteSeeker.hiddenMarkerStyle,
      tooltipStyle: RouteSeeker.hiddenTooltipStyle,
      ratio: 0,
      tooltipTime: '0:00',
      isPlaying: false,
      isDragging: false
    };

    this.onMouseMove = this.onMouseMove.bind(this);
    this.onMouseLeave = this.onMouseLeave.bind(this);
    this.onMouseDown = this.onMouseDown.bind(this);
    this.onMouseUp = this.onMouseUp.bind(this);
    this.onClick = this.onClick.bind(this);
    this.onPlay = this.onPlay.bind(this);
    this.onPause = this.onPause.bind(this);
    this.executePlayTimer = this.executePlayTimer.bind(this);
  }

  componentDidUpdate(prevProps) {
    if (JSON.stringify(prevProps.segmentIndices) !== JSON.stringify(this.props.segmentIndices)) {
      this.setState({
        seekedBarStyle: RouteSeeker.zeroSeekedBarStyle,
        markerStyle: RouteSeeker.hiddenMarkerStyle,
        ratio: 0
      });
    } else if (this.props.videoLength && prevProps.videoLength !== this.props.videoLength) {
      // adjust ratio in line with new videoLength
      const secondsSeeked = this.state.ratio * prevProps.videoLength;
      const newRatio = secondsSeeked / this.props.videoLength;
      this.updateSeekedBar(newRatio);
    }

    if (prevProps.nearestFrameTime !== this.props.nearestFrameTime) {
      const newRatio = this.props.segmentProgress(this.props.nearestFrameTime);
      this.updateSeekedBar(newRatio);
    }

    if (prevProps.playing !== this.props.isPlaying) {
      if (this.props.playing && !this.state.isPlaying) {
        this.onPlay();
      } else if (!this.props.playing && this.state.isPlaying) {
        this.onPause();
      }
    }
  }

  componentWillUnmount() {
    window.cancelAnimationFrame(this.playTimer);
  }

  mouseEventXOffsetPercent(e) {
    const rect = this.progressBar.getBoundingClientRect();
    const x = e.clientX - rect.left;

    return 100 * (x / this.progressBar.offsetWidth);
  }

  updateDraggingSeek = debounce((ratio) => this.props.onUserSeek(ratio), 250);

  onMouseMove(e) {
    const markerOffsetPct = this.mouseEventXOffsetPercent(e);
    if (markerOffsetPct < 0) {
      this.onMouseLeave();
      return;
    }
    const { markerWidth } = RouteSeeker;

    const markerLeft = `calc(${markerOffsetPct}% - ${markerWidth / 2}px)`;
    const markerStyle = {
      display: '',
      left: markerLeft
    };
    const { tooltipWidth } = RouteSeeker;
    const tooltipLeft = `calc(${markerOffsetPct}% - ${tooltipWidth / 2}px)`;

    const tooltipStyle = { display: 'flex', left: tooltipLeft };
    const ratio = Math.max(0, markerOffsetPct / 100);
    if (this.state.isDragging) {
      this.updateSeekedBar(ratio);
      this.updateDraggingSeek(ratio);
    }

    this.setState({
      markerStyle,
      tooltipStyle,
      tooltipTime: this.props.ratioTime(ratio).toFixed(3)
    });
  }

  onMouseLeave(e) {
    this.setState({
      markerStyle: RouteSeeker.hiddenMarkerStyle,
      tooltipStyle: RouteSeeker.hiddenTooltipStyle,
      isDragging: false
    });
  }

  updateSeekedBar(ratio) {
    const seekedBarStyle = { width: `${100 * ratio}%` };
    this.setState({ seekedBarStyle, ratio });
  }

  onClick(e) {
    let ratio = this.mouseEventXOffsetPercent(e) / 100;
    ratio = Math.min(1, Math.max(0, ratio));
    this.updateSeekedBar(ratio);
    this.props.onUserSeek(ratio);
  }

  onPlay() {
    this.playTimer = window.requestAnimationFrame(this.executePlayTimer);
    let { ratio } = this.state;
    if (ratio >= 1) {
      ratio = 0;
    }
    this.setState({ isPlaying: true, ratio });
    this.props.onPlay();
  }

  executePlayTimer() {
    const { videoElement } = this.props;
    const hasSegment = this.props.segment && this.props.segment.length === 2;
    const segmentStart = hasSegment
      ? this.props.segment[0]
      : (this.props.startTime || 0);
    const segmentLength = hasSegment
      ? this.props.segment[1] - this.props.segment[0]
      : this.props.videoLength;
    if (segmentLength <= 0) {
      this.playTimer = window.requestAnimationFrame(this.executePlayTimer);
      return;
    }

    if (videoElement === null && this.props.videoLength > 0) {
      // CSV playback without video
      const now = Date.now();
      if (!this.lastPlayTime) {
        this.lastPlayTime = now;
      }
      const elapsed = ((now - this.lastPlayTime) / 1000) * (this.props.playSpeed || 1);
      this.lastPlayTime = now;
      
      const effectiveLength = segmentLength;
      const startOffset = segmentStart;
      
      let newRatio = this.state.ratio + (elapsed / effectiveLength);
      if (newRatio >= 1) {
        newRatio = 0;
        this.lastPlayTime = now;
        this.setState({ ratio: 0 });
      }
      this.updateSeekedBar(newRatio);
      const seekTime = startOffset + (newRatio * effectiveLength);
      this.props.onPlaySeek(seekTime);
      this.playTimer = window.requestAnimationFrame(this.executePlayTimer);
      return;
    }
    
    if (videoElement === null) {
      this.playTimer = window.requestAnimationFrame(this.executePlayTimer);
      return;
    }

    let { currentTime } = videoElement;

    currentTime = roundTime(currentTime);
    const startTime = roundTime(segmentStart);
    const videoLength = roundTime(segmentLength || this.props.videoLength);

    let newRatio = (currentTime - startTime) / videoLength;

    if (newRatio === this.state.ratio) {
      this.playTimer = window.requestAnimationFrame(this.executePlayTimer);
      return;
    }

    if (newRatio >= 1 || newRatio < 0) {
      newRatio = 0;
      currentTime = startTime;
      if (videoElement.currentTime !== startTime) {
        videoElement.currentTime = startTime;
      }
      this.props.onUserSeek(newRatio);
    }

    if (newRatio >= 0) {
      this.updateSeekedBar(newRatio);
      this.props.onPlaySeek(currentTime);
    }

    this.playTimer = window.requestAnimationFrame(this.executePlayTimer);
  }

  onPause() {
    window.cancelAnimationFrame(this.playTimer);
    this.setState({ isPlaying: false });
    this.props.onPause();
  }

  onMouseDown() {
    if (!this.state.isDragging) {
      this.setState({ isDragging: true });
    }
  }

  onMouseUp() {
    if (this.state.isDragging) {
      this.setState({ isDragging: false });
    }
  }

  render() {
    const { seekedBarStyle, markerStyle, tooltipStyle } = this.state;
    return (
      <div className="cabana-explorer-visuals-camera-seeker">
        <PlayButton
          className="cabana-explorer-visuals-camera-seeker-playbutton"
          onPlay={this.onPlay}
          onPause={this.onPause}
          isPlaying={this.state.isPlaying}
        />
        <div
          className="cabana-explorer-visuals-camera-seeker-progress"
          onMouseMove={this.onMouseMove}
          onMouseLeave={this.onMouseLeave}
          onMouseDown={this.onMouseDown}
          onMouseUp={this.onMouseUp}
          onClick={this.onClick}
          ref={(ref) => (this.progressBar = ref)}
        >
          <div
            className="cabana-explorer-visuals-camera-seeker-progress-tooltip"
            style={tooltipStyle}
          >
            {this.state.tooltipTime}
          </div>
          <div
            className="cabana-explorer-visuals-camera-seeker-progress-marker"
            style={markerStyle}
          />
          <div
            className="cabana-explorer-visuals-camera-seeker-progress-inner"
            style={seekedBarStyle}
          />
        </div>
      </div>
    );
  }
}

function roundTime(time) {
  return Math.round(time * 1000) / 1000;
}
