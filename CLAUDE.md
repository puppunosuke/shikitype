# SHIKITYPE project instructions

- 拓男は、SHIKITYPEの通常の実装変更について、テスト後のGit commit・push・本番deployを都度確認なしで進めることを恒常承認している。
- 公開前に対象差分を限定し、関連テストと本番URLの実動作を確認し、戻せるversionを把握する。
- 課金・契約・secret変更・本番データの破壊やmigrationなど、通常のコード公開を超える操作はこの承認に含めない。
- ワークスペースルートの無関係なdirty差分を、SHIKITYPEのcommitへ混ぜない。

## 正本と同期（2026-08-31 制定）

**このリポジトリ（`https://github.com/puppunosuke/shikitype`）が正本。** 社内モノレポ側に存在する
作業コピー（例: `neo-math-solution/`）は正本ではない。過去にこの2箇所を手作業（ファイルコピー）で
同期していたため、テストファイルだけ更新が漏れて公開リポジトリ側だけREADMEの手順が失敗する事故が
起きた（AIRFLOW `3E6A`）。再発防止のため、同期は次の1本の手順に固定する。

1. 開発・修正は必ずこのリポジトリの作業クローン内で行う。他の場所で編集してからここへ手作業コピー
   することはしない。
2. 変更はこのクローン内で `git add` → `git commit`。拓男のGo後に `git push` する。
3. 別の作業コピー（社内モノレポ等）を最新化したいときは、このリポジトリを起点に `git pull` /
   再cloneして上書きする。逆方向（他の作業コピー → このリポジトリへの手作業コピー）は行わない。
4. pushの前に、README「テスト」節の手順（`spike`のPlaywright、`node --test tests/*.test.mjs`、
   `cloud/`の`npm run check`）を実行し、全件通ることを確認する。

### 検証環境の既知の副作用

- `cloud/.dev.vars` を用意していない環境で `npm run check`（内部で `wrangler types` を実行する）を
  走らせると、生成物 `cloud/worker-configuration.d.ts` から `OPENAI_API_KEY` の型定義が落ちる
  （`.dev.vars` の有無で `wrangler types` の出力が変わるため）。secretなしで検証した後にこの
  ファイルの差分をそのままcommitしない。差分が生成物だけなら `git checkout -- cloud/worker-configuration.d.ts`
  で戻してからcommitする。
