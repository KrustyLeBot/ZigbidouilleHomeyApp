'use strict';

// Interviews Homey's own Insights API, without the app in the way.
//
// This exists because the Shelly widget's backfill (app/lib/power-history.js)
// depends on how an Insights log is ADDRESSED, and that is exactly the thing no
// document pins down: the log id was assumed to be
// `homey:device:<uuid>:<capability>`, every request 404'd, the error was
// swallowed, and the widget silently showed only the part of the day that
// happened after the app booted. One run of this script settles it.
//
// Credentials in the repo-root .env:
//
//   HOMEY_IP=192.168.1.x
//   HOMEY_TOKEN=<Personal Access Token>
//
// Create the token in the Homey web app (my.homey.app -> Settings -> API keys)
// with at least the Insights and Devices read scopes. It is a password: never
// commit it, never echo it into a doc or a log.
//
//   node insights.js                 list every log, grouped by device
//   node insights.js <text>          only devices whose name contains <text>
//   node insights.js <text> entries  also fetch today's entries for each log

const http = require('http');
const path = require('path');
const { requireVars } = require(path.join(__dirname, '..', 'env'));

const [ip, token] = requireVars(['HOMEY_IP', 'HOMEY_TOKEN']);

function get(urlPath) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: ip,
      port: 80,
      path: urlPath,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      timeout: 15000,
    }, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode >= 300) {
          // The status code is the whole point of this script: a 404 means the
          // id shape is wrong, a 401 means the token is, and they are otherwise
          // indistinguishable from inside the app.
          reject(new Error(`HTTP ${response.statusCode} on ${urlPath}: ${body.slice(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(new Error(`bad JSON on ${urlPath}: ${body.slice(0, 200)}`));
        }
      });
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', reject);
    request.end();
  });
}

// Homey answers collections as either an array or an id-keyed object depending
// on the endpoint and the firmware — normalise before looking at anything.
function list(result) {
  return Array.isArray(result) ? result : Object.values(result || {});
}

async function main() {
  const filter = (process.argv[2] || '').toLowerCase();
  const withEntries = process.argv[3] === 'entries';

  const devices = list(await get('/api/manager/devices/device'));
  const names = new Map();
  for (const device of devices) names.set(device.id, device.name);

  const logs = list(await get('/api/manager/insights/log'));
  console.log(`${devices.length} devices, ${logs.length} insight logs\n`);

  for (const log of logs) {
    // ownerUri is the documented home of the device reference; uri is the older
    // name for it. Print the raw keys either way — the shape IS the finding.
    const uri = log.ownerUri || log.uri || '';
    const owner = names.get(log.ownerId) || names.get(String(uri).split(':')[2]) || log.ownerName || '?';
    if (filter && !String(owner).toLowerCase().includes(filter)) continue;

    console.log(`${owner}`);
    console.log(`  id       ${log.id}`);
    console.log(`  ownerUri ${uri}`);
    console.log(`  ownerId  ${log.ownerId}`);
    console.log(`  title    ${log.title}   units=${log.units}   type=${log.type}`);

    if (!withEntries) continue;

    // Both path shapes, because that is the open question: /log/:uri/:id/entry
    // is what the spec says, and the app's homey-api client derives the uri
    // from the id by splitting on ':'.
    const candidates = [
      `/api/manager/insights/log/${encodeURIComponent(uri)}/${encodeURIComponent(log.id)}/entry?resolution=today`,
      `/api/manager/insights/log/${encodeURIComponent(log.id)}/entry?resolution=today`,
    ];
    for (const candidate of candidates) {
      try {
        const result = await get(candidate);
        const values = Array.isArray(result) ? result : (result.values || []);
        const first = values[0];
        console.log(`  OK   ${candidate.split('?')[0]} -> ${values.length} values`
          + (first ? ` first=${JSON.stringify(first)}` : ''));
      } catch (err) {
        console.log(`  FAIL ${candidate.split('?')[0]} -> ${err.message}`);
      }
    }
    console.log('');
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
