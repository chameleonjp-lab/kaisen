# カメラ感度の変更と検査

## PR17の再開バッチ（2026-10-12）

既存Draft PR17・CI49/run38240131618の6失敗を修正した。開始headは `9f049007d90190c5c4b008b82557dae70eaf349d`、treeは `e44a1adf300fae281e096dd2894a105d2ac4fe03`。開始treeはローカル復元とGitHubで完全一致。旧mainの比較用コピーも、GitHubの `c4dc63d4545146657bf00d7a85b1e95925be0285` の181 blobを照合し、不一致0。採用ハーネスc60683b5を維持し、別のharness-readコピーへ無断移行していない。

画面外倍率の失敗は、小さい角度をacosで測ると比がNormalで1.6500000000014212になる丸め誤差だった。実視線の外積・内積をatan2へ渡す計測へ替え、1e−12の基準は維持した。モード検査は旧Euler yaw比から、実視線角の横成分比へ変更した。照準fallbackはpitch/yaw/bankとquaternionを同時に初期化し、不整合なfixtureを訂正した。生の四象限キー入力と左右の符号も検査する。

旧CI38の全消費入力は手動pitchの意味を変えた後には別軌道になるため、旧tick7895/score7050を新ルールへ付け替えない。原本fixtureのseed・全763行・観測時刻・旧結果・SHAは不変更で、現ルールでは全行消費・二重再生の決定性・有限値・snapshot/live不変を確認する。旧mainのtick7832から保存した自機・敵6400のposeは独立再生で全プロパティとelapsedが一致した。同じposeから元steeringで実衝突、現pilotの合法な横回避でHP>50・高度>270m・敵分離>60mを確認する。他機・艦・弾・内部metadataを除いた隔離幾何検査であり、旧全traceの結果再現や実戦勝利の証拠ではない。

試験用操縦の爆撃後延長は、旧climb>.2という絶対pitchの閾値ではなく、合法な正のrate入力を600固定tick保持し、高度+100m・艦距離+250m・爆弾保持・playing継続を確認する。Normalの既存600秒・全敵全艦撃破・HP>0・実発射・艦反撃の勝利条件は変えていない。独立レビューで不足していた「回避中により切迫した別機を再評価する」分岐を2観測・実1tick・敵配列逆順で検査し、旧return順へ戻した隔離負例が失敗することも確認した。

独立レビューで、海面衝突のsub-tick poseがquaternionだけ補間され、カメラ視線だけ全tickのEulerを参照する不整合を検出した。視線も実quaternionに接続し、正常時と同値なbank除去→俯角→光軸rollを使う。位置は従来の45%bankを保持。衝突時の残留rollには全tickのbank scalarを使うが、機体forwardと視線の固定俯角・共通投影・照準は整合する。Quaternion1個を再利用して追加の短命割当も除いた。旧式ではNormalの機体と視線の角が0.19767913061042938rad、新式は0.19000000000000006radとなり、新しい1e−12検査が旧式を検出する。

| 提出前の最終ローカル検査 | 結果 |
| --- | --- |
| npm test | 327 pass / 0 fail / 0 skip、終了0、38.63秒 |
| npm run build | 型・製品buildが終了0。既存の500kB警告は保持 |
| camera/mode/target/sea関連 | 43 pass / 0 fail / 0 skip |
| 関連実ブラウザ | 8 pass / 0 fail / 0 skip。入力方式、Easy開始/手動優先、宙返り取消し・停止/再開、Normal4寸法の照準/操作、複数指の保持/解除 |
| 独立数値診断 | 11,520感度条件の誤差最大1.27e−15rad、756取消し条件でπ飛びなし、390正常姿勢で旧式との差5.67e−16rad以下・位置差0 |
| 衝突後の独立投影比較 | 実PerspectiveCameraとの投影差1.23e−16以下、Normal照準差5.69e−14px以下、state不変 |

提出前結果は `docs/evidence/camera-sensitivity/` の `unit-followup-final.log` / `build-followup-final.log` / `browser-followup-final.log` と `followup-evidence.json` に対応する。実行source/test/fixtureのSHA256を記録し、文書・全treeの識別と区別する。独立診断の再実行は `node --import tsx docs/evidence/camera-sensitivity/review-numeric.mts` と `node --import tsx docs/evidence/camera-sensitivity/review-quaternion-consistency.mts`。保存先へ移した後の出力も保存結果とbyte一致を確認した。

