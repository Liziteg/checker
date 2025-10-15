import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildAggregatedReportData,
  compareDatasets,
  convertRowsToCsv,
  hasMeaningfulColumnStructure,
  isUndetectableDelimiterError,
  selectDelimiterFromSample,
  sanitizeFilename,
  sanitizeRows,
  shouldRetryWithFallbackDelimiter
} from '../script.js';

test('compareDatasets detects mismatches and missing records', () => {
  const datasetA = {
    rows: [
      { POLICY_NO: '1', Amount: '100', Status: 'Active' },
      { POLICY_NO: '2', Amount: '150', Status: 'Pending' }
    ]
  };
  const datasetB = {
    rows: [
      { policy_no: '1', Amount: '110', Status: 'Active' },
      { policy_no: '3', Amount: '200', Status: 'Closed' }
    ]
  };

  const result = compareDatasets(datasetA, datasetB, 'POLICY_NO', 'A.csv', 'B.csv');
  assert.equal(result.differences.length, 3);
  assert.deepEqual(
    new Set(result.differences.map((diff) => diff.difference_type)),
    new Set(['value_mismatch', 'missing_in_a', 'missing_in_b'])
  );
  assert.equal(result.headers.key, 'POLICY_NO');
});

test('buildAggregatedReportData summarizes differences by column', () => {
  const differences = [
    { column: 'Amount', difference_type: 'value_mismatch' },
    { column: 'Amount', difference_type: 'value_mismatch' },
    { column: '__missing__', difference_type: 'missing_in_a' }
  ];

  const rows = buildAggregatedReportData(differences);
  assert.deepEqual(rows[0], [
    'Поле',
    'Всего расхождений',
    'Несовпадений значений',
    'Отсутствует в файле 1',
    'Отсутствует в файле 2'
  ]);
  assert.deepEqual(rows[1], ['Amount', '2', '2', '0', '0']);
  assert.deepEqual(rows[2], ['Строка отсутствует', '1', '0', '1', '0']);
});

test('sanitizeRows drops dangerous prototype pollution keys', () => {
  const polluted = sanitizeRows([
    { __proto__: { hacked: true }, ' constructor ': 'oops', Normal: 'value' }
  ]);

  assert.deepEqual(polluted, [{ Normal: 'value' }]);
  assert.equal(Object.prototype.hacked, undefined);
});

test('sanitizeFilename produces safe basename', () => {
  assert.equal(sanitizeFilename('../../secret.txt'), 'secret.txt');
  assert.equal(sanitizeFilename(''), 'report');
});

test('convertRowsToCsv quotes cells with commas and quotes', () => {
  const csv = convertRowsToCsv([
    ['Field', 'Value'],
    ['note', 'needs, quoting'],
    ['quote', '"hello"']
  ]);

  assert.equal(
    csv,
    'Field,Value\r\nnote,"needs, quoting"\r\nquote,"""hello"""'
  );
});

test('shouldRetryWithFallbackDelimiter requests retry when delimiter is unknown', () => {
  const result = {
    rows: [
      { 'POLICY_NO;Amount': '1;100' }
    ],
    meta: { fields: ['POLICY_NO;Amount'] },
    errors: [
      {
        code: 'UndetectableDelimiter',
        message: "Unable to auto-detect delimiting character; defaulted to ','"
      }
    ]
  };

  assert.equal(shouldRetryWithFallbackDelimiter(result), true);
});

test('shouldRetryWithFallbackDelimiter does not retry when columns are meaningful', () => {
  const result = {
    rows: [
      { POLICY_NO: '1', Amount: '200' }
    ],
    meta: { fields: ['POLICY_NO', 'Amount'] },
    errors: [
      {
        code: 'UndetectableDelimiter',
        message: "Unable to auto-detect delimiting character; defaulted to ','"
      }
    ]
  };

  assert.equal(shouldRetryWithFallbackDelimiter(result), false);
});

test('hasMeaningfulColumnStructure checks field information and rows', () => {
  assert.equal(hasMeaningfulColumnStructure([{ A: '1', B: '2' }], {}), true);
  assert.equal(hasMeaningfulColumnStructure([{ only: 'value' }], { fields: ['only'] }), false);
});

test('isUndetectableDelimiterError recognizes Papa Parse warnings', () => {
  assert.equal(isUndetectableDelimiterError({ code: 'UndetectableDelimiter' }), true);
  assert.equal(
    isUndetectableDelimiterError({ message: 'Unable to auto-detect delimiting character; defaulted to \';\'' }),
    true
  );
  assert.equal(isUndetectableDelimiterError({ message: 'Different error' }), false);
});


test('selectDelimiterFromSample picks semicolon when columns align', () => {
  const sample = [
    'POLICY_NO;Amount;Status',
    '1;100;Active',
    '2;150;Pending',
    '3;200;Closed'
  ].join('\n');

  assert.equal(selectDelimiterFromSample(sample), ';');
});

test('selectDelimiterFromSample returns null when delimiter is ambiguous', () => {
  const sample = [
    'Just one column value',
    'Another line without delimiter'
  ].join('\n');

  assert.equal(selectDelimiterFromSample(sample), null);
});
