// `wrangler types` が生成する Env に、設定ファイルへ書けない secret の型だけを補う。
interface Env {
  AUTH_PEPPER: string;
  GOOGLE_CLIENT_ID?: string;
  // OPENAI_API_KEY は以前ここで `?: string`（省略可）として補っていたが、本番に
  // `wrangler secret put OPENAI_API_KEY` を登録したことで `wrangler types` が
  // 生成する worker-configuration.d.ts 側が `OPENAI_API_KEY: string`（必須）を
  // 宣言するようになった。同名interfaceの宣言マージで「必須を省略可で上書き」は
  // 型エラー(TS2430)になるため、ここでの重複宣言はやめて生成物に委ねる。
  // 実行時の安全性はこの型に依存していない: ローカル開発でsecret未設定のときは
  // 実際には`undefined`になり得るので、呼び出し側(src/index.ts responseJson)の
  // `if (!env.OPENAI_API_KEY) throw new ApiError(503, 'review_not_configured')`が
  // 実行時ガードとして機能する。型が「必須」でも実行時の欠落チェックは外さない。
}

interface SubtleCrypto {
  timingSafeEqual(left: BufferSource, right: BufferSource): boolean;
}
