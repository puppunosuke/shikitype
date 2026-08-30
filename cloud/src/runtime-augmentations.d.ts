// `wrangler types` が生成する Env に、設定ファイルへ書けない secret の型だけを補う。
interface Env {
  AUTH_PEPPER: string;
  GOOGLE_CLIENT_ID?: string;
  // Secretの有無によって`wrangler types`の生成結果が変わっても、CIと本番で
  // 同じソースを型検査できるよう必須型を補う。実行時の欠落チェックは残す。
  OPENAI_API_KEY: string;
}

interface SubtleCrypto {
  timingSafeEqual(left: BufferSource, right: BufferSource): boolean;
}
