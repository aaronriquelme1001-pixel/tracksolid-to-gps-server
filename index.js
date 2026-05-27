require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const crypto = require('crypto');
const { verifySignature, computeSignature } = require('./utils/signature');

const app = express();
const PORT = process.env.PORT || 3000;
const APP_SECRET = process.env.TRACKSOLID_APP_SECRET || 'test_app_secret';
const GPS_SERVER_URL = process.env.GPS_SERVER_URL || 'http://your-gps-server.com/api/api_loc.php';

// Tracksolid API configuration
const TRACKSOLID_API_URL = process.env.TRACKSOLID_API_URL || 'https://us-open.tracksolidpro.com/route/rest';
const TRACKSOLID_USER_ID = process.env.TRACKSOLID_USER_ID;
const TRACKSOLID_USER_PWD_MD5 = process.env.TRACKSOLID_USER_PWD_MD5;
const TRACKSOLID_APP_KEY = process.env.TRACKSOLID_APP_KEY;
const TRACKSOLID_APP_SECRET = process.env.TRACKSOLID_APP_SECRET || APP_SECRET;
const TRACKSOLID_IMEIS = process.env.TRACKSOLID_IMEIS;
const TRACKSOLID_POLL_INTERVAL = parseInt(process.env.TRACKSOLID_POLL_INTERVAL || '30000', 10);

// Token Cache State
let cachedToken = null;
let tokenExpiresAt = null;

// Support both urlencoded and json payloads
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// Logger middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// Helper to format date in yyyy-MM-dd HH:mm:ss format (UTC)
function getUtcTimestamp() {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const MM = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const hh = String(now.getUTCHours()).padStart(2, '0');
  const mm = String(now.getUTCMinutes()).padStart(2, '0');
  const ss = String(now.getUTCSeconds()).padStart(2, '0');
  return `${yyyy}-${MM}-${dd} ${hh}:${mm}:${ss}`;
}

// Middleware to verify Tracksolid signature
function requireTracksolidSignature(req, res, next) {
  const hasParams = Object.keys(req.query).length > 0 || Object.keys(req.body).length > 0;
  if (!hasParams) {
    return res.status(200).json({ code: 0, message: 'success' });
  }

  const incomingSign = req.query.sign || req.body.sign || req.headers['x-sign'] || req.headers['sign'];
  if (!incomingSign) {
    console.log('[Signature Warning] Missing signature on push, proceeding anyway.');
    return next();
  }

  if (!verifySignature(req, APP_SECRET)) {
    console.warn(`[Signature Failed] Unauthorized request to ${req.path}`);
    return res.status(401).json({
      code: 1004,
      message: 'Illegal access, token exception! (Invalid signature)'
    });
  }
  next();
}

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    time: new Date().toISOString(),
    pollingActive: !!(TRACKSOLID_USER_ID && TRACKSOLID_APP_KEY && TRACKSOLID_APP_SECRET && TRACKSOLID_USER_PWD_MD5 && TRACKSOLID_IMEIS),
    hasToken: !!cachedToken
  });
});

/**
 * GET handlers for Webhook verification
 */
app.get('/webhook/alarm', (req, res) => {
  console.log('Received GET verification ping on /webhook/alarm');
  res.status(200).json({ code: 0, message: 'success' });
});

app.get('/webhook/location', (req, res) => {
  console.log('Received GET verification ping on /webhook/location');
  res.status(200).json({ code: 0, message: 'success' });
});

/**
 * Unified request handler for both Webhooks (alarm and location pushes).
 */
async function handleTracksolidPush(req, res) {
  try {
    const { msgType, data } = req.body;

    if (!msgType || !data) {
      console.log('Received empty payload/verification ping on POST.');
      return res.status(200).json({ code: 0, message: 'success' });
    }

    const payload = typeof data === 'string' ? JSON.parse(data) : data;
    console.log(`\n--- New Telemetry Push (Type: ${msgType}) ---`);
    console.log('Payload:', payload);

    await forwardTelemetry(payload, msgType);

    res.json({ code: 0, message: 'Telemetry forwarded successfully' });
  } catch (error) {
    console.error('Error handling webhook push:', error.message);
    res.status(500).json({ code: -1, message: 'Internal server error: ' + error.message });
  }
}

/**
 * Common formatting and forwarding logic to GPS Server
 */
