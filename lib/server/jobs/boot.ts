import 'server-only';

// Start the retry worker once per server process. Imported for its effect by
// the routes that can queue a retry, so it is running by the first request that
// could need it: the same pattern as the email app's worker boot. The rail's
// counts import it too, so the scheduler is running once anyone opens the app.

import { startJobWorker } from './worker';

startJobWorker();

export {};
