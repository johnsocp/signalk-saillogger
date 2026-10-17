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
const { buildBatch } = require('./lib/payload')
const { createCourseTracker, GREAT_CIRCLE } = require('./lib/course')
const { sign } = require('./lib/auth')
const { deltaValue, createGpsGate } = require('./lib/delta')
const { performance } = require('perf_hooks')
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
  var gpsGate;
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
  // Active-route ("next waypoint") state machine; see lib/course.js. Exactly one
  // course prefix is read (the `coursePrefix` option), and a route clear is held
  // until the server has accepted the batch that carried next_waypoint: null.
  var coursePrefix;
  var courseSource;
  var courseTracker;
  // href -> resolved waypoint name (or null when it could not be resolved).
  // Memoizes the resources lookup, including the failures.
  var waypointNames = {};

  // Its own id, so it never shares a config file or data dir with an upstream
  // signalk-saillogger installed beside it (Signal K keys both on the id).
  plugin.id = "signalk-entropy-saillog";
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
        title: "GPS source (optional; leave empty if unsure)",
        description: "Preferred $source for position, SOG and COG. If it reports no position for 30 s, other sources are used until it returns."
      },
      coursePrefix: {
        type: "string",
        title: "Course source",
        description: "Signal K course path family the plotter populates for the active route. Great-circle is what the Signal K course API and most N2K plotters publish; choose rhumbline for NMEA 0183 RMB-only setups. Only this family is read.",
        enum: ["navigation.courseGreatCircle", "navigation.courseRhumbline"],
        default: "navigation.courseGreatCircle"
      },
      courseSource: {
        type: "string",
        title: "Course source device",
        description: "Restrict the course paths to this Signal K $source. Leave blank to lock onto the first source that reports a destination after start."
      }
    }
  }

  function startPlugin(options) {
    app.debug(`Running on ${findPlatform()}`);

    endpoint = options.endpoint;
    apiKey = options.apiKey;
    secret = options.secret;
    gpsGate = createGpsGate(options.source, performance.now());
    coursePrefix = options.coursePrefix || GREAT_CIRCLE;
    courseSource = options.courseSource;

    if (!endpoint || (!apiKey && !secret)) {
      app.setPluginError('endpoint and at least one credential (secret recommended, or apiKey) are required');
      return;
    }
    app.debug(`Starting the plugin, pushing to ${endpoint}`);
    app.setPluginStatus('Entropy Sail Log started. Please wait for a status update.');

    const dataDir = app.getDataDirPath();
    bufferStore = new BufferStore(filePath.join(dataDir, 'entropysaillog_buffer.ndjson'));
    // The pending route clear outlives the process: a restart between the null
    // delta and the accepted push would otherwise forget the delete forever.
    courseTracker = createCourseTracker({
      prefix: coursePrefix,
      lockSource: courseSource,
      persist: courseStateStore(filePath.join(dataDir, 'entropysaillog_course.json'))
    });

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
        path: `${coursePrefix}.nextPoint.position`,
        period: POLL_INTERVAL * 1000
      }, {
        path: `${coursePrefix}.nextPoint.distance`,
        period: POLL_INTERVAL * 1000
      }, {
        path: `${coursePrefix}.nextPoint.timeToGo`,
        period: POLL_INTERVAL * 1000
      }, {
        path: `${coursePrefix}.nextPoint.href`,
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
    // undefined = say nothing about the route; null = it was cleared (resent
    // until the server accepts it); a snapshot = upsert it (stale snapshots are
    // already filtered out by choose()).
    const course = courseTracker.choose(Date.now());
    const batch = buildBatch(rows, course);
    if (!batch) {
      // Every peeked row was an unusable fix (bad coords/timestamp). Purge them
      // so they don't wedge the queue forever.
      app.debug(`Dropping ${rows.length} unusable cached row(s)`);
      bufferStore.deleteUpTo(lastTs);
      updatePluginStatus();
      return;
    }

    // Which clear this batch carries, captured as it is built: a 200 arriving
    // late for an OLDER batch must not disarm a clear armed after it was sent.
    const clearSeq = batch.next_waypoint === null ? courseTracker.pendingClearSeq : 0;

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
        // If this batch carried the cleared route, stop resending that null.
        courseTracker.onBatchAccepted(clearSeq);
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

  // Best-effort waypoint name lookup. Never blocks a push: the name is attached
  // to the snapshot if and when it resolves, and any failure is swallowed.
  function resolveWaypointName(href) {
    if (typeof href !== 'string') {
      return;
    }
    const match = href.match(/^\/resources\/waypoints\/(.+)$/);
    if (!match) {
      return;
    }
    if (href in waypointNames) {
      courseTracker.applyResolvedName(href, waypointNames[href]);
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
        courseTracker.applyResolvedName(href, name);
      }).catch(function (err) {
        app.debug(`Could not resolve waypoint name for ${href}: ${err}`);
      });
    } catch (err) {
      app.debug(`Could not resolve waypoint name for ${href}: ${err}`);
    }
  }

  // Tiny synchronous JSON file for the course tracker's pending clear. Both
  // directions are best-effort: a missing/corrupt file is a clean start, and a
  // failed write only costs the durability of a clear we still hold in memory.
  function courseStateStore(file) {
    return {
      load: function () {
        try {
          return JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch (err) {
          app.debug(`No course state restored from ${file}: ${err}`);
          return undefined;
        }
      },
      save: function (state) {
        try {
          fs.writeFileSync(file, JSON.stringify(state));
        } catch (err) {
          app.debug(`Could not persist course state to ${file}: ${err}`);
        }
      }
    };
  }

  // Freshness follows the SOURCE's timestamp, not arrival: the default `ideal`
  // subscription policy re-sends an unchanged value every period while keeping
  // the update's original timestamp, so a disconnected plotter's last route
  // would otherwise look fresh forever.
  function courseDeltaTime(data) {
    const ts = Date.parse(data.updates[0].timestamp);
    return Number.isFinite(ts) ? ts : Date.now();
  }

  // One device drives the course paths. Configured, that is the `courseSource`
  // option; unconfigured, the first source to report a destination takes the
  // lock (the tracker owns the lock itself — see lib/course.js). Without this,
  // two devices publishing the same family alternate marks and one's null
  // deletes the other's live route.
  function applyCourseDelta(data, path, value) {
    const source = data.updates[0]['$source'];
    if ((courseSource) && (source != courseSource)) {
      app.debug(`Skipping course delta from source ${source}`);
      return;
    }
    const lockedBefore = courseTracker.lockedSource;
    courseTracker.applyDelta(path, value, courseDeltaTime(data), source);
    if (courseTracker.lockedSource !== lockedBefore) {
      app.debug(`Course paths locked onto source ${courseTracker.lockedSource}`);
    }
  }

  // A new GPS source starts from scratch: the previous one's speed and course must
  // not end up in a row beside the new one's position. null, not 0, so a row written
  // before the new source reports SOG omits it rather than claiming 0 kn.
  function clearGpsCache() {
    speedOverGround = null;
    maxSpeedOverGround = null;
    courseOverGroundTrue = null;
    previousSpeeds = [];
    previousCOGs = [];
  }

  function processDelta(data) {
    const delta = deltaValue(data);
    if (!delta) {
      return;
    }
    let path = delta.path;
    let value = delta.value;

    // A null position is "no fix": dropped before the gate, so a GPS that lost its
    // fix but keeps publishing cannot hold the source lock and block the fallback.
    if (path === 'navigation.position' && !value) {
      return;
    }

    const gpsSourceBefore = gpsGate.source;
    if (!gpsGate.accepts(path, delta.source, performance.now())) {
      app.debug(`Skipping ${path} from GPS resource ${delta.source}`);
      return;
    }
    if (gpsGate.source !== gpsSourceBefore) {
      app.debug(`GPS source switched from ${gpsSourceBefore} to ${gpsGate.source}`);
      clearGpsCache();
    }

    switch (path) {
      case 'navigation.position':
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
      case 'navigation.courseGreatCircle.nextPoint.distance':
      case 'navigation.courseRhumbline.nextPoint.distance':
      case 'navigation.courseGreatCircle.nextPoint.timeToGo':
      case 'navigation.courseRhumbline.nextPoint.timeToGo':
        applyCourseDelta(data, path, value);
        break;
      case 'navigation.courseGreatCircle.nextPoint.href':
      case 'navigation.courseRhumbline.nextPoint.href':
        applyCourseDelta(data, path, value);
        resolveWaypointName(value);
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
