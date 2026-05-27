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
 * Endpoint for Tracksolid real-time alarm pushes (jimi.push.device.alarm)
 * Tracksolid POSTs with query parameters for signature, and body with msgType and data.
 */
app.post('/webhook/alarm', requireTracksolidSignature, async (req, res) => {
  try {
    const { msgType, data } = req.body;
    console.log(`Received alarm webhook. Type: ${msgType}`);

    if (!data) {
      return res.status(400).json({ code: 1001, message: 'Missing data field in body' });
    }

    // data is a JSON string representing the alarm event
    const alarm = typeof data === 'string' ? JSON.parse(data) : data;
    console.log('Alarm payload details:', alarm);

    // Map Tracksolid alarms to GPS Server event names
    // Mappings:
    // "1" (SOS alert) -> "sos"
    // "2" (Power cut off alert) -> "pwrcut"
    // "14" (Low external power alert) -> "lowdc"
    // "15" (Low power protection alert) -> "lowbat"
    // "20" (Door detection alert) -> "door"
    // "41" (Sudden Acceleration Alert) -> "haccel"
    // "48" (Sudden Deceleration Alert) -> "hbrake"
    const alarmTypeStr = String(alarm.alarmType || '');
    let mappedEvent = 'alert';
    if (alarmTypeStr === '1') mappedEvent = 'sos';
    else if (alarmTypeStr === '2') mappedEvent = 'pwrcut';
    else if (alarmTypeStr === '14') mappedEvent = 'lowdc';
    else if (alarmTypeStr === '15') mappedEvent = 'lowbat';
    else if (alarmTypeStr === '20') mappedEvent = 'door';
    else if (alarmTypeStr === '41') mappedEvent = 'haccel';
    else if (alarmTypeStr === '48') mappedEvent = 'hbrake';

    // Format params string
    const paramsStr = `alarm_type=${alarmTypeStr}|alarm_name=${alarm.alarmName || ''}|`;

    // Map to GPS Server Location API GET parameters
    const gpsParams = {
      imei: alarm.imei,
      dt: alarm.alarmTime || new Date().toISOString().replace('T', ' ').substring(0, 19),
      lat: Number(alarm.lat || 0).toFixed(6),
      lng: Number(alarm.lng || 0).toFixed(6),
      altitude: 0,
      angle: 0,
      speed: 0,
      loc_valid: 1,
      params: paramsStr,
      event: mappedEvent
    };

    console.log(`Forwarding alarm to GPS Server: ${GPS_SERVER_URL}`, gpsParams);
    
    // Call GPS Server api_loc.php (HTTP GET)
    const response = await axios.get(GPS_SERVER_URL, { params: gpsParams });
    console.log('GPS Server Response:', response.data);

    res.json({ code: 0, message: 'Alarm forwarded successfully' });
  } catch (error) {
    console.error('Error handling alarm webhook:', error.message);
    res.status(500).json({ code: -1, message: 'Internal server error: ' + error.message });
  }
});

/**
 * Endpoint for Tracksolid real-time location/telemetry pushes
 */
app.post('/webhook/location', requireTracksolidSignature, async (req, res) => {
  try {
    const { msgType, data } = req.body;
    console.log(`Received location webhook. Type: ${msgType}`);

    if (!data) {
      return res.status(400).json({ code: 1001, message: 'Missing data field in body' });
    }

    const telemetry = typeof data === 'string' ? JSON.parse(data) : data;
    console.log('Location payload details:', telemetry);

    // Map ACC Status to digital input parameter (acc=1 or acc=0)
    // accStatus can be '1' (ON) / '0' (OFF) or ignition can be 'ON' / 'OFF'
    const isAccOn = telemetry.accStatus === '1' || telemetry.accStatus === 1 || String(telemetry.ignition).toUpperCase() === 'ON';
    const accVal = isAccOn ? 1 : 0;
    const batpVal = telemetry.electQuantity !== undefined ? telemetry.electQuantity : 100;
    const powerVal = telemetry.powerValue !== undefined ? telemetry.powerValue : '';

    let paramsStr = `acc=${accVal}|batp=${batpVal}|`;
    if (powerVal) {
      paramsStr += `voltage=${powerVal}|`;
    }

    // Determine event type if ACC changed
    let mappedEvent = '';
    // Optional ACC ON/OFF events
    if (telemetry.accStatus !== undefined) {
      // Mapped events: accStatus changes can trigger engine events if needed
      // but standard updates can keep event empty/null
    }

    // Map to GPS Server Location API GET parameters
    const gpsParams = {
      imei: telemetry.imei,
      dt: telemetry.gpsTime || telemetry.hbTime || new Date().toISOString().replace('T', ' ').substring(0, 19),
      lat: Number(telemetry.lat || 0).toFixed(6),
      lng: Number(telemetry.lng || 0).toFixed(6),
      altitude: 0, // Tracksolid location doesn't expose altitude, defaulting to 0
      angle: Number(telemetry.direction || 0),
      speed: Number(telemetry.speed || 0),
      loc_valid: 1,
      params: paramsStr,
      event: mappedEvent || null
    };

    console.log(`Forwarding telemetry to GPS Server: ${GPS_SERVER_URL}`, gpsParams);

    // Call GPS Server api_loc.php (HTTP GET)
    const response = await axios.get(GPS_SERVER_URL, { params: gpsParams });
    console.log('GPS Server Response:', response.data);

    res.json({ code: 0, message: 'Telemetry forwarded successfully' });
  } catch (error) {
    console.error('Error handling location webhook:', error.message);
    res.status(500).json({ code: -1, message: 'Internal server error: ' + error.message });
  }
});

app.listen(PORT, () => {
  console.log(`===========================================================`);
  console.log(`Tracksolid Telemetry Forwarder Middleware running on port ${PORT}`);
  console.log(`Tracksolid App Secret: ${APP_SECRET}`);
  console.log(`Forwarding target GPS Server: ${GPS_SERVER_URL}`);
  console.log(`===========================================================`);
});
