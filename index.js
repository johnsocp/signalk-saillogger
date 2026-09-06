/*
 * Copyright 2019-2023 Ilker Temir <ilker@ilkertemir.com>
 * Copyright 2023-2024 Saillogger LLC <info@saillogger.com>
 * Copyright 2026 entropysaillog (fork)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/*
 * Fork of signalk-saillogger, repointed at the entropysaillog ingest endpoint.
 * It collects position / SOG / COG from Signal K, buffers through connectivity
 * dropouts, and pushes batches to POST /ingest using the versioned wire contract
 * with x-api-key auth and a DURABLE, restart-safe batch idempotency id (see
 * lib/payload.js). The saillogger-specific metadata / AIS / monitoring-config
 * push paths are intentionally removed — this fork only feeds the tracker.
 */

const POLL_INTERVAL = 5      // Poll position every N seconds
const SUBMIT_INTERVAL = 1    // Flush the buffer to the server every N minutes
const BATCH_LIMIT = 500      // Max points per push (ingest contract caps at 1000)

const fs = require('fs')
const filePath = require('path')
const { postJson } = require('./lib/http.js')
const { BufferStore } = require('./lib/storage')
const { buildBatch, COURSE_MAX_AGE_MS } = require('./lib/payload')
const { sign } = require('./lib/auth')
const package = require('./package.json');
const userAgent = `entropysaillog plugin v${package.version}`;

