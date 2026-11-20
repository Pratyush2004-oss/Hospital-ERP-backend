import { AppError } from "../http-error.js";

/**
 * Content validation for uploaded patient documents.
 *
 * The declared MIME type and filename come from the client and are therefore
 * untrusted. Validation has three independent parts:
 *
 * 1. the extension must be on a short allow-list,
 * 2. the declared MIME type must match that extension,
 * 3. the file signature (magic bytes) must match both.
 *
 * This is signature *matching*, not malware scanning. A file that passes can
 * still be malicious; see the scanner integration point in the document service.
 */

export type DocumentKind = "pdf" | "jpeg" | "png" | "webp";

const EXTENSION_KINDS: Readonly<Record<string, DocumentKind>> = {
  pdf: "pdf",
  jpg: "jpeg",
  jpeg: "jpeg",
  png: "png",
  webp: "webp",
};

const KIND_MIME: Readonly<Record<DocumentKind, string>> = {
  pdf: "application/pdf",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

const KIND_EXTENSION: Readonly<Record<DocumentKind, string>> = {
  pdf: "pdf",
  jpeg: "jpg",
  png: "png",
  webp: "webp",
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Recognises a supported format from its leading bytes, or `null`. */
export function sniffDocumentKind(data: Buffer): DocumentKind | null {
  if (data.length >= 5 && data.subarray(0, 5).toString("latin1") === "%PDF-") {
    return "pdf";
  }

  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return "jpeg";
  }

  if (data.length >= PNG_SIGNATURE.length && data.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return "png";
  }

  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString("latin1") === "RIFF" &&
    data.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "webp";
  }

  return null;
}

/**
 * Reduces a client filename to a safe metadata value: basename only, control
 * characters and path separators removed, length capped. The stored object name
 * is always a server-generated UUID, so this value is display metadata only.
 */
export function sanitizeFileName(rawFileName: string, extension: string): string {
  const base = rawFileName.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[^\p{L}\p{N}._ ()-]/gu, "_")
    .replace(/_{2,}/g, "_")
    .trim()
    .replace(/^\.+/, "");

  const fallback = `document.${extension}`;

  if (cleaned.length === 0) return fallback;

  const maxLength = 255;

  if (cleaned.length <= maxLength) return cleaned;

  // Preserve the extension when truncating a long name.
  const dot = cleaned.lastIndexOf(".");

  if (dot <= 0) return cleaned.slice(0, maxLength);

  const suffix = cleaned.slice(dot);
  const stemLimit = Math.max(1, maxLength - suffix.length);

  return `${cleaned.slice(0, stemLimit)}${suffix}`;
}

export interface DocumentUploadInput {
  readonly fileName: string;
  readonly mimeType: string;
  readonly data: Buffer;
}

export interface ValidatedDocumentUpload {
  readonly fileName: string;
  readonly mimeType: string;
  readonly extension: string;
  readonly kind: DocumentKind;
  readonly fileSize: number;
}

function normalizeMimeType(value: string): string {
  return value.split(";")[0]?.trim().toLowerCase() ?? "";
}

function extensionOf(fileName: string): string {
  const trimmed = fileName.trim();
  const dot = trimmed.lastIndexOf(".");

  if (dot < 0 || dot === trimmed.length - 1) return "";

  return trimmed.slice(dot + 1).toLowerCase();
}

/**
 * Validates one upload and returns the canonical metadata to persist.
 * Every failure is a safe 422; raw file contents are never included.
 */
export function validateDocumentUpload(
  input: DocumentUploadInput,
  maxFileSizeBytes: number,
): ValidatedDocumentUpload {
  if (input.data.length === 0) {
    throw AppError.validation("The uploaded file is empty");
  }

  if (input.data.length > maxFileSizeBytes) {
    throw AppError.validation(
      `The uploaded file exceeds the maximum size of ${maxFileSizeBytes} bytes`,
    );
  }

  const extension = extensionOf(input.fileName);

  if (extension.length === 0) {
    throw AppError.validation(
      "The uploaded file needs an extension (pdf, jpg, jpeg, png or webp)",
    );
  }

  const kind = EXTENSION_KINDS[extension];

  if (kind === undefined) {
    throw AppError.validation(
      "Unsupported file extension; allowed extensions are pdf, jpg, jpeg, png and webp",
    );
  }

  const mimeType = normalizeMimeType(input.mimeType);

  if (mimeType.length === 0) {
    throw AppError.validation("The uploaded file needs a MIME type");
  }

  const expectedMime = KIND_MIME[kind];

  if (mimeType !== expectedMime) {
    throw AppError.validation(
      `The declared MIME type does not match the .${extension} extension (expected ${expectedMime})`,
    );
  }

  const detected = sniffDocumentKind(input.data);

  if (detected === null) {
    throw AppError.validation("The uploaded file is not a supported document format");
  }

  if (detected !== kind) {
    throw AppError.validation("The file content does not match its extension");
  }

  return {
    fileName: sanitizeFileName(input.fileName, KIND_EXTENSION[kind]),
    mimeType: expectedMime,
    extension: KIND_EXTENSION[kind],
    kind,
    fileSize: input.data.length,
  };
}
