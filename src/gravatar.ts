/**
 * Lightweight Gravatar helpers, including a local MD5 implementation for email hashing.
 * Search tags: gravatar, md5, avatar url, author avatar fallback.
 */
const MD5_SHIFT_AMOUNTS = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14,
  20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6,
  10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
] as const;

const MD5_K = Array.from(
  { length: 64 },
  (_, index) => Math.floor(Math.abs(Math.sin(index + 1)) * 0x1_0000_0000) >>> 0,
);

function leftRotate32(value: number, shift: number): number {
  return ((value << shift) | (value >>> (32 - shift))) >>> 0;
}

function wordToHexLittleEndian(word: number): string {
  return [word & 0xff, (word >>> 8) & 0xff, (word >>> 16) & 0xff, (word >>> 24) & 0xff]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Small MD5 helper for Gravatar email hashes. */
export function md5Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const bitLength = BigInt(bytes.length) * 8n;
  const paddedLength = ((bytes.length + 9 + 63) >> 6) << 6;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;

  for (let index = 0; index < 8; index += 1) {
    padded[padded.length - 8 + index] = Number((bitLength >> BigInt(index * 8)) & 0xffn);
  }

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const words = new Uint32Array(16);

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      const base = offset + index * 4;
      words[index] =
        (padded[base] |
          (padded[base + 1] << 8) |
          (padded[base + 2] << 16) |
          (padded[base + 3] << 24)) >>>
        0;
    }

    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for (let index = 0; index < 64; index += 1) {
      let f = 0;
      let g = 0;
      if (index < 16) {
        f = ((b & c) | (~b & d)) >>> 0;
        g = index;
      } else if (index < 32) {
        f = ((d & b) | (~d & c)) >>> 0;
        g = (5 * index + 1) % 16;
      } else if (index < 48) {
        f = (b ^ c ^ d) >>> 0;
        g = (3 * index + 5) % 16;
      } else {
        f = (c ^ (b | ~d)) >>> 0;
        g = (7 * index) % 16;
      }

      const next =
        (b + leftRotate32((a + f + MD5_K[index] + words[g]) >>> 0, MD5_SHIFT_AMOUNTS[index])) >>> 0;
      a = d;
      d = c;
      c = b;
      b = next;
    }

    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  return (
    wordToHexLittleEndian(a0) +
    wordToHexLittleEndian(b0) +
    wordToHexLittleEndian(c0) +
    wordToHexLittleEndian(d0)
  );
}

export function normalizeGravatarEmail(email: string): string {
  return email.trim().toLowerCase();
}

function arrayBufferToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const sha256PromiseCache = new Map<string, Promise<string>>();

export function sha256Hex(input: string): Promise<string> {
  const cached = sha256PromiseCache.get(input);
  if (cached) return cached;

  const promise = crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(input))
    .then((buffer) => arrayBufferToHex(buffer));

  sha256PromiseCache.set(input, promise);
  return promise;
}

export function buildGravatarUrlForHash(
  hash: string,
  size = 32,
  defaultImage: "404" | "identicon" = "identicon",
): string {
  const params = new URLSearchParams({
    d: defaultImage,
    r: "g",
    s: String(Math.max(16, Math.round(size))),
  });
  return `https://www.gravatar.com/avatar/${hash}?${params.toString()}`;
}

function githubUsernameFromEmail(email: string): string | null {
  const match = /^(?:\d+\+)?([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)@users\.noreply\.github\.com$/.exec(
    email,
  );
  return match?.[1] ?? null;
}

export function buildGitHubAvatarUrl(email: string, size = 32): string | null {
  const normalized = normalizeGravatarEmail(email);
  const username = githubUsernameFromEmail(normalized);
  if (!username) return null;
  const params = new URLSearchParams({
    size: String(Math.max(16, Math.round(size))),
  });
  return `https://github.com/${encodeURIComponent(username)}.png?${params.toString()}`;
}

export async function buildGravatarUrlCandidates(email: string, size = 32): Promise<string[]> {
  const normalized = normalizeGravatarEmail(email);
  if (!normalized) return [];

  const candidates: string[] = [];
  const pushUnique = (url: string) => {
    if (!candidates.includes(url)) candidates.push(url);
  };

  try {
    const sha256 = await sha256Hex(normalized);
    pushUnique(buildGravatarUrlForHash(sha256, size, "404"));
  } catch {
    // Ignore; older environments can still try legacy MD5 below.
  }

  const md5 = md5Hex(normalized);
  pushUnique(buildGravatarUrlForHash(md5, size, "404"));

  const gitHubAvatar = buildGitHubAvatarUrl(normalized, size);
  if (gitHubAvatar) {
    pushUnique(gitHubAvatar);
  }

  try {
    const sha256 = await sha256Hex(normalized);
    pushUnique(buildGravatarUrlForHash(sha256, size, "identicon"));
  } catch {
    // Ignore; we'll still have the legacy identicon path below.
  }

  pushUnique(buildGravatarUrlForHash(md5, size, "identicon"));
  return candidates;
}
