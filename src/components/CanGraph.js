import React, { Component } from 'react';
import Measure from 'react-measure';
import PropTypes from 'prop-types';
import cx from 'classnames';
import { Vega } from 'react-vega';

import Signal from '../models/can/signal';
import GraphData from '../models/graph-data';
import CanPlotSpec from '../vega/CanPlot';
import debounce from '../utils/debounce';

const DefaultPlotInnerStyle = {
  position: 'absolute',
  top: 0,
  left: 0
};

export default class CanGraph extends Component {
  static emptyTable = [];

  static propTypes = {
    plottedSignal: PropTypes.string,
    messages: PropTypes.object,
    messageId: PropTypes.string,
    messageName: PropTypes.string,
    signalSpec: PropTypes.instanceOf(Signal),
    segment: PropTypes.array,
    unplot: PropTypes.func,
    onRelativeTimeClick: PropTypes.func,
    currentTime: PropTypes.number,
    onSegmentChanged: PropTypes.func,
    onDragStart: PropTypes.func,
    onDragEnd: PropTypes.func,
    container: PropTypes.object,
    dragPos: PropTypes.object,
    canReceiveGraphDrop: PropTypes.bool,
    onGraphRefAvailable: PropTypes.func,
    plottedSignals: PropTypes.array,
    colorOverrides: PropTypes.object,
    onColorRandomize: PropTypes.func
  };

  constructor(props) {
    super(props);

    const initialData = this.getGraphData(props);
    const initialYDomain = initialData.yDomain;

    this.state = {
      plotInnerStyle: null,
      shiftX: 0,
      shiftY: 0,
      bounds: null,
      isDataInserted: false,
      data: initialData,
      yDomain: initialYDomain,
      userYDomain: null,
      spec: this.getGraphSpec(props, initialYDomain)
    };
    this.onNewView = this.onNewView.bind(this);
    this.onSignalClickTime = this.onSignalClickTime.bind(this);
    this.onSignalSegment = this.onSignalSegment.bind(this);
    this.onDragAnchorMouseDown = this.onDragAnchorMouseDown.bind(this);
    this.onDragAnchorMouseUp = this.onDragAnchorMouseUp.bind(this);
    this.onDragStart = this.onDragStart.bind(this);
    this.onPlotResize = this.onPlotResize.bind(this);
    this.insertData = this.insertData.bind(this);
    this.resetYZoom = this.resetYZoom.bind(this);
    this.zoomYAxis = this.zoomYAxis.bind(this);
    this.panYAxis = this.panYAxis.bind(this);
    this.zoomXAxis = this.zoomXAxis.bind(this);
    this.currentValueForSignal = this.currentValueForSignal.bind(this);
    this.formatValue = this.formatValue.bind(this);
    this.getColorsForSignal = this.getColorsForSignal.bind(this);
    this.colorKey = this.colorKey.bind(this);
  }

  colorKey(messageId, signalUid) {
    return `${messageId}::${signalUid}`;
  }

  getColorsForSignal(messageId, signalUid, signal) {
    const key = this.colorKey(messageId, signalUid);
    if (this.props.colorOverrides && this.props.colorOverrides[key]) {
      return this.props.colorOverrides[key];
    }
    return signal.getColors(messageId);
  }

