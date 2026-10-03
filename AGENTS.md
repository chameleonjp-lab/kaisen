# カイセン 作業入口
対象: chameleonjp-lab/kaisen / カイセン
1. docs/PLAN.md の確定事項と proposed を分け、docs/VERIFICATION.md の現在の検査状態を読む。
2. docs/HARNESS.md の固定コミットから AGENTS → core → registry → 必要規約だけを読む。新しい版へ無断移行しない。
3. 本体状態・AI・描画・入力・音・保存の責務を分ける。描画乱数とFPSで勝敗を変えない。
4. npm test / npm run build と変更対象の画面経路を検査する。模擬端末をiPhone実機と呼ばない。
5. 作業ブランチとmain宛てDraft PRまで。main直接push、merge、auto-merge、配備、公開設定、本番DB操作は行わない。
6. 元作 faitofuraito は参照のみ。元作の名前・得点・順位接続・低高度終了・無限補充を新作へ混入させない。
7. 実装・検査の頻度は docs/TEST_BATCHING.md に従い、一つの原因修正を関連検査とともにまとめてからpushする。30分以内という時刻だけで全件を省かず、最終候補・既知失敗・入力所有/結果確定などの必要ゲートを維持する。採用ハーネス版は項目2のまま、検査集約規約だけを明示的に追加採用している。