async function forwardTelemetry(payload, msgType = null) {
  let gpsParams = {
    imei: payload.imei,
    altitude: 0,
    loc_valid: 1
  };

  // Case 1: Alarm Push Event (jimi.push.device.alarm)
  if (msgType === 'jimi.push.device.alarm' || payload.alarmType !== undefined) {
    const alarmTypeStr = String(payload.alarmType || '');
    const isAccOff = alarmTypeStr === '1001' || String(payload.originalAlarmType).toUpperCase() === 'ACC_OFF';
    const isAccOn = alarmTypeStr === '1002' || String(payload.originalAlarmType).toUpperCase() === 'ACC_ON';
    
    let mappedEvent = 'alert';
    let accVal = 0;

    if (isAccOff) {
      mappedEvent = 'ignition_off';
      accVal = 0;
    } else if (isAccOn) {
      mappedEvent = 'ignition_on';
      accVal = 1;
    } else if (alarmTypeStr === '1') {
      mappedEvent = 'sos';
    } else if (alarmTypeStr === '2') {
      mappedEvent = 'pwrcut';
    } else if (alarmTypeStr === '14') {
      mappedEvent = 'lowdc';
    } else if (alarmTypeStr === '15') {
      mappedEvent = 'lowbat';
    } else if (alarmTypeStr === '20') {
      mappedEvent = 'door';
    } else if (alarmTypeStr === '41') {
      mappedEvent = 'haccel';
    } else if (alarmTypeStr === '48') {
      mappedEvent = 'hbrake';
    }

    gpsParams.dt = payload.alarmTime || new Date().toISOString().replace('T', ' ').substring(0, 19);
    gpsParams.lat = Number(payload.lat || 0).toFixed(6);
    gpsParams.lng = Number(payload.lng || 0).toFixed(6);
    gpsParams.speed = Number(payload.speed || 0);
    gpsParams.angle = Number(payload.direction || 0);
    gpsParams.event = mappedEvent;
    gpsParams.params = `acc=${accVal}|alarm_type=${alarmTypeStr}|alarm_name=${payload.alarmName || ''}|`;

  // Case 2: Standard Location telemetry
  } else {
    const isAccOn = payload.accStatus === '1' || payload.accStatus === 1 || String(payload.ignition).toUpperCase() === 'ON';
    const accVal = isAccOn ? 1 : 0;
    const batpVal = (payload.electQuantity !== undefined && payload.electQuantity !== null && payload.electQuantity !== '') ? payload.electQuantity : null;
    const powerVal = (payload.powerValue !== undefined && payload.powerValue !== null && payload.powerValue !== '') ? payload.powerValue : null;

    let paramsStr = `acc=${accVal}|`;
    if (batpVal !== null) {
      paramsStr += `batp=${batpVal}|`;
    }
    if (powerVal !== null) {
      paramsStr += `voltage=${powerVal}|`;
    }

    gpsParams.dt = payload.gpsTime || payload.hbTime || new Date().toISOString().replace('T', ' ').substring(0, 19);
    gpsParams.lat = Number(payload.lat || 0).toFixed(6);
    gpsParams.lng = Number(payload.lng || 0).toFixed(6);
    gpsParams.speed = Number(payload.speed || 0);
    gpsParams.angle = Number(payload.direction || 0);
    gpsParams.event = null;
    gpsParams.params = paramsStr;
  }

  console.log(`Forwarding to GPS Server: ${GPS_SERVER_URL}`, gpsParams);
  const response = await axios.get(GPS_SERVER_URL, { params: gpsParams });
  console.log('GPS Server Response:', response.data);
}

/**
 * Tracksolid Token Retriever (handles credentials & caches token)
 */
