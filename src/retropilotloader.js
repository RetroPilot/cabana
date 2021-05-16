import Moment from 'moment';
import CorollaDBC from './corolla-dbc';

export async function loadRetropilotDrive(retropilotHost, driveIdentifier, seekTime) {
  if (driveIdentifier == null || !driveIdentifier.length) {
    global.retropilotLoaded = false;
    return;
  }

  const response = await fetch(retropilotHost + 'useradmin/cabana_drive/' + encodeURIComponent(driveIdentifier));
  let retropilotDrive;
  try {
    retropilotDrive = await response.json();
  } catch (exception) {}

  if (!retropilotDrive || !retropilotDrive.logUrls) {
    alert(retropilotDrive && retropilotDrive.status ? retropilotDrive.status : 'fetching retropilot drive failed!');
    global.retropilotLoaded = false;
    return;
  }
  global.retropilotLogUrls = retropilotDrive.logUrls;

  global.retropilotProps = {
    autoplay: true,
    startTime: seekTime,
    segments: global.retropilotLogUrls.length,
    isDemo: true,
    max: global.retropilotLogUrls.length,
    name: retropilotDrive.driveIdentifier,
    dongleId: retropilotDrive.dongleId,
    dbc: CorollaDBC,
    dbcFilename: 'toyota_nodsu_pt_generated.dbc'
  };

  global.retropilotRoute = {
    fullname: retropilotDrive.name,
    proclog: global.retropilotProps.max,
    start_time: Moment(global.retropilotProps.name, 'YYYY-MM-DD--H-m-s'),
    url: retropilotDrive.driveUrl
  };

  global.retropilotLoaded = global.retropilotProps.max > 0;
}
