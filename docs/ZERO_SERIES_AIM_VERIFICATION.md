# ゼロシリーズ 操作・標的・照準の検証記録

対象 `kaisen`、開始main `519fd0d50dfb2ce9a1145c0b58a1301b5c74d032`、作業branch `codex/zero-series-aim-camera-20261012`。ユーザーの2026-10-11修正依頼と「8件ともPRまで」の再開指示に基づく。mainへの変更・merge・Ready化・公開は行わずDraft PRまで。

## 差分と回帰

SimulationMetaの保持IDを補助・移動後射撃・Easy HUDへ接続。実艦swept collisionの現在poseでLOSを判定し、標的艦自身は除外。

共通A/B円内優先・候補順・20cm距離逆転・保持余裕境界0.015±誤差・微小操縦所有・逆方向入力・死亡/画面外/消失・再生成世代・slew解除・同tick射撃再検証を追加した。具体的な適用範囲とHUD役割差は[共通契約](ZERO_SERIES_AIM_CONTRACT.md)参照。0.015は新設計でユーザー指定の測定値ではない。

idle 240秒の必敗という旧期待は新しい円内優先の軌跡とは一致しないため、非勝利・目的未完了の診断へ更新した。能動入力で4目的を実際に撃破する厳密な全制圧検査は維持。

## 実行結果

| 層 | コマンド/証拠 | 結果・限界 |
| --- | --- | --- |
| 単体 | `npm test` | **314 pass / 0 fail / 0 skip、終了0**。最新の製品sourceとtestを検査。 |
| 型/製品build | `npm run build` | 終了0。TypeScript noEmitとVite製品bundle。既存chunk-size警告あり。 |
| 関連browser | `PLAYWRIGHT_BROWSERS_PATH=<browser-cache> npm run test:browser -- --project=chromium --grep "changing from touch"` | 1 pass（入力方式変更の関連経路）。全browser suiteの合格ではない。 |
| Normal実進行 | `node --import tsx docs/evidence/aim-camera/verify-normal-fire.mts` | 同seed20261011、3操縦条件×12tickのfire on/off、位置/姿勢/速度/名目camera一致。自機発射8対0、36tick組。製品公開simulation APIを実行。 |
| 製品画面 | 5viewport×DPR1/2×Normal/Easy=20画像 | Chromium 153.0.8010.0 / SwiftShader、実buildと通常DOM操作。fixture注入なし。日本語fontあり、page error 0。回転/負荷で保護停止のlast frameが含まれ、20枚すべての連続飛行は主張しない。 |
| 入力所有 | 追加EventTarget検査＋上記関連browser | 模擬EventTargetと実DOM経路を実iPhoneから区別。 |
| WebKit/iPhone | 未実行 | 公式browser取得が不正archiveで失敗し、WebKit binary/実端末なし。申告症状は未確認・未解決。 |
| 描画FPS/実機 | 未実行 | 固定60Hz論理を維持。実描画30/60/120Hzの比較合格やhardware性能を主張しない。 |

実行したsource/test/scriptのSHA256・log hash・記録日時、20viewportのDOM測定/画像hashは[evidence.json](evidence/aim-camera/evidence.json)。Normal対照の実行scriptと[result](evidence/aim-camera/normal-fire-result.json)も保存した。PR本文に接続先から返った最終head SHAと、ローカルindex treeとの一致を記す。自己参照を避け、evidence.json自体のhashは同JSONへ入れない。公式Playwright 1.61.1想定Chromiumとは異なるfallback binaryであるため、標準browser取得の成功とは扱わない。repositoryの依存・CI・fontを追加変更していない。

## 失敗・画像確認・残件

画像Normal320×568 DPR1とNormal/Easy1280×720 DPR2はHUDだけの暗いworld frameで、scene paintの受入には使わない。ほかのscene描画画像と数値検査は別証拠。細い距離label/薄い文字のcontrastの最終実機評価は未確認。

最初のbrowser取得/実行には環境起因の不正archive・SwiftShader準備timeoutがあった。ウチオトセの初回はasset接続resetで1失敗し、同sourceの再実行で合格。ファンタジアの旧font横protected 200%配置は変更前mainでも失敗し、実測fixtureを追加して製品layoutを修正。日本語fontの縦respawnで追加失敗を見つけ、旧fontも守る15000回probe＋残予算fallbackで修正し、最新469単体と指定8browserを再検査。失敗をskipやbudget縮小/寸法縮小で隠していない。これらは各作品へ同じ失敗を帰属させる説明ではなく、シリーズ共通の検証環境と個別是正の記録。

実画像を開いて確認した：[Normal/Easy縦画面](evidence/aim-camera/portrait-comparison.jpg)、[5viewport DPR1](evidence/aim-camera/viewport-contact.jpg)、[DPR2](evidence/aim-camera/viewport-dpr2.jpg)、[停止/設定](evidence/aim-camera/pause-settings.jpg)。画像は実製品PNGから内容を変えず縮小/並置した閲覧用JPG。セーフエリア/200%文字拡大は各指定UI suiteの検査範囲に限り、通常製品20画像がその全受入を代用しない。描画画像はlayoutの確認用で、操作感・FPS性能・iPhoneの受入ではない。

独立した読取reviewで同ID実経路、実遮蔽、Normal camera/照準、入力所有、guardの許可差分を確認。ゲキチンは実scene.renderをGPUだけ省いた独立camera投影で5viewport/沈没0・2・4.9秒を検査し、誤差1e-8 CSS px未満。論理/自動検査の成立と人間の実機受入は分ける。

射撃時の上下ずれは次のように切り分ける。ボタンfireだけではこの短いNormal対照でpitch/camera差を再現しない。1指持替えは操縦release→climb=0→既存水平復帰が起きるのでfire起因と断定しない。Easy標的補助の不一致とゲキチンNormal固定照準/衝突cameraは別の確認済み経路として修正。センリョウの危険時自動上昇は射撃とは別の保護。実iPhone特有のpointer capture/イベント順序は引き続き未確認。

マージ前iPhone手順：(1)Normalで操縦指の微上下を維持し別指で射撃、射撃指のみ離す/移動。(2)操縦指を離して同じ指で射撃し、release時の水平復帰と比較。(3)Easyの円内A/画面端B・遮蔽・微入力で標的/発射を確認。(4)ゲキチン母艦近傍・bank/上昇、センリョウ安全高度/危険接近で照準/回避表示を見る。(5)回転→停止→設定Save/Cancel→明示再開、速度目標とfresh inputを確認。上下ずれが残れば作品/mode/iPhone・iOS/指操作/場面を記録。実機受入とmergeは利用者が行う。