初回のローカルbrowserは仮ポート4276が「外部通信」と判定され1fail/7passだった。元の4176へローカル設定だけを戻し、最終sourceで8件を再集約して全成功。製品/期待/CIは変更していない。公式browserの代わりに既存Chromium/SwiftShaderを使用し、日本語フォントがないため画像の日本語が欠落する。この画像を視覚受入の合格にしない。WebKit・物理iPhone Safari・熱/速度/操作感はローカル未確認。最終57件browserを含むGitHub CIは、新提出headに対応するPR17 Checksで別に判定する。

今回の差分はカメラposeと関連検査・記録のみ。兵装・HP・得点・通信・保存・依存・公式workflow・公開設定は不変更。Draftのまま同PRへ提出し、マージ・Ready化・自動マージ・公開は行わない。ほか7作品は本バッチで製品変更していない。

---

対象: カイセン。開始main `6d5fa6b57c0e7bd1fed04f60c883ba82a8152751`、開始tree `c4dc63d4545146657bf00d7a85b1e95925be0285`。2026-10-12、本人の全8作品の感度統一依頼のうち、まず本作をDraft PRへ提出する。ほか7作品は現在mainを取得しただけで、今回の製品変更を加えていない。

## 原因と修正

入力は上下・左右とも36 CSS pxの円形範囲と8%の不感帯だった。入力後の飛行処理は上下を絶対角度への指数追従、左右を一定の回転速度としていた。水平、110m/s、60Hz、入力0.25の初回tickでは、旧上下0.91997度に対し旧yaw約0.19576度だった。この数値は機体の角度であり、画面の実見測定ではない。

手動上下を回転速度にし、上下・左右で同じ速度依存の基準を使う。さらに、旧カメラのbankと俯角の合成では実視線角の差が残るため、bankを光軸回りのrollへ変更し、俯角・現在pitchを含む有限stepの球面角からyawを求める。描画・標的投影・Normal照準は共通カメラ関数を維持する。

上下限、中立の水平復帰、宙返りを区別する。水平復帰は速度上限を設けて残す。画面外の応答1.65倍は既存の左右専用仕様を保持する。AI/自動標的の絶対pitch指令は保持し、手動rateへ読み替えない。ループ取消しでcanonical Eulerへ変換すると視点が飛ぶため、連続した姿勢の枝を維持して復帰する。

旧試験操縦の絶対pitch指令は、元の1tick傾き変化を新しい合法な回転速度へ換算する。新速度上限を超える要求は上限内へ制限する。試験操縦の回避中は複数機の危険を再確認する変更も含むため、換算だけの変更とは扱わない。勝利条件・HP・時間制限は緩めていない。

## 2026-10-12 19:54–19:56 JSTの提出前検査

Node 24.19.0、Three.js 0.186.1、tsx 4.21.0、TypeScript 5.9.3、Vite 8.3.1、Playwright 1.61.1。package/lock/workflowは変更していない。

| 検査 | 結果 |
| --- | --- |
| `npm test` | 325件、319 pass / 6 fail / 0 skip、終了1。全件合格ではない。 |
| flight/target/input ownership/pitch換算の関連4ファイル | 22件、21 pass / 1 fail / 0 skip。速度・正負・Normal/Easyの実カメラ角、斜め入力、bank/位置、水平復帰・上限はpass。画面外倍率の比の精度検査はfail。 |
| `npm run build` | 型と製品buildが終了0。既存のchunk-size警告あり。 |
| 実ブラウザの入力方式変更 | Chromium 153.0.8010.0 / SwiftShaderで1 pass、終了0。元の実DOM操作を実行。全browser suiteの合格ではない。 |
| 公式Chromium/WebKit取得 | 公式配布ZIPが不正/空で失敗。ローカルにnpm配布Chromiumを別途展開した。WebKit/実iPhone Safariの受入は未実施。 |

単体ログとbrowserログは `docs/evidence/camera-sensitivity/` に保存する。提出後のCIはPR headに対応するrunを確認し、ローカル結果と区別する。

## 初回提出時点の残件（以下の再開バッチで解消）

1. 画面外1.65倍の実視線角の比と、旧Euler yaw比を使うmode検査の整合。
2. Normal照準のfallback fixtureと、新しい光軸rollカメラの整合。
3. 旧CI38の消費入力で固定した衝突tick/回避判断と、新しい手動操縦との違い。
4. 爆撃pilotの高高度再進入指令と、回転速度への換算の整合。

これらをskip/検査削除/期待の弱体化で合格にせず、原因と旧契約の置換範囲を確認して同PRで修正する。独立担当の数値診断により実カメラ角の問題とループ取消しの飛びを確認したが、途中候補のレビューであり、最終候補の独立合格はまだない。

マージ・Ready化・自動マージ・公開は実施しない。実iPhoneの操作感と通常描画の最終受入は未確認のまま。
