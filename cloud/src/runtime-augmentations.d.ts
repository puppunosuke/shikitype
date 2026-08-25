// `wrangler types` が生成する Env に、設定ファイルへ書けない secret の型だけを補う。
interface Env {
  AUTH_PEPPER: string;
}

interface SubtleCrypto {
  timingSafeEqual(left: BufferSource, right: BufferSource): boolean;
}
