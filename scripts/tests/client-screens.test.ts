// Three faults the client met on the live site (2026-11-20), kept fixed:
// a saved invoice PDF named after the app instead of the invoice, the
// Sign-ins tab crashing on a session that ended for a reason it had no label
// for, and pages left on their loading rows when there was nothing to show.
//
//   npx tsx --test scripts/tests/client-screens.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import React, { createElement } from 'react';
import { fileTitle } from '../../lib/use-document-title';
import { statusOf } from '../../components/settings/sign-ins-panel';
import { AsyncPage } from '../../components/shared/async-state';

// tsx compiles the components' JSX to React.createElement.
(globalThis as { React?: typeof React }).React = React;

test('a printed document saves under its own number, in a name Windows accepts', () => {
  assert.equal(fileTitle('INV/26-27/0001'), 'INV-26-27-0001');
  assert.equal(fileTitle('Statement - Kaveri Motors: "main"'), 'Statement - Kaveri Motors- -main-');
  assert.equal(fileTitle('Profit and Loss 2026-04-01 to 2027-03-31'), 'Profit and Loss 2026-04-01 to 2027-03-31');
  assert.ok(fileTitle('x'.repeat(300)).length <= 120);
});

test('every way a session can end has a label, and an unknown one still shows', () => {
  for (const reason of ['active', 'signed_out', 'idle', 'revoked', 'expired', 'session_limit', 'password_changed', 'password_reset', 'mfa_reset', 'disabled']) {
    const s = statusOf(reason);
    assert.ok(s.label && !s.label.includes('_'), `${reason} → ${s.label}`);
  }
  assert.deepEqual(statusOf('password_reset').label, 'Password reset');
  assert.equal(statusOf('some_new_reason').label, 'Some new reason');
  assert.equal(statusOf('').label, 'Ended');
});

test('a load that finished with nothing shows the page\'s message, not loading rows', () => {
  const state = (data: unknown, loading = false) => ({ data, loading, error: null, refetch: () => {} });
  const empty = createElement('p', null, 'No reporting tags yet.');
  const done = renderToStaticMarkup(createElement(AsyncPage, { state: state(null), empty, children: () => 'table' }));
  assert.match(done, /No reporting tags yet/);
  const loading = renderToStaticMarkup(createElement(AsyncPage, { state: state(null, true), empty, children: () => 'table' }));
  assert.doesNotMatch(loading, /No reporting tags yet/);
  const loaded = renderToStaticMarkup(createElement(AsyncPage, { state: state({ rows: [] }), empty, children: () => 'table' }));
  assert.equal(loaded, 'table');
  // Without an empty message the old behaviour stands: nothing yet reads as loading.
  const old = renderToStaticMarkup(createElement(AsyncPage, { state: state(null), children: () => 'table' }));
  assert.doesNotMatch(old, /table/);
});
