// The arXiv source reader's refusals (design/arxiv-proxy.md §4): every one is a TarError with a stable `code`, so the
// page can say what was wrong and a test can assert it. Codes starting "cap-" are a cap the source went past.

export type TarErrorCode =
  // the gzip stream (web/tar/inflate.ts)
  | "gzip" | "deflate" | "crc" | "length" | "truncated" | "trailing"
  // the tar archive (web/tar/read.ts)
  | "checksum" | "header" | "size" | "sparse" | "meta" | "name" | "duplicate" | "conflict" | "end"
  // a single gzipped file that isn't a TeX source
  | "format"
  // the caps (§4, accepted by LIMITS)
  | "cap-download" | "cap-total" | "cap-ratio" | "cap-file" | "cap-headers" | "cap-files" | "cap-entries" | "cap-meta"
  | "cap-longname" | "cap-budget";

export class TarError extends Error {
  constructor(public code: TarErrorCode, message: string) {
    super(message);
    this.name = "TarError";
  }
}
