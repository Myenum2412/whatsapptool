import { BadRequestException } from '@nestjs/common';
import { readSheet } from 'read-excel-file/node';

/** One spreadsheet column: the header as written, and the `{{key}}` a template uses to reference it. */
export interface SpreadsheetColumn {
  header: string;
  key: string;
}

/** One data row. `rowNumber` is the 1-based line in the sheet (the header is row 1), for reporting. */
export interface SpreadsheetRow {
  rowNumber: number;
  values: Record<string, string>;
}

export interface ParsedSpreadsheet {
  columns: SpreadsheetColumn[];
  rows: SpreadsheetRow[];
}

export interface SpreadsheetLimits {
  maxRows: number;
  maxColumns: number;
  maxCellChars: number;
}

// `PK\x03\x04` — an .xlsx is a zip container. The legacy binary .xls is an OLE compound file.
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0]);

/**
 * Parse an uploaded spreadsheet (.xlsx or .csv) into columns and rows. The first non-empty row is the
 * header. Fully empty rows are dropped but keep their line numbers out of the count, so a row number
 * in a campaign report points at the same line the operator sees in their sheet.
 *
 * The format is sniffed from the bytes rather than trusted from the filename or MIME type: browsers
 * report `.csv` as anything from `text/csv` to `application/vnd.ms-excel`.
 */
export async function parseSpreadsheet(buffer: Buffer, limits: SpreadsheetLimits): Promise<ParsedSpreadsheet> {
  if (!buffer || buffer.length === 0) {
    throw new BadRequestException('The uploaded file is empty');
  }
  let grid: string[][];
  if (buffer.subarray(0, 4).equals(ZIP_MAGIC)) {
    grid = await readXlsxGrid(buffer);
  } else if (buffer.subarray(0, 4).equals(OLE_MAGIC)) {
    throw new BadRequestException('Legacy .xls files are not supported; save the sheet as .xlsx or .csv');
  } else {
    if (buffer.includes(0)) {
      throw new BadRequestException('Unrecognised file: upload an .xlsx workbook or a UTF-8 .csv file');
    }
    grid = parseCsv(buffer.toString('utf8'));
  }
  return gridToSpreadsheet(grid, limits);
}

async function readXlsxGrid(buffer: Buffer): Promise<string[][]> {
  let data: unknown[][];
  try {
    // parseNumber keeps numeric cells as the digits Excel stored: a phone number typed as a number
    // must not round-trip through a float (or come back as 9.19876543210e+11).
    data = await readSheet(buffer, { parseNumber: (value: string) => value });
  } catch {
    throw new BadRequestException('The .xlsx file could not be read; check it is a valid Excel workbook');
  }
  return data.map(row => row.map(cellToString));
}

/** Render one xlsx cell as the text a message should show. */
export function cellToString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return '';
    const iso = value.toISOString();
    // Excel dates carry no zone; read-excel-file hands them over as UTC. A whole day is shown as a
    // date, anything with a time of day keeps the minutes.
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
  }
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number') return String(value);
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Minimal RFC 4180 CSV reader: quoted fields, doubled quotes, embedded newlines, CRLF/CR/LF. The
 * delimiter is detected from the header line (comma, semicolon or tab — spreadsheet exports in
 * locales with a decimal comma write semicolons).
 */
export function parseCsv(text: string): string[][] {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const delimiter = detectDelimiter(input);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === '') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && input[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.map(r => r.map(cell => cell.trim()));
}

function detectDelimiter(text: string): string {
  let firstLine = '';
  let inQuotes = false;
  for (const ch of text) {
    if (ch === '"') inQuotes = !inQuotes;
    if (!inQuotes && (ch === '\n' || ch === '\r')) break;
    if (!inQuotes) firstLine += ch;
  }
  const counts = [',', ';', '\t'].map(d => [d, firstLine.split(d).length - 1] as const);
  const [best] = [...counts].sort((a, b) => b[1] - a[1]);
  return best[1] > 0 ? best[0] : ',';
}

/**
 * Turn a header into a placeholder key the template renderer can match (`[\w.-]+`): runs of any
 * other character become `_`, so `First Name` is referenced as `{{First_Name}}`.
 */
export function headerToKey(header: string, index: number): string {
  const key = header
    .trim()
    .replace(/[^\w.-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return key || `column_${index + 1}`;
}

function gridToSpreadsheet(grid: string[][], limits: SpreadsheetLimits): ParsedSpreadsheet {
  const isBlank = (row: string[]): boolean => row.every(cell => cell === '');
  const headerIndex = grid.findIndex(row => !isBlank(row));
  if (headerIndex === -1) {
    throw new BadRequestException('The spreadsheet has no header row');
  }

  const headerRow = grid[headerIndex];
  // Trailing unnamed columns are formatting residue, not data.
  let width = headerRow.length;
  while (width > 0 && headerRow[width - 1] === '') width--;
  if (width > limits.maxColumns) {
    throw new BadRequestException(`The spreadsheet has ${width} columns; at most ${limits.maxColumns} are supported`);
  }

  const seen = new Map<string, number>();
  const columns: SpreadsheetColumn[] = headerRow.slice(0, width).map((header, i) => {
    const base = headerToKey(header, i);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return { header: header || `Column ${i + 1}`, key: count === 1 ? base : `${base}_${count}` };
  });

  const rows: SpreadsheetRow[] = [];
  for (let i = headerIndex + 1; i < grid.length; i++) {
    const cells = grid[i].slice(0, width);
    if (isBlank(cells)) continue;
    if (rows.length >= limits.maxRows) {
      throw new BadRequestException(`The spreadsheet has more than ${limits.maxRows} data rows; split it up`);
    }
    const values: Record<string, string> = {};
    columns.forEach((column, c) => {
      const value = cells[c] ?? '';
      if (value.length > limits.maxCellChars) {
        throw new BadRequestException(
          `Row ${i + 1}, column "${column.header}" is longer than ${limits.maxCellChars} characters`,
        );
      }
      values[column.key] = value;
    });
    rows.push({ rowNumber: i + 1, values });
  }
  return { columns, rows };
}
