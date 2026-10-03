# カイセンの検査を作業単位でまとめる

## 採用範囲

2026-10-03の利用者の指示により、共通ハーネスの[検査集約規約](https://github.com/chameleonjp-lab/chameleonjp-browser-game-harness/blob/50229ded69378ed6392453e73856482eb78b7354/references/test-batching.md)と[台帳項目](https://github.com/chameleonjp-lab/chameleonjp-browser-game-harness/blob/50229ded69378ed6392453e73856482eb78b7354/templates/TEST_LEDGER.md)を、この作品の実行頻度の補足として採用する。元のハーネスはdocs/HARNESS.mdのv2.6.0 / c60683b504b68262dae8b4fc723b416077def8b5を維持する。hub全体の更新や任意Python判定器の導入ではない。

## 一つの修正から提出まで

1. 現在のbase/head、AGENTS、対象コード・検査・workflowを確認する。一つの原因修正/機能/レビュー対応を作業単位とし、完了条件を先に定める。
2. 直接・推移影響から関連検査を選び、編集→関連検査→修正をまとめる。たとえば入力なら所有/解除/モードと実画面の異常経路、戦闘なら命中/陣営/勝敗/補充、表示なら対象寸法と実画像を検査する。単体成功を画面成功と扱わない。
3. 意味のある修正と検査記録をまとめて一度pushする。途中共有や必要なバックアップを妨げないが、細かい文言更新ごとにPRを更新して全体CIを再発火させない。
4. 作業単位の終了・最終候補・提出・merge/release判断では、現候補に必要な全体ゲートを通す。既知失敗は保存し、失敗条件と関連検査を直してから全体へ戻す。人がマージするまでmainへ直接書かない。

「全体」は既存の`npm test`、`npm run build`（TypeScript＋Vite）、`BUILD_COMMIT=<候補SHA> node scripts/prepare-pages.mjs`、`npm run test:browser`の適用集合。現行CIのcheck名は`verify`で、PR更新時にunit/build/成果物/ブラウザを実行する。ラベルや手動操作だけに検査を移す変更はしていない。公開はその時点で有効な利用者の別途承認の範囲で扱う。

## 編集途中だけ全体再実行を延期できる条件

次の全条件を満たす場合だけ、一時的に関連検査へ絞る。

- 同じ作業単位の実測した全体passがあり、その終了から0〜30分以内
- その完全SHA/tree（未コミットなら全内容識別）から現在候補までの累積差分と直接・推移影響を確認し、現在候補の関連検査がすべてpass
- toolchain、環境、lockfile、設定、assets、test logicの一致が確認でき、未検査領域への非影響を説明できる
- 高リスクでなく、未解消のfail/blockedがなく、終了・提出・最終候補の境界ではない

入力所有、得点/勝敗確定、保存移行、権限、資産の読込境界などは時刻を理由に必要な異常系・統合検査を延期しない。仕様やテスト手順を含むMarkdownも無条件に安全な差分とは扱わない。依存や影響が不明なら広く検査する。

延期は`not_run`として理由・未検査領域・次の実行契機を残す。30分の起点は最後の全体passの終了で固定し、関連passや新commitで延長しない。作業単位をまたいで使わず、定期起動も作らない。時間超過後に作業を続ける時、範囲/環境変更、失敗、作業境界のうち最初の契機で全体へ戻す。

## 記録・成果物・自動CI

既存のdocs/VERIFICATION.mdと提出PRへ次をまとめ、同じ内容の別台帳を増やさない。

- 作業単位と終了条件、候補SHA/tree、dirty差分と全内容識別
- 基準の全体検査SHA/tree・終了日時（timezone付き）・run URL、現在までの累積pathと影響根拠
- コマンド/条件、実行契機、local/CI、実行対象、exitとpass/fail/not_run/blocked、未確認項目
- Node/npm等の版、lockfile/build設定/assets/test logic/環境の識別。秘密値は記録しない
- 再利用するbuild/artifactの対象内容・期限・整合性と、再buildが必要になる条件
- 元の失敗→修正→関連検査→最終候補の全体結果の対応

古いSHAのpassを現在SHAへ付け替えない。cache hitは検査成功ではなく、別内容の成果物をリネームして再利用しない。文書だけの最終追記も実行関連内容の同一性・差分・除外根拠を記録し、現在SHAに要求されるCI規則を守る。

この採用ではworkflow/check名/保護/merge gate、依存cache、公開workflowを変更しない。現行のPR synchronizeごとの全件CIは、一つの修正をまとめてpushすることで発火回数を減らす。さらにpath分類等が必要な場合は、未知pathを検査側へ倒すこと、必要checkのpendingや偽passを作らないこと、副作用のある配備をテスト同様にcancelしないことを別の変更で検証する。削減量は未実測。
