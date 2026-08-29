# SHIKITYPE project instructions

- 拓男は、SHIKITYPEの通常の実装変更について、テスト後のGit commit・push・本番deployを都度確認なしで進めることを恒常承認している。
- 公開前に対象差分を限定し、関連テストと本番URLの実動作を確認し、戻せるversionを把握する。
- 課金・契約・secret変更・本番データの破壊やmigrationなど、通常のコード公開を超える操作はこの承認に含めない。
- ワークスペースルートの無関係なdirty差分を、SHIKITYPEのcommitへ混ぜない。
