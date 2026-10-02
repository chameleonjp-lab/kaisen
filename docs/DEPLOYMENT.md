# GitHub Pagesへの配備

## 対象と現在の状態

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
3. Actionsの **Deploy Kaisen to GitHub Pages** を **main** で手動実行し、`expected_sha` に照合したmainの完全SHAを指定する。PR/pushでは自動公開しない。今回の公開依頼を以後の無条件な公開許可へ広げない。
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

初回公開前のため既知の正常な公開版はまだない。配備後の正常版はrun・main commit・manifestを記録する。必要な復旧は保持中の正しいartifactか、確認済みソース/lockfileからの再buildを使い、改めて公開内容を検証する。復旧操作自体は実行していない。

## 参照

- [GitHub公式: カスタムPagesワークフロー](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)
- [Vite公式: GitHub Pagesと下位パス](https://vite.dev/guide/static-deploy.html#github-pages)
- 採用ハーネス v2.6.0 の `workflow.delivery` / `workflow.release`。参照版は変更しない
