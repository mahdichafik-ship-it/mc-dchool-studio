/**
 * CSV detection is intentionally based on the filename extension. Browsers
 * commonly provide an empty or vendor-specific MIME type for CSV uploads.
 */
export function isCsvFileName(fileName: string): boolean {
  return fileName.toLocaleLowerCase().endsWith(".csv");
}