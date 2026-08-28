// `wrangler types` が生成する Env に、設定ファイルへ書けない secret の型だけを補う。
interface Env {
  AUTH_PEPPER: string;
  GOOGLE_CLIENT_ID?: string;
  // 本番では `wrangler secret put OPENAI_API_KEY` だけで渡す。varsには置かない。
  OPENAI_API_KEY?: string;
}

interface SubtleCrypto {
  timingSafeEqual(left: BufferSource, right: BufferSource): boolean;
}