module.exports = function(app) {
  var plugin = {};
  var unsubscribes = [];
  var queueLength = 0;
  var submitDataProcess;
  var bufferStore;
  var endpoint;
  var apiKey;
  var secret;
  var gpsSource;
  var configuration;
  var updateLastCalled;
  var dBInsertInProgress = false;
  var lastSuccessfulUpdate;
  var submitLastCalled;
  var position;
  var speedOverGround;
  var maxSpeedOverGround = 0;
  var courseOverGroundTrue;
  var windSpeedApparent = 0;
  var angleSpeedApparent;
  var windSpeedTrue;
  var windDirectionTrue;
  var portEngineHours;
  var starboardEngineHours;
  var previousSpeeds = [];
  var previousCOGs = [];
  // Active-route snapshots from the plotter, one per course path. Great circle
  // is preferred; rhumbline is only used when great circle is missing or stale.
  var courseSnapshots = {};
  // Set when a route goes from a real next point to null, cleared once the
  // server has accepted the batch that carried next_waypoint: null.
  var courseClearPending = false;
  // href -> resolved waypoint name (or null when it could not be resolved).
  var waypointNames = {};

  plugin.id = "signalk-saillogger";
  plugin.name = "Entropy Sail Log";
  plugin.description = "Pushes Signal K position data to the entropysaillog tracker ingest";

  plugin.start = function(options) {
    configuration = options;
    startPlugin(options);
  }

  plugin.stop = function() {
    app.debug(`Stopping the plugin`);
    clearInterval(submitDataProcess);
  };

  plugin.schema = {
    type: 'object',
    required: ['endpoint'],
    properties: {
      endpoint: {
        type: "string",
        title: "Ingest URL",
        description: "POST /ingest endpoint, e.g. https://xxxxx.execute-api.<region>.amazonaws.com/ingest"
      },
      secret: {
        type: "string",
        title: "HMAC signing secret (recommended)",
        description: "Signs each push with x-timestamp + x-signature. Preferred auth; set this and leave API key empty."
      },
      apiKey: {
        type: "string",
        title: "API key (optional fallback)",
        description: "Sent as x-api-key. Only used if no HMAC secret is set. Provide a secret OR an API key."
      },
      source: {
        type: "string",
        title: "GPS source (optional; leave empty if unsure)"
      }
    }
  }

  function startPlugin(options) {
    app.debug(`Running on ${findPlatform()}`);

    endpoint = options.endpoint;
    apiKey = options.apiKey;
    secret = options.secret;
    gpsSource = options.source;

    if (!endpoint || (!apiKey && !secret)) {
      app.setPluginError('endpoint and at least one credential (secret recommended, or apiKey) are required');
      return;
    }
    app.debug(`Starting the plugin, pushing to ${endpoint}`);
    app.setPluginStatus('Entropy Sail Log started. Please wait for a status update.');

    const dataDir = app.getDataDirPath();
    bufferStore = new BufferStore(filePath.join(dataDir, 'entropysaillog_buffer.ndjson'));

    let subscription = {
      context: 'vessels.self',
      subscribe: [{
        path: 'navigation.position',
        period: POLL_INTERVAL * 1000
      }, {
        path: 'navigation.speedOverGround',
        period: POLL_INTERVAL * 1000
      }, {
        path: 'navigation.courseOverGroundTrue',
        period: POLL_INTERVAL * 1000
      }, {
        path: 'environment.wind.speedApparent',
        period: POLL_INTERVAL * 1000
      }, {
        path: 'environment.wind.angleApparent',
        period: POLL_INTERVAL * 1000
      }, {
        path: 'environment.wind.speedTrue',
        period: POLL_INTERVAL * 1000
      }, {
        path: 'environment.wind.directionTrue',
        period: POLL_INTERVAL * 1000
      }, {
        path: 'navigation.courseGreatCircle.nextPoint.position',
        period: POLL_INTERVAL * 1000
      }, {
        path: 'navigation.courseGreatCircle.nextPoint.distance',
        period: POLL_INTERVAL * 1000
      }, {
        path: 'navigation.courseGreatCircle.nextPoint.timeToGo',
        period: POLL_INTERVAL * 1000
      }, {
        path: 'navigation.courseGreatCircle.nextPoint.href',
        period: POLL_INTERVAL * 1000
      }, {
        path: 'navigation.courseRhumbline.nextPoint.position',
        period: POLL_INTERVAL * 1000
      }, {
        path: 'navigation.courseRhumbline.nextPoint.distance',
        period: POLL_INTERVAL * 1000
      }, {
        path: 'navigation.courseRhumbline.nextPoint.timeToGo',
        period: POLL_INTERVAL * 1000
      }, {
        path: 'navigation.courseRhumbline.nextPoint.href',
        period: POLL_INTERVAL * 1000
      }, {
        path: 'propulsion.port.runTime',
        period: POLL_INTERVAL * 1000
      }, {
        path: 'propulsion.starboard.runTime',
        period: POLL_INTERVAL * 1000
      }]
    };

    app.subscriptionmanager.subscribe(subscription, unsubscribes, function() {
      app.error('Subscription error');
    }, data => processDelta(data));

    updatePluginStatus();

    submitDataProcess = setInterval( function () {
      let now = Date.now();
      if ((!submitLastCalled) || (now - submitLastCalled > 2 * SUBMIT_INTERVAL * 60 * 1000)) {
        app.debug(`No data has been sent to the server since ${submitLastCalled}, submitting`);
        submitDataToServer();
      }
    }, SUBMIT_INTERVAL * 60 * 1000);
  }

  function updatePluginStatus() {
    try {
      let message;
      queueLength = bufferStore ? bufferStore.count() : 0;
      if (queueLength == 1) {
        message = `${queueLength} entry in the local cache,`;
      } else {
        message = `${queueLength} entries in the local cache,`;
      }
      if (lastSuccessfulUpdate) {
        let since = timeSince(lastSuccessfulUpdate);
        message += ` last connection to the server was ${since}.`;
      } else {
        message += ` no successful connection to the server since restart.`;
      }
      app.setPluginStatus(message);
    } catch (err) {
      app.debug('Error querying the local cache:', err);
    }
  }

  function isVenusOS() {
    return (fs.existsSync('/etc/venus'));
  }

  function getVictronDeviceModel() {
    if (!isVenusOS()) {
      return (null);
    }
    var name;
    try {
      name = require('child_process').execSync('/usr/bin/product-name', {stdio : 'pipe' }).toLocaleString()
    } catch {
      name = null;
    }
    return name;
  }

  // Find the platform we are running on
  function findPlatform() {
    if ( isVenusOS() ) {
      let platform = `Victron ${getVictronDeviceModel()}`;
      return platform;
    }

    let platform = '';
    try {
      const cpuInfo = fs.readFileSync('/proc/cpuinfo', { encoding: 'utf8', flag: 'r' });
      let re = /Model\s*:\s*([^\n]+)/i;
      let found = cpuInfo.match(re);
      if (found) {
        platform += found[1];
      }
      re = /Model Name\s*:\s*([^\n]+)/i;
      found = cpuInfo.match(re);
      if (found) {
        platform += ' ' + found[1];
      }
    } catch (err) {
      app.debug('Cannot find /proc/cpuinfo');
    }
    return platform;
  }

  function updateDatabase() {
    if ((!position) || (!position.changedOn)) {
      return
    }

    let timeSinceLastUpdate;
    let dateNow = Date.now();
    if (updateLastCalled) {
      timeSinceLastUpdate = dateNow  - updateLastCalled;
    }
    if ((timeSinceLastUpdate) && (timeSinceLastUpdate < SUBMIT_INTERVAL * 60 * 1000)) {
      // Multiple GPS sources, updates coming in too frequently
      return;
    }
    updateLastCalled = dateNow;

    const row = {
      ts: position.changedOn,
      latitude: position.latitude,
      longitude: position.longitude,
      speedOverGround: maxSpeedOverGround,
      courseOverGroundTrue: courseOverGroundTrue,
      windSpeedApparent: windSpeedApparent,
      angleSpeedApparent: angleSpeedApparent,
      windSpeedTrue: windSpeedTrue,
      windDirectionTrue: windDirectionTrue,
      portEngineHours: portEngineHours,
      starboardEngineHours: starboardEngineHours,
      additionalData: null
    };

    if (!dBInsertInProgress) {
      dBInsertInProgress = true;
      try {
        bufferStore.insert(row);
        app.debug(`Inserted logging data into the local cache`);
        queueLength++;
        windSpeedApparent = 0;
        windSpeedTrue = null;
        windDirectionTrue = null;
        maxSpeedOverGround = 0;
        portEngineHours = null;
        starboardEngineHours = null;
        submitDataToServer();
      } catch (err) {
        app.debug(`Failed to insert data: ${err}`);
      } finally {
        dBInsertInProgress = false;
      }
    }
  }

  function submitDataToServer() {
    submitLastCalled = Date.now();

    let rows;
    try {
      rows = bufferStore.peek(BATCH_LIMIT);
    } catch (err) {
      app.debug('Error querying the local cache:', err);
      return;
    }

    if (!rows || rows.length === 0) {
      app.debug('Local cache is empty, nothing to submit');
      return;
    }

    const lastTs = rows[rows.length - 1].ts;
    // undefined = say nothing about the route; null = it was cleared (sent once,
    // until the server accepts it); a snapshot = upsert it (payload.js drops it
    // if it is stale).
    let course;
    const snapshot = chooseCourseSnapshot();
    if (snapshot && snapshot.cleared) {
      if (courseClearPending) course = null;
    } else if (snapshot) {
      course = snapshot;
    }
    const batch = buildBatch(rows, course);
    if (!batch) {
      // Every peeked row was an unusable fix (bad coords/timestamp). Purge them
      // so they don't wedge the queue forever.
      app.debug(`Dropping ${rows.length} unusable cached row(s)`);
      bufferStore.deleteUpTo(lastTs);
      updatePluginStatus();
      return;
    }

    app.debug(`Submitting batch ${batch.batch_id} (${batch.points.length} point(s)) of ${queueLength} cached`);

    // Serialize once so the signature covers the exact bytes we send. Re-sign on
    // every attempt (incl. retries) with the current time, so the replay window
    // is satisfied even for batches buffered through a long dropout.
    const body = JSON.stringify(batch);
    const headers = { 'User-Agent': userAgent, 'Content-Type': 'application/json' };
    if (apiKey) headers['x-api-key'] = apiKey;
    if (secret) {
      const ts = Math.floor(Date.now() / 1000).toString();
      headers['x-timestamp'] = ts;
      headers['x-signature'] = sign(secret, ts, body);
    }

    postJson(endpoint, headers, body, 45000).then(function (response) {
      if (response.statusCode == 200) {
        app.debug(`Successfully submitted batch ${batch.batch_id}`);
        if (batch.next_waypoint === null) {
          // The cleared route reached the server; stop resending the null.
          courseClearPending = false;
        }
        try {
          bufferStore.deleteUpTo(lastTs);
          lastSuccessfulUpdate = Date.now();
          const remaining = bufferStore.count();
          if (remaining > 0) {
            app.debug(`Cache not fully flushed, ${remaining} record(s) left.`);
          }
        } catch (err) {
          app.debug(`Error deleting from buffer: ${err}`);
        }
      } else if (response.statusCode == 400) {
        // Contract rejection: this batch will never be accepted as-is. Drop it
        // so it doesn't block the queue. (Should not happen — payload is built
        // to the contract; logged loudly if it does.)
        app.error(`Ingest rejected batch ${batch.batch_id} (HTTP 400): ${response.body}. Dropping.`);
        try { bufferStore.deleteUpTo(lastTs); } catch (err) { app.debug(`Error deleting: ${err}`); }
      } else {
        app.debug(`HTTP-${response.statusCode}, retry in ${SUBMIT_INTERVAL} min`);
      }
      updatePluginStatus();
    }).catch(function (error) {
      // Transport failure (connect error / timeout): keep the buffer, retry.
      app.debug(`${error && error.message ? error.message : 'Unknown error'}, retry in ${SUBMIT_INTERVAL} min`);
      updatePluginStatus();
    });
  }

  function timeSince(date) {
    var seconds = Math.floor((new Date() - date) / 1000);
    var interval = seconds / 31536000;
    if (interval > 1) {
      return Math.floor(interval) + " years ago";
    }
    interval = seconds / 2592000;
    if (interval > 1) {
      return Math.floor(interval) + " months ago";
    }
    interval = seconds / 86400;
    if (interval > 1) {
      return Math.floor(interval) + " days ago";
    }
    interval = seconds / 3600;
    if (interval > 1) {
      return Math.floor(interval) + " hours ago";
    }
    interval = seconds / 60;
    if (interval > 1) {
      return Math.floor(interval) + " minutes ago";
    }
    if (Math.floor(seconds) == 0) {
      return "few moments ago"
    }
    return Math.floor(seconds) + " seconds ago";
  }

  function radiantToDegrees(rad) {
    if (rad == null) {
      return null;
    }
    return Math.round(rad * 57.2958 * 10) / 10;
  }

  function metersPerSecondToKnots(ms) {
    if (ms == null) {
      return null;
    }
    return Math.round(ms * 1.94384 * 10) / 10;
  }

  // Prefix ('navigation.courseGreatCircle' | 'navigation.courseRhumbline') of a
  // subscribed nextPoint path.
  function coursePrefix(path) {
    return path.slice(0, path.indexOf('.nextPoint'));
  }

  // A nextPoint.position update. A null value means the route was cleared.
  function updateCoursePosition(prefix, value) {
    const previous = courseSnapshots[prefix];
    if (!value || typeof value.latitude !== 'number' || typeof value.longitude !== 'number') {
      if (previous && !previous.cleared) {
        courseClearPending = true;
      }
      courseSnapshots[prefix] = { cleared: true, changedOn: Date.now() };
      return;
    }
    const snapshot = (previous && !previous.cleared) ? previous : {};
    snapshot.cleared = false;
    snapshot.latitude = value.latitude;
    snapshot.longitude = value.longitude;
    snapshot.changedOn = Date.now();
    courseSnapshots[prefix] = snapshot;
  }

  // distance / timeToGo / href update the current snapshot in place; they do not
  // refresh changedOn (only a position fix does).
  function updateCourseField(prefix, field, value) {
    const snapshot = courseSnapshots[prefix];
    if (!snapshot || snapshot.cleared) {
      return;
    }
    snapshot[field] = value;
  }

  // Best-effort waypoint name lookup. Never blocks a push: the name is attached
  // to the snapshot if and when it resolves, and any failure is swallowed.
  function resolveWaypointName(prefix, href) {
    if (typeof href !== 'string') {
      return;
    }
    const match = href.match(/^\/resources\/waypoints\/(.+)$/);
    if (!match) {
      return;
    }
    if (href in waypointNames) {
      applyWaypointName(prefix, href, waypointNames[href]);
      return;
    }
    if (!app.resourcesApi || typeof app.resourcesApi.getResource !== 'function') {
      return;
    }
    try {
      Promise.resolve(app.resourcesApi.getResource('waypoints', match[1])).then(function (resource) {
        const name = (resource && typeof resource.name === 'string' && resource.name.length > 0)
          ? resource.name
          : null;
        waypointNames[href] = name;
        applyWaypointName(prefix, href, name);
      }).catch(function (err) {
        app.debug(`Could not resolve waypoint name for ${href}: ${err}`);
      });
    } catch (err) {
      app.debug(`Could not resolve waypoint name for ${href}: ${err}`);
    }
  }

  function applyWaypointName(prefix, href, name) {
    const snapshot = courseSnapshots[prefix];
    if (name && snapshot && !snapshot.cleared && snapshot.href === href) {
      snapshot.name = name;
    }
  }

  // Great circle wins unless it is missing or older than the contract's 5 min
  // staleness bound, in which case we fall back to rhumbline.
  function chooseCourseSnapshot() {
    const greatCircle = courseSnapshots['navigation.courseGreatCircle'];
    const rhumbline = courseSnapshots['navigation.courseRhumbline'];
    if (greatCircle && (Date.now() - greatCircle.changedOn <= COURSE_MAX_AGE_MS)) {
      return greatCircle;
    }
    if (rhumbline) {
      return rhumbline;
    }
    return greatCircle;
  }

  function processDelta(data) {
    let dict = data.updates[0].values[0];
    let path = dict.path;
    let value = dict.value;

    switch (path) {
      case 'navigation.position':
        let source = data.updates[0]['$source'];
        if ((gpsSource) && (source != gpsSource)) {
          app.debug(`Skipping position from GPS resource ${source}`);
          break;
        }
        position = value;
        position.changedOn = Date.now();
        updateDatabase();
        break;
      case 'navigation.speedOverGround':
        speedOverGround = metersPerSecondToKnots(value);
        maxSpeedOverGround = Math.max(maxSpeedOverGround, speedOverGround)
        previousSpeeds.unshift(speedOverGround);
        previousSpeeds = previousSpeeds.slice(0, 3);
        break;
      case 'navigation.courseOverGroundTrue':
        courseOverGroundTrue = radiantToDegrees(value);
        previousCOGs.unshift(courseOverGroundTrue);
        previousCOGs = previousCOGs.slice(0, 6);
        break;
      case 'environment.wind.speedApparent':
        windSpeedApparent = Math.max(windSpeedApparent, metersPerSecondToKnots(value));
        break;
      case 'environment.wind.angleApparent':
        angleSpeedApparent = radiantToDegrees(value);
        break;
      case 'environment.wind.speedTrue':
        // Latest reading in the window (reset to null after each insert), so a
        // dead wind source stops publishing wind instead of sending a stale value.
        windSpeedTrue = metersPerSecondToKnots(value);
        break;
      case 'environment.wind.directionTrue':
        // True wind direction (degrees true, the direction the wind blows FROM).
        windDirectionTrue = radiantToDegrees(value);
        break;
      case 'navigation.courseGreatCircle.nextPoint.position':
      case 'navigation.courseRhumbline.nextPoint.position':
        updateCoursePosition(coursePrefix(path), value);
        break;
      case 'navigation.courseGreatCircle.nextPoint.distance':
      case 'navigation.courseRhumbline.nextPoint.distance':
        updateCourseField(coursePrefix(path), 'distance', value);
        break;
      case 'navigation.courseGreatCircle.nextPoint.timeToGo':
      case 'navigation.courseRhumbline.nextPoint.timeToGo':
        updateCourseField(coursePrefix(path), 'timeToGo', value);
        break;
      case 'navigation.courseGreatCircle.nextPoint.href':
      case 'navigation.courseRhumbline.nextPoint.href':
        updateCourseField(coursePrefix(path), 'href', value);
        resolveWaypointName(coursePrefix(path), value);
        break;
      case 'propulsion.port.runTime':
        portEngineHours = Math.round(10 * value / 3600) / 10;
        break;
      case 'propulsion.starboard.runTime':
        starboardEngineHours = Math.round(10 * value / 3600) / 10;
        break;
      default:
        app.error('Unknown path: ' + path);
    }
  }

  return plugin;
}