async function getTracksolidToken() {
  const now = Date.now();
  if (cachedToken && tokenExpiresAt && now < tokenExpiresAt) {
    return cachedToken;
  }

  console.log('[Tracksolid API] Fetching new access token...');
  const timestamp = getUtcTimestamp();
  
  const commonParams = {
    method: 'jimi.oauth.token.get',
    timestamp: timestamp,
    app_key: TRACKSOLID_APP_KEY,
    sign_method: 'md5',
    v: '1.0',
    format: 'json'
  };

  const privateParams = {
    user_id: TRACKSOLID_USER_ID,
    user_pwd_md5: TRACKSOLID_USER_PWD_MD5,
    expires_in: 7200
  };

  const allParams = { ...commonParams, ...privateParams };
  const sign = computeSignature(allParams, TRACKSOLID_APP_SECRET);
  
  const queryParams = { ...commonParams, sign };
  const queryStr = new URLSearchParams(queryParams).toString();
  const bodyStr = new URLSearchParams(privateParams).toString();

  try {
    const res = await axios.post(`${TRACKSOLID_API_URL}?${queryStr}`, bodyStr, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    if (res.data && res.data.code === 0 && res.data.result) {
      cachedToken = res.data.result.accessToken;
      // Expire token slightly earlier (10 minutes) for safety margin
      const expiresInSec = parseInt(res.data.result.expiresIn || '7200', 10);
      tokenExpiresAt = Date.now() + (expiresInSec - 600) * 1000;
      console.log(`[Tracksolid API] Token cached successfully. Expires in ${expiresInSec}s.`);
      return cachedToken;
    } else {
      const errorMsg = res.data ? res.data.message : 'Unknown error';
      const errorCode = res.data ? res.data.code : -1;
      throw new Error(`Failed to get token (Code: ${errorCode}, Msg: ${errorMsg})`);
    }
  } catch (err) {
    console.error('[Tracksolid API] Error retrieving token:', err.message);
    throw err;
  }
}

/**
 * Poll location updates for configured IMEIs
 */
async function pollTracksolidLocations() {
  try {
    const token = await getTracksolidToken();
    const imeisList = TRACKSOLID_IMEIS.split(',').map(s => s.trim());
    
    console.log(`[Tracksolid Poller] Fetching locations for ${imeisList.length} devices...`);

    const timestamp = getUtcTimestamp();
    const commonParams = {
      method: 'jimi.device.location.get',
      timestamp: timestamp,
      app_key: TRACKSOLID_APP_KEY,
      sign_method: 'md5',
      v: '1.0',
      format: 'json',
      access_token: token
    };

    const privateParams = {
      imeis: imeisList.join(',')
    };

    const allParams = { ...commonParams, ...privateParams };
    const sign = computeSignature(allParams, TRACKSOLID_APP_SECRET);
    
    const queryParams = { ...commonParams, sign };
    const queryStr = new URLSearchParams(queryParams).toString();
    const bodyStr = new URLSearchParams(privateParams).toString();

    const res = await axios.post(`${TRACKSOLID_API_URL}?${queryStr}`, bodyStr, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    if (res.data && res.data.code === 0 && res.data.result) {
      // Result can be a single object or an array of device locations
      const devices = Array.isArray(res.data.result) ? res.data.result : [res.data.result];
      console.log(`[Tracksolid Poller] Successfully retrieved ${devices.length} locations.`);

      for (const device of devices) {
        if (!device || !device.imei) continue;
        
        // Map to format expected by forwardTelemetry
        // jimi.device.location.get returns fields like: lat, lng, speed, direction, accStatus, electQuantity, powerValue
        console.log(`[Tracksolid Poller] Processing location for IMEI ${device.imei}`);
        await forwardTelemetry(device);
      }
    } else {
      const code = res.data ? res.data.code : -1;
      const msg = res.data ? res.data.message : 'Unknown error';
      console.warn(`[Tracksolid Poller] API warning (Code: ${code}, Msg: ${msg})`);
      
      // If unauthorized token, invalidate token cache
      if (code === 1004 || String(msg).toLowerCase().includes('token')) {
        console.log('[Tracksolid Poller] Token error detected. Invalidating cached token.');
        cachedToken = null;
        tokenExpiresAt = null;
      }
    }
  } catch (err) {
    console.error('[Tracksolid Poller] Polling cycle failed:', err.message);
  }
}

app.post('/webhook/alarm', requireTracksolidSignature, handleTracksolidPush);
app.post('/webhook/location', requireTracksolidSignature, handleTracksolidPush);

app.listen(PORT, () => {
  console.log(`===========================================================`);
  console.log(`Tracksolid Telemetry Forwarder Middleware running on port ${PORT}`);
  console.log(`Tracksolid App Secret: ${APP_SECRET}`);
  console.log(`Forwarding target GPS Server: ${GPS_SERVER_URL}`);
  
  // Start Polling Engine if credentials are provided
  if (TRACKSOLID_USER_ID && TRACKSOLID_APP_KEY && TRACKSOLID_APP_SECRET && TRACKSOLID_USER_PWD_MD5 && TRACKSOLID_IMEIS) {
    console.log(`[Polling Engine] Starting background location polling loop.`);
    console.log(`[Polling Engine] Interval: ${TRACKSOLID_POLL_INTERVAL}ms`);
    console.log(`[Polling Engine] Target IMEIs: ${TRACKSOLID_IMEIS}`);
    
    // Run immediately on startup, then every interval
    pollTracksolidLocations();
    setInterval(pollTracksolidLocations, TRACKSOLID_POLL_INTERVAL);
  } else {
    console.log(`[Polling Engine] Disabled (missing one or more environment variables).`);
    console.log(`Required variables to activate polling:`);
    console.log(`- TRACKSOLID_USER_ID: ${TRACKSOLID_USER_ID ? 'SET' : 'MISSING'}`);
    console.log(`- TRACKSOLID_USER_PWD_MD5: ${TRACKSOLID_USER_PWD_MD5 ? 'SET' : 'MISSING'}`);
    console.log(`- TRACKSOLID_APP_KEY: ${TRACKSOLID_APP_KEY ? 'SET' : 'MISSING'}`);
    console.log(`- TRACKSOLID_APP_SECRET: ${TRACKSOLID_APP_SECRET ? 'SET' : 'MISSING'}`);
    console.log(`- TRACKSOLID_IMEIS: ${TRACKSOLID_IMEIS ? 'SET' : 'MISSING'}`);
  }
  console.log(`===========================================================`);
});

