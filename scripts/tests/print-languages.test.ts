// A second language on invoices: every label in every language, in its own script.
//
//   npx tsx --test scripts/tests/print-languages.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { LABEL_COUNT, labelsFor, PRINT_LANGUAGES, translate, type PrintLanguage } from '../../lib/print-languages';

const SCRIPT: Record<PrintLanguage, [number, number]> = {
  hi: [0x0900, 0x097f], mr: [0x0900, 0x097f], bn: [0x0980, 0x09ff], gu: [0x0a80, 0x0aff],
  ta: [0x0b80, 0x0bff], te: [0x0c00, 0x0c7f], kn: [0x0c80, 0x0cff], ml: [0x0d00, 0x0d7f],
};

test('every language has every label, written in its own script', () => {
  for (const lang of Object.keys(PRINT_LANGUAGES) as PrintLanguage[]) {
    const labels = labelsFor(lang);
    assert.equal(labels.length, LABEL_COUNT, `${lang} has ${labels.length} of ${LABEL_COUNT}`);
    const [lo, hi] = SCRIPT[lang];
    for (const l of labels) {
      assert.ok(l.trim(), `${lang}: an empty label`);
      // Letters only; hyphens, spaces, dots and zero-width joiners are allowed between them.
      const letters = [...l].filter((c) => /\p{L}|\p{M}/u.test(c));
      assert.ok(letters.length && letters.every((c) => c.codePointAt(0)! >= lo && c.codePointAt(0)! <= hi), `${lang}: "${l}" is not all in its script`);
    }
  }
});

test('labels are looked up by their English, and none without a second language', () => {
  assert.equal(translate('Tax Invoice', 'hi'), 'कर बीजक');
  assert.equal(translate('Invoice total', 'ta'), 'மொத்தத் தொகை');
  assert.equal(translate('Tax Invoice', null), null);
  assert.equal(translate('Something unknown', 'hi'), null);
});
