// Simulates a smart energy meter posting readings every few seconds.
//   node examples/simulate-device.js <API_KEY> [serverUrl] [intervalSeconds]
// Create the device first (see README) and use the API key it returns.
const [key, server = 'http://localhost:3000', every = '5'] = process.argv.slice(2);
if (!key) { console.error('Usage: node examples/simulate-device.js <API_KEY> [serverUrl] [intervalSeconds]'); process.exit(1); }

let energyKwh = 1520.0;
async function send() {
  const hour = new Date().getHours() + new Date().getMinutes() / 60;
  const power = Math.round(900 + 700 * Math.sin((hour - 6) / 24 * 2 * Math.PI) + Math.random() * 150 + (Math.random() < 0.02 ? 5000 : 0));
  energyKwh += (power / 1000) * (Number(every) / 3600);
  const body = { ts: Math.floor(Date.now() / 1000), values: { power, voltage: +(229 + Math.random() * 3).toFixed(1), energy: +energyKwh.toFixed(3) } };
  try {
    const res = await fetch(`${server}/api/ingest`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': key }, body: JSON.stringify(body) });
    const out = await res.json();
    console.log(res.status, JSON.stringify(body.values), '->', out.error || `accepted ${out.accepted}, rejected ${out.rejected}`);
  } catch (err) { console.error('Send failed:', err.message); }
}
send();
setInterval(send, Number(every) * 1000);
