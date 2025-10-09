import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildAggregatedReportData,
  compareDatasets,
  convertRowsToCsv,
  sanitizeFilename,
  sanitizeRows
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
