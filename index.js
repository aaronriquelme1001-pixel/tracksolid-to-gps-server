require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { verifySignature } = require('./utils/signature');

const app = express();
const PORT = process.env.PORT || 3000;
const APP_SECRET = process.env.TRACKSOLID_APP_SECRET || 'test_app_secret';
const GPS_SERVER_URL = process.env.GPS_SERVER_URL || 'http://your-gps-server.com/api/api_loc.php';

// Support both urlencoded and json payloads
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// Logger middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// Middleware to verify Tracksolid signature
function requireTracksolidSignature(req, res, next) {
  const hasParams = Object.keys(req.query).length > 0 || Object.keys(req.body).length > 0;
  if (!hasParams) {
    return res.status(200).json({ code: 0, message: 'success' });
  }

  const incomingSign = req.query.sign || req.body.sign || req.headers['x-sign'] || req.headers['sign'];
  if (!incomingSign) {
    // If Tracksolid server doesn't include a signature, print warning and proceed to avoid blocking data
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
  res.json({ status: 'OK', time: new Date().toISOString() });
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
 * Unified request handler for both Webhooks.
 * This makes it so it doesn't matter which URL you put in Tracksolid,
 * the server will automatically parse it correctly based on the payload structure.
 */
async function handleTracksolidPush(req, res) {
  try {
    const { msgType, data } = req.body;

    // If it's a verification test (no body/payload)
    if (!msgType || !data) {
      console.log('Received empty payload/verification ping on POST.');
      return res.status(200).json({ code: 0, message: 'success' });
    }

    const payload = typeof data === 'string' ? JSON.parse(data) : data;
    console.log(`\n--- New Telemetry Push (Type: ${msgType}) ---`);
    console.log('Payload:', payload);

    let gpsParams = {
      imei: payload.imei,
      altitude: 0,
      loc_valid: 1
    };

    // Case 1: Alarm Push Event (jimi.push.device.alarm)
    if (msgType === 'jimi.push.device.alarm' || payload.alarmType !== undefined) {
      const alarmTypeStr = String(payload.alarmType || '');
      
      // Determine if it is ACC ON / OFF alarm
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

    // Case 2: Standard Location telemetry Push
    } else {
      const isAccOn = payload.accStatus === '1' || payload.accStatus === 1 || String(payload.ignition).toUpperCase() === 'ON';
      const accVal = isAccOn ? 1 : 0;
      const batpVal = payload.electQuantity !== undefined ? payload.electQuantity : 100;
      const powerVal = payload.powerValue !== undefined ? payload.powerValue : '';

      let paramsStr = `acc=${accVal}|batp=${batpVal}|`;
      if (powerVal) {
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
    
    // Call GPS Server api_loc.php (HTTP GET)
    const response = await axios.get(GPS_SERVER_URL, { params: gpsParams });
    console.log('GPS Server Response:', response.data);

    res.json({ code: 0, message: 'Telemetry forwarded successfully' });
  } catch (error) {
    console.error('Error handling webhook push:', error.message);
    res.status(500).json({ code: -1, message: 'Internal server error: ' + error.message });
  }
}

app.post('/webhook/alarm', requireTracksolidSignature, handleTracksolidPush);
app.post('/webhook/location', requireTracksolidSignature, handleTracksolidPush);

app.listen(PORT, () => {
  console.log(`===========================================================`);
  console.log(`Tracksolid Telemetry Forwarder Middleware running on port ${PORT}`);
  console.log(`Tracksolid App Secret: ${APP_SECRET}`);
  console.log(`Forwarding target GPS Server: ${GPS_SERVER_URL}`);
  console.log(`===========================================================`);
});