  getGraphData(props) {
    let firstRelTime = -1;
    let lastRelTime = -1;
    let minY = Infinity;
    let maxY = -Infinity;
    let allSeries = props.plottedSignals
      .map((signals) => {
        const { messageId, signalUid } = signals;
        const { entries } = props.messages[messageId];
        if (entries.length) {
          let messageRelTime = entries[0].relTime;
          if (firstRelTime === -1) {
            firstRelTime = messageRelTime;
          } else {
            firstRelTime = Math.min(firstRelTime, messageRelTime);
          }
          messageRelTime = entries[entries.length - 1].relTime;
          lastRelTime = Math.max(lastRelTime, messageRelTime);
        }
        const signal = Object.values(props.messages[messageId].frame.signals)
          .find((s) => s.uid === signalUid);
        const overrideColors = signal
          ? this.getColorsForSignal(messageId, signalUid, signal)
          : null;
        return GraphData._calcGraphData(
          props.messages[messageId],
          signalUid,
          0,
          overrideColors
        );
      })
      .filter((v) => Array.isArray(v))
      .reduce((m, v) => m.concat(v), []);

    // Sort all series by relTime to fix jittery lines
    allSeries.sort((a, b) => a.relTime - b.relTime);

    allSeries.forEach(({ y }) => {
      if (!Number.isNaN(y)) {
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    });

    return {
      updated: Date.now(),
      series: allSeries,
      firstRelTime,
      lastRelTime,
      yDomain: this.expandYDomain(minY, maxY)
    };
  }

  expandYDomain(minY, maxY) {
    if (!Number.isFinite(minY) || !Number.isFinite(maxY)) {
      return [-1, 1];
    }

    if (minY === maxY) {
      const pad = Math.max(Math.abs(minY) * 0.1, 1);
      return [minY - pad, maxY + pad];
    }

    const span = maxY - minY;
    const pad = Math.max(span * 0.05, Number.EPSILON);
    return [minY - pad, maxY + pad];
  }

  currentYDomain(dataOverride) {
    const domain = this.state.userYDomain
      || (dataOverride ? dataOverride.yDomain : this.state.yDomain);
    if (!domain || domain.length !== 2) {
      return [-1, 1];
    }
    return domain;
  }

  applyYDomainToView(domain) {
    if (this.view && domain) {
      this.view.signal('yDomain', domain);
      this.view.runAsync();
    }
  }

  zoomYAxis(factor) {
    const domain = this.currentYDomain();
    const span = Math.max(domain[1] - domain[0], Number.EPSILON);
    const newSpan = span * factor;
    const center = (domain[0] + domain[1]) / 2;
    const newDomain = [center - newSpan / 2, center + newSpan / 2];

    this.setState({
      userYDomain: newDomain
    }, () => {
      this.applyYDomainToView(newDomain);
    });
  }

  zoomXAxis(factor) {
    const domain = this.computeSegmentDomain(this.props, this.state.data);
    if (!Array.isArray(domain) || domain.length !== 2) {
      return;
    }

    const [start, end] = domain;
    const span = Math.max(end - start, Number.EPSILON);
    const currentTime = Number(this.props.currentTime);
    const center = Number.isFinite(currentTime)
      ? currentTime
      : (start + end) / 2;
    const newSpan = span * factor;

    let newStart = center - (newSpan / 2);
    let newEnd = center + (newSpan / 2);

    const min = Number.isFinite(this.state.data.firstRelTime)
      ? this.state.data.firstRelTime
      : 0;
    const max = Number.isFinite(this.state.data.lastRelTime)
      ? this.state.data.lastRelTime
      : null;

    if (Number.isFinite(max) && max > min) {
      if (newSpan >= max - min) {
        newStart = min;
        newEnd = max;
      } else {
        if (newStart < min) {
          newEnd += (min - newStart);
          newStart = min;
        }
        if (newEnd > max) {
          newStart -= (newEnd - max);
          newEnd = max;
        }
      }
    }

    this.props.onSegmentChanged(this.props.messageId, [newStart, newEnd]);
  }

  resetYZoom() {
    const domain = this.state.yDomain || [-1, 1];
    this.setState({
      userYDomain: null
    }, () => {
      this.applyYDomainToView(domain);
    });
  }

  panYAxis(direction = 1) {
    const domain = this.currentYDomain();
    const span = Math.max(domain[1] - domain[0], Number.EPSILON);
    const shift = span * 0.1 * direction;
    const newDomain = [domain[0] + shift, domain[1] + shift];

    this.setState({ userYDomain: newDomain }, () => {
      this.applyYDomainToView(newDomain);
    });
  }

  currentValueForSignal(messageId, signal) {
    const msg = this.props.messages[messageId];
    if (!msg || !msg.entries || msg.entries.length === 0 || !signal) {
      return null;
    }

    const t = Number(this.props.currentTime);
    if (!Number.isFinite(t)) {
      return null;
    }

    const entries = msg.entries;
    // binary search for closest relTime
    let lo = 0;
    let hi = entries.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (entries[mid].relTime <= t) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    const candLo = entries[lo];
    const candHi = entries[hi] || candLo;
    const nearest = Math.abs((candLo && candLo.relTime) - t) <= Math.abs((candHi && candHi.relTime) - t)
      ? candLo
      : candHi;

    if (!nearest || nearest.signals[signal.name] === undefined || nearest.signals[signal.name] === null) {
      return null;
    }
    const raw = nearest.signals[signal.name];
    return typeof raw === 'bigint' ? Number(raw) : Number(raw);
  }

  formatValue(val, unit) {
    if (val === null || val === undefined || Number.isNaN(val)) return '--';
    const abs = Math.abs(val);
    let formatted;
    if (abs >= 1000) {
      formatted = val.toFixed(0);
    } else if (abs >= 10) {
      formatted = val.toFixed(2);
    } else if (abs >= 1) {
      formatted = val.toFixed(3);
    } else {
      formatted = val.toFixed(4);
    }
    return unit ? `${formatted} ${unit}` : formatted;
  }

  getGraphSpec(props, yDomain) {
    const scales = [...CanPlotSpec.scales];

    const signals = CanPlotSpec.signals.map((signalSpec) => {
      if (signalSpec.name === 'yDomain') {
        return {
          ...signalSpec,
          value: yDomain || signalSpec.value
        };
      }
      return signalSpec;
    });

    return {
      ...CanPlotSpec,
      scales,
      signals
    };
  }

  debugLog() {}

  segmentIsNew(newSegment) {
    return (
      newSegment.length !== this.props.segment.length
      || !newSegment.every((val, idx) => this.props.segment[idx] === val)
    );
  }

  visualChanged(prevProps, nextProps) {
    return (
      prevProps.canReceiveGraphDrop !== nextProps.canReceiveGraphDrop
      || JSON.stringify(prevProps.dragPos) !== JSON.stringify(nextProps.dragPos)
    );
  }

  onPlotResize(options) {
    if (!this.view) {
      return;
    }

    let bounds = null; // eslint-disable-line no-unused-vars
    if (options && options.bounds) {
      this.setState({ bounds: options.bounds });
      bounds = options.bounds;
    } else {
      bounds = this.state.bounds;
    }

    this.view.runAfter(this.updateBounds);
  }

  updateBounds = debounce(() => {
    this.view.signal('width', this.state.bounds.width - 90);
    this.view.signal('height', 0.4 * (this.state.bounds.width - 40)); // 5:2 aspect ratio

    this.view.run();
  }, 100);

  computeSegmentDomain(props = this.props, data = this.state.data) {
    const hasSegment = props.segment && props.segment.length === 2;
    if (hasSegment) {
      this.debugLog('segment domain (brush)', {
        domain: props.segment,
        currentTime: props.currentTime
      });
      return props.segment;
    }

    const lastTime = data ? data.lastRelTime : 0;
    const currentTimeNum = Number(props.currentTime);
    const t = Number.isFinite(currentTimeNum) ? currentTimeNum : lastTime;
    const windowSize = 60;

    if (t > windowSize) {
      const domain = [t - windowSize, t];
      this.debugLog('segment domain (auto sliding)', {
        domain,
        currentTime: currentTimeNum,
        lastTime
      });
      return domain;
    }

    const cappedLastTime = Number.isFinite(lastTime) ? lastTime : 0;
    const cappedT = Number.isFinite(t) ? t : 0;
    const upper = Math.min(windowSize, Math.max(cappedT, cappedLastTime, 0)) || windowSize;
    const domain = [0, upper];
    this.debugLog('segment domain (start window)', {
      domain,
      currentTime: currentTimeNum,
      lastTime
    });
    return domain;
  }

  insertData = debounce(() => {
    if (!this.view) {
      return;
    }

    const { series } = this.state.data;
    const changeset = this.view
      .changeset()
      .remove((v) => true)
      .insert(series);
    this.view.change('table', changeset);
    this.view.run();
  }, 250);

  componentDidUpdate(prevProps) {
    if (this.props.dragPos && JSON.stringify(prevProps.dragPos) !== JSON.stringify(this.props.dragPos)) {
      this.updateStyleFromDragPos(this.props.dragPos);
    } else if (!this.props.dragPos && this.state.plotInnerStyle !== null) {
      this.setState({ plotInnerStyle: null });
    }

    if (
      prevProps.messages !== this.props.messages
      || prevProps.plottedSignal !== this.props.plottedSignal
      || prevProps.colorOverrides !== this.props.colorOverrides
    ) {
      const data = this.getGraphData(this.props);
      const nextYDomain = this.state.userYDomain || data.yDomain;

      this.setState({
        data,
        yDomain: data.yDomain,
        spec: this.view ? this.state.spec : this.getGraphSpec(this.props, nextYDomain)
      }, () => {
        this.applyYDomainToView(nextYDomain);
      });
    }

    if (prevProps.currentTime !== this.props.currentTime && this.view) {
      const domain = this.computeSegmentDomain(this.props, this.state.data);
      this.view.signal('segment', domain);
      this.view.signal('videoTime', this.props.currentTime);
      this.view.runAsync();
    }
    if (this.segmentIsNew(this.props.segment)) {
      this.setState({
        spec: this.getGraphSpec(this.props, this.currentYDomain())
      });
    }

    if (this.view) {
      const domain = this.computeSegmentDomain(this.props, this.state.data);
      if (this.props.currentTime !== undefined && this.props.currentTime !== prevProps.currentTime) {
        this.debugLog('currentTime change', {
          currentTime: this.props.currentTime,
          domain
        });
      }
      this.view.signal('segment', domain);
      if (this.props.currentTime !== undefined) {
        this.view.signal('videoTime', this.props.currentTime);
      }
      this.view.runAsync();
    }
  }

  shouldComponentUpdate() {
    return true;
  }

  updateStyleFromDragPos({ left, top }) {
    const plotInnerStyle = { ...this.state.plotInnerStyle };
    plotInnerStyle.left = left;
    plotInnerStyle.top = top;
    this.setState({ plotInnerStyle });
  }

  onNewView(view) {
    this.view = view;

    if (this.state.bounds) {
      this.onPlotResize();
    }
    this.applyYDomainToView(this.currentYDomain());
    const domain = this.computeSegmentDomain(this.props, this.state.data);
    this.debugLog('onNewView domain init', domain);
    view.signal('segment', domain);
    view.signal('videoTime', this.props.currentTime);

    this.insertData();
  }

  onSignalClickTime(signal, clickTime) {
    // console.log('onSignalClickTime', signal, clickTime);
    if (clickTime !== undefined) {
      this.props.onRelativeTimeClick(this.props.messageId, clickTime);
    }
  }

  onSignalSegment(signal, segment) {
    // console.log('onSignalSegment', signal, segment);
    if (!Array.isArray(segment) || segment.length !== 2) {
      return;
    }

    const cleanedSegment = segment
      .map((v) => Number(v))
      .filter((v) => Number.isFinite(v))
      .sort((a, b) => a - b);

    if (cleanedSegment.length !== 2 || cleanedSegment[0] === cleanedSegment[1]) {
      return;
    }

    const autoDomain = this.computeSegmentDomain(this.props, this.state.data);
    if (Array.isArray(autoDomain) && autoDomain.length === 2) {
      const [a0, a1] = autoDomain;
      const [s0, s1] = cleanedSegment;
      const eps = 1e-6;
      if (Math.abs(a0 - s0) < eps && Math.abs(a1 - s1) < eps) {
        // ignore programmatic segment updates used to keep the window in sync
        return;
      }
    }

    this.props.onSegmentChanged(this.props.messageId, cleanedSegment);

    if (!this.view) {
      return;
    }

    this.view.runAfter(() => {
      const state = this.view.getState();
      state.subcontext[0].signals.brush = 0;
      this.view.setState(state);
      this.insertData();
    });
  }

  plotInnerStyleFromMouseEvent(e) {
    const { shiftX, shiftY } = this.state;
    const plotInnerStyle = { ...DefaultPlotInnerStyle };
    const rect = this.props.container.getBoundingClientRect();

    const x = e.clientX - rect.left - shiftX;
    const y = e.clientY - rect.top - shiftY;
    plotInnerStyle.left = x;
    plotInnerStyle.top = y;
    return plotInnerStyle;
  }

  onDragAnchorMouseDown(e) {
    e.persist();
    const shiftX = e.clientX - e.target.getBoundingClientRect().left;
    const shiftY = e.clientY - e.target.getBoundingClientRect().top;
    this.setState({ shiftX, shiftY }, () => {
      this.setState({ plotInnerStyle: this.plotInnerStyleFromMouseEvent(e) });
    });
    this.props.onDragStart(
      this.props.messageId,
      this.props.signalSpec.uid,
      shiftX,
      shiftY
    );
  }

  onDragAnchorMouseUp(e) {
    this.props.onDragEnd();
    this.setState({
      plotInnerStyle: null,
      shiftX: 0,
      shiftY: 0
    });
  }

  onDragStart(e) {
    e.preventDefault();
    return false;
  }

  render() {
    const { plotInnerStyle } = this.state;
    const canReceiveDropClass = this.props.canReceiveGraphDrop
      ? 'is-droppable'
      : null;

    return (
      <div
        className="cabana-explorer-visuals-plot"
        ref={this.props.onGraphRefAvailable}
      >
        <div
          className={cx(
            'cabana-explorer-visuals-plot-inner',
            canReceiveDropClass
          )}
          style={plotInnerStyle || null}
        >
          <div
            className="cabana-explorer-visuals-plot-draganchor"
            onMouseDown={this.onDragAnchorMouseDown}
          >
            <span className="fa fa-bars" />
          </div>
          {this.props.plottedSignals.map(
            ({ messageId, signalUid, messageName }) => {
              const signal = Object.values(
                this.props.messages[messageId].frame.signals
              ).find((s) => s.uid === signalUid);
              const colors = signal
                ? this.getColorsForSignal(messageId, signalUid, signal)
                : [128, 128, 128];

              return (
                <div
                  className="cabana-explorer-visuals-plot-header"
                  key={`${messageId}_${signal.uid}`}
                >
                  <div className="cabana-explorer-visuals-plot-header-toggle">
                    <button
                      className="button--tiny"
                      onClick={() => this.props.unplot(messageId, signalUid)}
                    >
                      <span>Hide Plot</span>
                    </button>
                  </div>
                  <div className="cabana-explorer-visuals-plot-header-copy">
                    <div className="cabana-explorer-visuals-plot-message">
                      <span>
                        {messageName}
                        {' '}
                        {messageId}
                      </span>
                    </div>
                    <div className="cabana-explorer-visuals-plot-signal">
                      <div
                        className="cabana-explorer-visuals-plot-signal-color"
                        style={{ background: `rgb(${colors}` }}
                        onClick={() => {
                          if (this.props.onColorRandomize) {
                            this.props.onColorRandomize(messageId, signalUid);
                          }
                        }}
                        title="Click to randomize color"
                      />
                      <strong>{signal.name}</strong>
                      <span className="cabana-explorer-visuals-plot-signal-value">
                        {this.formatValue(
                          this.currentValueForSignal(messageId, signal),
                          signal.unit
                        )}
                      </span>
                    </div>
                  </div>
                </div>
              );
            }
          )}
          <Measure bounds onResize={this.onPlotResize}>
            {({ measureRef }) => (
              <div
                ref={measureRef}
                className="cabana-explorer-visuals-plot-container"
              >
                <Vega
                  onNewView={this.onNewView}
                  logLevel={1}
                  signalListeners={{
                    clickTime: this.onSignalClickTime,
                    segment: this.onSignalSegment
                  }}
                  renderer="canvas"
                  spec={this.state.spec}
                  actions={false}
                  data={{
                    table: this.state.data.series
                  }}
                />
              </div>
            )}
          </Measure>
          <div
            className="cabana-explorer-visuals-plot-controls"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              gap: 12,
              marginTop: 10
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span className="t-smallcaps">X Zoom</span>
              <div
                className="cabana-explorer-visuals-plot-controls-group"
                style={{ display: 'flex', gap: 8 }}
              >
                <button
                  className="button--tiny"
                  onClick={() => this.zoomXAxis(0.5)}
                  style={{ minWidth: 32, paddingLeft: 10, paddingRight: 10 }}
                >
                  +
                </button>
                <button
                  className="button--tiny"
                  onClick={() => this.zoomXAxis(2)}
                  style={{ minWidth: 32, paddingLeft: 10, paddingRight: 10 }}
                >
                  -
                </button>
              </div>
              <span className="t-smallcaps">Y Zoom</span>
              <div
                className="cabana-explorer-visuals-plot-controls-group"
                style={{ display: 'flex', gap: 8 }}
              >
                <button
                  className="button--tiny"
                  onClick={() => this.zoomYAxis(0.5)}
                  style={{ minWidth: 32, paddingLeft: 10, paddingRight: 10 }}
                >
                  +
                </button>
                <button
                  className="button--tiny"
                  onClick={() => this.zoomYAxis(2)}
                  style={{ minWidth: 32, paddingLeft: 10, paddingRight: 10 }}
                >
                  -
                </button>
              </div>
              <span className="t-smallcaps">Y Pan</span>
              <div
                className="cabana-explorer-visuals-plot-controls-group"
                style={{ display: 'flex', gap: 8 }}
              >
                <button
                  className="button--tiny"
                  onClick={() => this.panYAxis(1)}
                  style={{ minWidth: 32, paddingLeft: 10, paddingRight: 10 }}
                >
                  ↑
                </button>
                <button
                  className="button--tiny"
                  onClick={() => this.panYAxis(-1)}
                  style={{ minWidth: 32, paddingLeft: 10, paddingRight: 10 }}
                >
                  ↓
                </button>
              </div>
            </div>
            <div style={{ marginLeft: 'auto' }}>
              <button
                className="button--tiny"
                onClick={this.resetYZoom}
              >
                Reset
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }
}
