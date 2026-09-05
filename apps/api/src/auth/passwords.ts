import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';

const ARGON2_VERSION = 19;
const MEMORY_KIB = 65_536;
const PASSES = 3;
const PARALLELISM = 4;
const SALT_BYTES = 16;
const TAG_BYTES = 32;
const MAX_MEMORY_KIB = 262_144;
const MAX_PASSES = 10;
const MAX_PARALLELISM = 16;

interface ParsedPasswordHash {
  digest: Buffer;
  memory: number;
  parallelism: number;
  passes: number;
  salt: Buffer;
}

function derivePassword(
  password: string,
  salt: Buffer,
  options: Pick<ParsedPasswordHash, 'memory' | 'parallelism' | 'passes'>,
  tagLength: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2(
      'argon2id',
      {
        memory: options.memory,
        message: password,
        nonce: salt,
        parallelism: options.parallelism,
        passes: options.passes,
        tagLength,
      },
      (error, derivedKey) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(derivedKey);
      },
    );
  });
}

function encodeBase64(value: Buffer): string {
  return value.toString('base64').replace(/=+$/u, '');
}

function parseBase64(value: string): Buffer | undefined {
  if (!/^[A-Za-z0-9+/]+$/u.test(value)) {
    return undefined;
  }

  return Buffer.from(value, 'base64');
}

function parsePasswordHash(encoded: string): ParsedPasswordHash | undefined {
  const match =
    /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/u.exec(
      encoded,
    );
  if (!match) {
    return undefined;
  }

  const [, memoryValue, passesValue, parallelismValue, saltValue, digestValue] = match;
  const memory = Number(memoryValue);
  const passes = Number(passesValue);
  const parallelism = Number(parallelismValue);
  const salt = saltValue === undefined ? undefined : parseBase64(saltValue);
  const digest = digestValue === undefined ? undefined : parseBase64(digestValue);

  if (
    !Number.isInteger(memory) ||
    memory < 8_192 ||
    memory > MAX_MEMORY_KIB ||
    !Number.isInteger(passes) ||
    passes < 2 ||
    passes > MAX_PASSES ||
    !Number.isInteger(parallelism) ||
    parallelism < 2 ||
    parallelism > MAX_PARALLELISM ||
    memory <= 8 * parallelism ||
    !salt ||
    salt.length < SALT_BYTES ||
    salt.length > 64 ||
    !digest ||
    digest.length < 16 ||
    digest.length > 64
  ) {
    return undefined;
  }

  return { digest, memory, parallelism, passes, salt };
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const digest = await derivePassword(
    password,
    salt,
    {
      memory: MEMORY_KIB,
      parallelism: PARALLELISM,
      passes: PASSES,
    },
    TAG_BYTES,
  );

  return `$argon2id$v=${ARGON2_VERSION}$m=${MEMORY_KIB},t=${PASSES},p=${PARALLELISM}$${encodeBase64(salt)}$${encodeBase64(digest)}`;
}

export async function verifyPassword(encoded: string, password: string): Promise<boolean> {
  const parsed = parsePasswordHash(encoded);
  if (!parsed) {
    return false;
  }

  const candidate = await derivePassword(password, parsed.salt, parsed, parsed.digest.length);
  return timingSafeEqual(candidate, parsed.digest);
}
