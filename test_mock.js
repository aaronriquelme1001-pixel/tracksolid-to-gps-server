const express = require('express');
const axios = require('axios');
const { computeSignature } = require('./utils/signature');

const MOCK_GPS_PORT = 4000;
const MIDDLEWARE_PORT = 3000;
const TEST_APP_SECRET = 'test_app_secret';

// 1. Start a mock GPS Server to receive forwarded requests
const mockGpsServer = express();
mockGpsServer.get('/api/api_loc.php', (req, res) => {
  console.log('\n[Mock GPS Server] Received forwarded telemetry GET request!');
  console.log('Query parameters received:');
  console.log(req.query);
  res.send('ok');
});

const server = mockGpsServer.listen(MOCK_GPS_PORT, () => {
  console.log(`[Mock GPS Server] Running on http://localhost:${MOCK_GPS_PORT}`);
  runTests();
});

// Helper to send signed POST request to middleware
async function sendMockWebhook(endpoint, payload) {
  const commonParams = {
    method: endpoint === '/webhook/alarm' ? 'jimi.push.device.alarm' : 'jimi.open.instruction.raw.receive',
    timestamp: new Date().toISOString().replace('T', ' ').substring(0, 19),
    app_key: 'test_app_key',
    v: '1.0',
    format: 'json'
  };

  // Combine common parameters and body payload to compute signature
  const signParams = { ...commonParams, ...payload };
  const sign = computeSignature(signParams, TEST_APP_SECRET);
  commonParams.sign = sign;

  const url = `http://localhost:${MIDDLEWARE_PORT}${endpoint}?` + new URLSearchParams(commonParams).toString();

  try {
    console.log(`\n[Test Client] Sending POST request to ${endpoint}...`);
    const res = await axios.post(url, payload);
    console.log(`[Test Client] Middleware Response Status: ${res.status}`);
    console.log('[Test Client] Middleware Response Data:', res.data);
  } catch (error) {
    console.error(`[Test Client] Request failed:`, error.response ? error.response.data : error.message);
  }
}

// 2. Main test routine
async function runTests() {
  console.log('\n[Test Client] Starting telemetry forwarding test suite...');

  try {
    // Test Case 1: Send Location / Telemetry Update (ACC ON)
    const sampleLocationPayload = {
      msgType: 'jimi.open.instruction.raw.receive',
      data: JSON.stringify({
        imei: '868120145233604',
        gpsTime: '2026-05-27 10:55:00',
        lat: 22.577282,
        lng: 113.916604,
        speed: 45,
        direction: 180,
        accStatus: '1',
        electQuantity: 85,
        powerValue: '12.4'
      })
    };
    await sendMockWebhook('/webhook/location', sampleLocationPayload);

    // Test Case 2: Send SOS Alarm Event
    const sampleAlarmPayload = {
      msgType: 'jimi.push.device.alarm',
      data: JSON.stringify({
        imei: '868120145233604',
        deviceName: 'Jimi JC400C Tracker',
        alarmType: '1',
        alarmName: 'SOS alert',
        lat: 22.577282,
        lng: 113.916604,
        alarmTime: '2026-05-27 10:56:15'
      })
    };
    await sendMockWebhook('/webhook/alarm', sampleAlarmPayload);

    // Test Case 3: Send unauthorized request (invalid signature)
    console.log('\n[Test Client] Sending unauthorized request (invalid signature)...');
    try {
      await axios.post(`http://localhost:${MIDDLEWARE_PORT}/webhook/location?sign=INVALID_SIGN&v=1.0`, {
        msgType: 'jimi.open.instruction.raw.receive',
        data: '{}'
      });
    } catch (error) {
      console.log(`[Test Client] Middleware Response Status (Expected 401): ${error.response.status}`);
      console.log('[Test Client] Middleware Response Data:', error.response.data);
    }

  } catch (err) {
    console.error('Test execution failed:', err);
  } finally {
    console.log('\n[Test Client] Tests finished. Shutting down Mock GPS Server...');
    server.close();
  }
}
