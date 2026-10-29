import 'server-only';

// The demo book with its internal controls on, as an auditor would want a
// real book: a reason with every change, segregation of duties enforced,
// reminders and credit hold, depreciation at month end, password history, and
// perpetual inventory from the first of this month. Two-step sign-in stays
// optional, or the one-click demo door would ask every visitor to set it up.

import type { Trx } from '../db';
import { setPolicies } from '../services/org-settings';
import { switchToPerpetual } from '../services/stock-ledger';
import { indiaToday } from '../services/held-journals';

export async function turnOnDemoControls(trx: Trx, orgId: number, userId: number | null = null) {
  await setPolicies(trx, orgId, userId, {
    controls: {
      changeReasons: true, segregation: 'block', autoIrn: true, creditHoldDays: 90, creditHold: 'warn',
      billsDueDays: 7, concentrationPct: 25, escalateAfterDays: 3, autoDepreciation: true,
    },
    password: { minLength: 10, expiryDays: 0, history: 5 },
    reminders: { enabled: true, stages: [-3, 0, 15, 30, 60, 90], channel: 'whatsapp' },
    sessionIdleMinutes: 60,
  });
  const s = await trx.selectFrom('settings').select('value').where('org_id', '=', orgId).where('scope', '=', 'policy')
    .where('setting_key', '=', 'stockAccounting').executeTakeFirst();
  if (!s) await switchToPerpetual(trx, orgId, userId, `${indiaToday().slice(0, 7)}-01`);
}
