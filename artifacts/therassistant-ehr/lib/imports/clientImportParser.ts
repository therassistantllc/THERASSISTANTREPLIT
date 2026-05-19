import "server-only";

export interface ParsedClientImport {
  headers: string[];
  rows: Array<Record<string, string>>;
  totalRows: number;
}

function parseCsvMatrix(content: string): string[][] {
  const matrix: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  const text = content.replace(/^\uFEFF/, "");

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        field += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (!inQuotes && char === ",") {
      row.push(field.trim());
      field = "";
      continue;
    }

    if (!inQuotes && (char === "\n" || char === "\r")) {
      if (char === "\r" && next === "\n") {
        i += 1;
      }

      row.push(field.trim());
      const hasContent = row.some((value) => value.length > 0);
      if (hasContent) {
        matrix.push(row);
      }

      row = [];
      field = "";
      continue;
    }

    field += char;
  }

  row.push(field.trim());
  const hasContent = row.some((value) => value.length > 0);
  if (hasContent) {
    matrix.push(row);
  }

  return matrix;
}

function normalizeHeaders(rawHeaders: string[]): string[] {
  return rawHeaders.map((header, index) => {
    const value = header.trim();
    return value.length > 0 ? value : `column_${index + 1}`;
  });
}

export function parseClientImportFile(args: {
  fileName: string;
  mimeType?: string | null;
  content: string;
}): ParsedClientImport {
  const extension = args.fileName.split(".").pop()?.toLowerCase() ?? "";
  const mimeType = (args.mimeType ?? "").toLowerCase();

  const isCsv =
    extension === "csv" ||
    mimeType.includes("text/csv") ||
    mimeType.includes("application/csv") ||
    mimeType.includes("application/vnd.ms-excel");

  const isXlsx =
    extension === "xlsx" ||
    extension === "xls" ||
    mimeType.includes("spreadsheetml") ||
    mimeType.includes("application/vnd.ms-excel.sheet");

  if (isXlsx) {
    throw new Error("XLSX import is not supported yet. Please upload CSV.");
  }

  if (!isCsv) {
    throw new Error("Unsupported file type. Please upload a CSV file.");
  }

  const matrix = parseCsvMatrix(args.content);
  if (matrix.length === 0) {
    return {
      headers: [],
      rows: [],
      totalRows: 0,
    };
  }

  const headers = normalizeHeaders(matrix[0]);
  const rows = matrix.slice(1).map((entry) => {
    const row: Record<string, string> = {};
    for (let i = 0; i < headers.length; i += 1) {
      row[headers[i]] = (entry[i] ?? "").trim();
    }
    return row;
  });

  return {
    headers,
    rows,
    totalRows: rows.length,
  };
}
