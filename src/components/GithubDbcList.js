import React, {Component} from 'react';
import { StyleSheet, css } from 'aphrodite/no-important';
import PropTypes from 'prop-types';

import OpenDbc from '../api/opendbc';

export default class GithubDbcList extends Component {
  static propTypes = {
    onDbcLoaded: PropTypes.func.isRequired,
    repo: PropTypes.string.isRequired,
    openDbcClient: PropTypes.instanceOf(OpenDbc).isRequired
  };

  constructor(props){
    super(props);

    this.state = {
      paths: [],
      selectedPath: null,
    };

    this.rowForPath = this.rowForPath.bind(this);
  }

  componentWillReceiveProps(nextProps) {
    if(nextProps.repo != this.props.repo) {
        this.props.openDbcClient.list(nextProps.repo).then((paths) => {
          this.setState({paths, selectedPath: null})
        })
    }
  }

  componentWillMount() {
    this.props.openDbcClient.list(this.props.repo).then((paths) => {
      paths = paths.filter((path) => path.indexOf(".dbc") !== -1);
      this.setState({paths})
    })
  }

  selectPath(path) {
    this.setState({selectedPath: path})
    this.props.openDbcClient.getDbcContents(path, this.props.repo).then((dbcContents) => {
      this.props.onDbcLoaded(path, dbcContents);
    })
  }

  rowForPath(path) {
    const textClassName = this.state.selectedPath === path ? css(Styles.selectedPath) : null
    return (<div
                 key={path}
                 className={css(Styles.row)}
                 onClick={() => {this.selectPath(path)}}>
              <p className={textClassName}>{path}</p>
            </div>);
  }

  render() {
    return (<div className={css(Styles.root)}>
              <p className={css(Styles.repoName)}><a href={`https://github.com/${this.props.repo}`}
                                                     target={"_blank"}
                                                     className={css(Styles.repoLink)}>{this.props.repo}</a></p>
              <input className={css(Styles.search)} type="text" />
              <div className={css(Styles.list)}>
                {this.state.paths.map(this.rowForPath)}
              </div>
            </div>)
  }
}

const Styles = StyleSheet.create({
  repoName: {
    paddingBottom: 10
  },
  repoLink: {
    color: 'inherit',
    ':hover': {textDecoration: 'underline'},
    ':visited': {
      color: 'inherit'
    }
  },
  row: {
    width: '100%',
    borderBottom: '1px solid black',
    cursor: 'pointer',
    paddingTop: 10,
    paddingBottom: 10
  },
  selectedPath: {
    fontWeight: 'bold'
  }
})
