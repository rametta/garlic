/**
 * Helpers for previewing image diffs by MIME type and object URL conversion.
 * Search tags: image diff preview, mime type, base64 object url, renderable image path.
 */
export function pathLooksLikeRenderableImage(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return /\.(png|jpe?g|gif|webp|bmp|ico|svg)$/.test(lower);
}

export function mimeTypeForImagePath(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".bmp")) return "image/bmp";
  if (lower.endsWith(".ico")) return "image/x-icon";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

export function base64ToObjectUrl(base64: string | null | undefined, mime: string): string | null {
  if (base64 == null || base64 === "") return null;
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return URL.createObjectURL(new Blob([bytes], { type: mime }));
  } catch {
    return null;
  }
}
