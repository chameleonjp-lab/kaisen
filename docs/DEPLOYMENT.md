# 最新公開の確認（2026-10-03 15:03:58 UTC）

利用者がPR9を14:56:55 UTCにマージ。main `8663af9b67c31b01c7b7b0b16a605fd0b9b32770` は検査済みhead9adeb05とtree7d876ad6が一致し、[Pages run37131825873](https://github.com/chameleonjp-lab/kaisen/actions/runs/37131825873)で公開した。統合mainの202単体・型/build・成果物検査とdeploy成功。公開ページのJS index-BFEt2XH3.js/CSS index-DWkLjsCm.css、両モード、爆弾/魚雷を含む配置設定・音ON/OFFを確認。配布artifact11277022330の216238bytes/SHA256 c3b62ca4c81a4a81b644592d866b5faba91fdea29f67be748fdf31bca8bc04e9と内部4ファイルを照合した。

公開JS本文への直接アクセスはERR_BLOCKED_BY_CLIENT、cloud WebGLはDisabledのため公開応答全文hashと実飛行は未確認。制限を別経路で迂回していない。今回F01–F10の実機修正候補は未公開。2026-10-03 23:36 UTCの公開DOM再読取でも上記アセット名が一致した。

# GitHub Pagesへの配備

## 現在の公開版（2026-10-03 05:32 UTC）

PR #7/#8を利用者がマージしたmain `c63bff8b328676f2435ee50454143f321eef1ddd` を [run37100074074](https://github.com/chameleonjp-lab/kaisen/actions/runs/37100074074) で配備した。完全SHAに対する124単体・型/build・成果物検査と配備が成功。公開ページの40秒/4隻ルール、Easy/Normal、設定の開閉・音ON/OFF、読込JS `index-yFASa3PT.js` / CSS `index-fnb94wU2.css` と配備artifactの対応を確認。公開応答全体のSHAや禁止されているmanifest URLの取得を確認済みとはしない。クラウドWebGL無効のため公開飛行は未確認。今回の空海戦追加候補はまだ公開していない。

## 前版の公開記録（2026-10-03）

PR #6を利用者がマージしたmain `1950788018fa2a0466715f85c866d9f273718138` を、承認後に [run37086928771](https://github.com/chameleonjp-lab/kaisen/actions/runs/37086928771) で配備し成功。107単体・build・成果物照合が再度合格。公開画面のEasy/Normal切替、読み込まれたJS `index-BTmHSAV9.js` / CSS `index-KW3ZlEZ-.css` と、そのSHAを記録した配備成果物の対応を確認した。公開manifestの直接取得はアクセス制限のため未検証であり、別経路で迂回しない。dot側クラウドブラウザはWebGL無効なので公開版の飛行確認はblocked、CIの模擬ブラウザ成功とは区別する。

本人は以後もマージされたカイセンをPagesへ反映するよう指示した。運用はmain/検査済みtreeを確認して既存手動ワークフローへ完全SHAを指定する。GitHubの自動実行設定・保護・権限を変更する指示とは扱わず、未マージ変更は公開しない。

## 初回準備の記録

2026-10-02、利用者がカイセンmainのGitHub Pages公開について「pages反映してください」と承認した。対象は `chameleonjp-lab/kaisen` のみ。mainへの直接push、代理マージ、自動マージ、保護の変更は引き続き行わない。

- 開始時main: `6af009ce629c1303e4945c704e130637db454d60`（PR #4のマージ）
- tree: `88dd4a47d8ea2a5d32f16c1a9141becee4576b81`。検査済みPR head `5789ac4d5eeb9fdf642776674762b7c54177898f` と同一
- [最終機能CI](https://github.com/chameleonjp-lab/kaisen/actions/runs/37013373047): 95単体、型/build、ブラウザ12件合格
- GitHubのPages設定を実際に確認: Sourceは既にGitHub Actions、独自ドメインなし、HTTPS強制
- 開始時の `https://chameleonjp-lab.github.io/kaisen/` はGitHub Pagesの404。これは未公開の観測でありプレイURLの成功確認ではない
- この変更は公開ワークフローと成果物照合だけ。ゲーム本体・SE・依存・操縦を変更しない

公開ワークフローのmain反映と配備、実URLの起動確認はこの文書の作成時点では未実施。実際のrun/公開版はGitHub Actionsの実行結果と `deployment.json` で照合する。

## 公開の流れ

1. この変更のDraft PRで既存の全検査とPages成果物検査を確認し、利用者がmainへマージする。
2. mainの完全commit SHAと、検査したPR headとの差分を照合する。
3. Actionsの **Deploy Kaisen to GitHub Pages** を **main** で手動実行し、`expected_sha` に照合したmainの完全SHAを指定する。PR/pushでは自動公開しない。現在の本人指示に従い、カイセンを本人がマージした後、検査合格とmain一致を確認して反映する。
4. ワークフローは選択refとSHAを照合し、固定Node24/lockfileで単体検査・型/buildを実行する。既存Pages設定を読むだけで、新しいPAT/秘密情報・有料サービス・管理権限を追加しない。
5. `dist/` だけを公開用artifactへ保存し、`github-pages` 環境へ配備する。公開jobだけが一時的な `pages:write` / `id-token:write` を使う。保護ルールを緩和しない。
6. deploy stepが返す実URLを開き、次項を確認してから公開完了とする。

main以外やSHA不一致は公開しない。同時配備は直列化し、進行中の公開を新しい実行で中断しない。保持7日のCI artifactは恒久的なバックアップではない。

## 公開内容の照合

`scripts/prepare-pages.mjs` はPR検査と配備buildの両方で実行する。入口・JS/CSS・第三者NOTICEだけを許可し、相対アセット参照と実ファイルの存在、公開bundleに開発用状態観測hookがないことを検査する。生成する `deployment.json` はrepo・build commit・各公開ファイルのSHA-256を記録する。ゲーム画面に開発情報は追加しない。

- Viteの既存 `base: "./"` を保持。公開の `/kaisen/` と `/kaisen/?...` からJS/CSSが解決することを確認する
- 返されたHTML・JS・CSS・NOTICEの実内容/形式とSHA-256をmanifest、配備artifactへ対応づける。commit文字列だけで一致としない
- 公開ページで準備完了→出撃→操縦→停止/再開→ホームを確認。初回相当と再読込を分ける
- ネットワーク/コンソールエラー、配信キャッシュの実応答を確認する。Service Workerは採用しておらず、追加しない
- 音は初期OFF。音ボタンをONにした場合の再生開始と停止を確認する。エンジン、発砲、命中、被弾、宙返り、爆発の実装はあるが、実音の聴取とiPhone Safariの音質/遅延は別途未確認
- オンラインランキング・開始集計・名前送信・本番DB操作はない
- iPhone17Pro実機の操作、熱、描画性能、音の確認はクラウドブラウザの成功に読み替えない

## 復旧の扱い

初回準備時点では既知の正常な公開版はなかった。現在の公開版は冒頭の記録を参照。配備後の正常版はrun・main commit・manifestを記録する。必要な復旧は保持中の正しいartifactか、確認済みソース/lockfileからの再buildを使い、改めて公開内容を検証する。復旧操作自体は実行していない。

## 参照

- [GitHub公式: カスタムPagesワークフロー](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)
- [Vite公式: GitHub Pagesと下位パス](https://vite.dev/guide/static-deploy.html#github-pages)
- 採用ハーネス v2.6.0 の `workflow.delivery` / `workflow.release`。参照版は変更しない
