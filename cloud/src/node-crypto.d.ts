declare module 'node:crypto' {
  type ScryptOptions = {
    N: number;
    r: number;
    p: number;
    maxmem: number;
  };

  export function scrypt(
    password: string,
    salt: string,
    keylen: number,
    options: ScryptOptions,
    callback: (error: Error | null, derivedKey: Uint8Array) => void,
  ): void;
}
