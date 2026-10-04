// The parser is the trust boundary for an operator's spreadsheet: the header row becomes the
// placeholder vocabulary, and a phone number typed as a number in Excel must come back as the exact
// digits, never a rounded float. These tests build a real .xlsx (a zip of SpreadsheetML parts) so the
// xlsx path runs through read-excel-file end to end, not a stub.
import AdmZip from 'adm-zip';
import { BadRequestException } from '@nestjs/common';
import { cellToString, headerToKey, parseCsv, parseSpreadsheet } from './spreadsheet-parser';

const LIMITS = { maxRows: 100, maxColumns: 10, maxCellChars: 200 };

type Cell = string | number | null;

/** Build a minimal single-sheet .xlsx: strings as inline strings, numbers as numeric cells. */
function buildXlsx(rows: Cell[][]): Buffer {
  const col = (i: number): string => String.fromCharCode(65 + i);
  const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const sheetRows = rows
    .map((row, r) => {
      const cells = row
        .map((value, c) => {
          const ref = `${col(c)}${r + 1}`;
          if (value === null) return '';
          if (typeof value === 'number') return `<c r="${ref}"><v>${value}</v></c>`;
          return `<c r="${ref}" t="inlineStr"><is><t>${esc(value)}</t></is></c>`;
        })
        .join('');
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join('');
  const zip = new AdmZip();
  zip.addFile(
    '[Content_Types].xml',
    Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '</Types>',
    ),
  );
  zip.addFile(
    '_rels/.rels',
    Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>',
    ),
  );
  zip.addFile(
    'xl/workbook.xml',
    Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
    ),
  );
  zip.addFile(
    'xl/_rels/workbook.xml.rels',
    Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
        '</Relationships>',
    ),
  );
  zip.addFile(
    'xl/worksheets/sheet1.xml',
    Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        `<sheetData>${sheetRows}</sheetData></worksheet>`,
    ),
  );
  return zip.toBuffer();
}

describe('parseSpreadsheet', () => {
  it('reads an .xlsx, keeping a numeric phone cell as its exact digits', async () => {
    const xlsx = buildXlsx([
      ['Name', 'Phone', 'Amount'],
      ['Asha', 919876543210, 1250.5],
      ['Ravi', '+1 (555) 010-2233', 99],
    ]);
    const sheet = await parseSpreadsheet(xlsx, LIMITS);
    expect(sheet.columns).toEqual([
      { header: 'Name', key: 'Name' },
      { header: 'Phone', key: 'Phone' },
      { header: 'Amount', key: 'Amount' },
    ]);
    expect(sheet.rows).toEqual([
      { rowNumber: 2, values: { Name: 'Asha', Phone: '919876543210', Amount: '1250.5' } },
      { rowNumber: 3, values: { Name: 'Ravi', Phone: '+1 (555) 010-2233', Amount: '99' } },
    ]);
  });

  it('reads a CSV and maps headers to placeholder keys', async () => {
    const csv = Buffer.from('﻿First Name,Phone No.,First Name\r\nAsha,9876543210,dup\r\n');
    const sheet = await parseSpreadsheet(csv, LIMITS);
    expect(sheet.columns.map(c => c.key)).toEqual(['First_Name', 'Phone_No.', 'First_Name_2']);
    expect(sheet.rows[0].values).toEqual({ First_Name: 'Asha', 'Phone_No.': '9876543210', First_Name_2: 'dup' });
  });

  it('skips blank rows but keeps each row’s sheet line number', async () => {
    const sheet = await parseSpreadsheet(Buffer.from('Name,Phone\n\nAsha,1\n,\nRavi,2\n'), LIMITS);
    expect(sheet.rows.map(r => r.rowNumber)).toEqual([3, 5]);
  });

  it('rejects legacy .xls, binary garbage, empty files and over-limit sheets', async () => {
    await expect(parseSpreadsheet(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0]), LIMITS)).rejects.toThrow(/Legacy \.xls/);
    await expect(parseSpreadsheet(Buffer.from([1, 0, 2]), LIMITS)).rejects.toThrow(BadRequestException);
    await expect(parseSpreadsheet(Buffer.alloc(0), LIMITS)).rejects.toThrow(/empty/);
    const tooMany = 'P\n' + Array.from({ length: 5 }, (_, i) => String(i)).join('\n');
    await expect(parseSpreadsheet(Buffer.from(tooMany), { ...LIMITS, maxRows: 3 })).rejects.toThrow(/more than 3/);
    await expect(parseSpreadsheet(Buffer.from('A,B,C\n1,2,3'), { ...LIMITS, maxColumns: 2 })).rejects.toThrow(
      /3 columns/,
    );
    await expect(parseSpreadsheet(Buffer.from('A\n' + 'x'.repeat(300)), LIMITS)).rejects.toThrow(/longer than/);
  });

  it('rejects a zip that is not a workbook', async () => {
    const zip = new AdmZip();
    zip.addFile('hello.txt', Buffer.from('hi'));
    await expect(parseSpreadsheet(zip.toBuffer(), LIMITS)).rejects.toThrow(/could not be read/);
  });
});

describe('parseCsv', () => {
  it('handles quotes, doubled quotes, embedded newlines and semicolon exports', () => {
    expect(parseCsv('a;b\n"x;1";"say ""hi""\nthere"')).toEqual([
      ['a', 'b'],
      ['x;1', 'say "hi"\nthere'],
    ]);
    expect(parseCsv('a\tb\r1\t2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });
});

describe('cellToString / headerToKey', () => {
  it('renders dates without a time as a plain date and keeps minutes otherwise', () => {
    expect(cellToString(new Date('2026-10-01T00:00:00.000Z'))).toBe('2026-10-01');
    expect(cellToString(new Date('2026-10-01T09:30:00.000Z'))).toBe('2026-10-01 09:30');
    expect(cellToString(true)).toBe('TRUE');
    expect(cellToString(null)).toBe('');
  });

  it('falls back to a positional key for a header with no usable characters', () => {
    expect(headerToKey('  ', 2)).toBe('column_3');
    expect(headerToKey('₹ Amount (INR)', 0)).toBe('Amount_INR');
  });
});
