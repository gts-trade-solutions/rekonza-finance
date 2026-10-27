// Run the stand-in TallyPrime on this PC, for trying the connector without Tally.
//   npm run tally:fake              listens on port 9000, like TallyPrime
//   npm run tally:fake -- --port 9100

import { startFakeTally } from './fake-tally';

const i = process.argv.indexOf('--port');
const port = i > -1 ? Number(process.argv[i + 1]) : 9000;
const d = new Date();
const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

startFakeTally({ port, today }).then((t) => {
  console.log(`Stand-in TallyPrime on port ${t.port} with "${t.data.name}" open. Press Ctrl+C to stop.`);
});
