# 2026-11-07 JST 操縦・通常弾の標的補助撤去

対象はカイセン。開始mainは `c95c9d186b977b2ab02bd6fa9e1a0ca32ea7f0a8`、clean checkoutから `fix/manual-camera-aim-20261107` を作成。採用ハーネスは既存 `c60683b504b68262dae8b4fc723b416077def8b5` を読取確認し維持した。[8作品修正計画](https://github.com/chameleonjp-lab/zero-series/blob/main/docs/ZERO_SERIES_AIM_ASSIST_REMOVAL_PLAN_20261107.md)のK1/K2/K3を適用した候補。Easy自動引き金は計画上の仮案として実装し、採用決定へ昇格させない。

両モードの操縦から敵選択・遮蔽照会・残留補正・敵による1.65倍率を外した。通常弾は左右の機銃・機関砲とも銃口正面へ発射する。Easyだけ、移動後の最新姿勢・実画面比で円内・1200m以内・生存敵・遮蔽なしを判定して自動発射する。Normalの長押し、Easy巡航と300m開始、速度別操縦感度、敵・僚機射撃、艦砲、爆弾予測、誘導魚雷、得点・保存・公開workflowは維持した。

## K1–K3の再現と結果

数値証拠は [aim-assist-removal-numeric-20261107.json](evidence/aim-assist-removal-numeric-20261107.json)。旧版を別の一時snapshotへ展開し、同じproduction関数・seed73・高度1500・12固定tickで比較した。角度はcross/dotからatan2で算出。表示は60Hz固定計算・120Hz相当、開始直後を除く48sample。

| 比較 | 旧Easy | 候補Easy | 旧Normal | 候補Normal |
|---|---:|---:|---:|---:|
| 右105/前500と背後500のcamera視線差 | 2.545184186° | 0° | 0° | 0° |
| 20°上向きで中央保持0.2秒の戻り | 9.386182155° | 0° | 0° | 0° |
| 120Hzで直前と同じ視線 | 24/48 | 0/48 | 0/48 | 0/48 |

- K1: 敵なし・正面・円縁・画面端・背後・交差/消失、敵機/艦、複数の上下左右/斜め入力、射撃と停止再開を比較し、自機位置・姿勢・cameraが同一。両モードの操縦用遮蔽照会0。銃口正面と両武器左右の初速単位vector差は1e-12未満。Easyの円外・射程外・遮蔽・死亡・味方・横長画面・ID変更を別検査。
- K2: EventTarget上の実入力controllerで402×874→402×820は同じpointerと操作量を保持。次のclient座標変化をrebaseし、続く移動は操作に反映。個別cancelで他指を維持、回転・blur・pagehideは解除。保持中0.2秒の機首角は不変、解放後は従来の速度で水平へ戻る。
- K3: Easyにも既存表示補間を適用。機体・艦・弾・cameraの位相、pause/resume/新出撃で旧姿勢を混ぜないこと、30/60/120Hz表示で確定世界状態が完全一致することを検査。表示sampleは本体を変更しない。

REDは実装前に `/tmp/kaisen-k1-red.log` と `/tmp/kaisen-k23-red.log` で確認。前者はEasyの敵依存・保持pitch・射線・事前標的選択の失敗、後者はEasy表示の0速度sampleとheight resizeでpointerがnullになる失敗。実装後の関連14件は全件成功（`/tmp/kaisen-k123-green.log`）。controllerによる別実行も14/14成功。後から追加した30/60/120Hz比較を含む表示6件は成功（`/tmp/kaisen-presentation-rates.log`）。

## 通常ゲートの現時点

環境: Node24.22.1/npm11.9.0、Playwright1.61.1、lockfile/依存/build設定/workflow/worker1/retries0/WebKitを維持。実行にはsandboxのnetwork許可が必要（tsx/esbuildのIPCとローカルserverを含む）。ブラウザは共有cacheとローカル展開されたDebian依存を使用。Playwrightのhost検査skipはsystem ldconfigが未更新のためで、WebKitの実launchは別途確認済み。実機とは区別する。

| コマンド・検査 | 結果 |
|---|---|
| `npm test`（新表示頻度2件を追加する直前） | pass 356/356、fail/cancel/skip0、90.094秒 |
| その前の全件 | 354/356。旧「resizeは常に全解除」の2期待値がfail。回転解除へ更新しheight保持を別回帰へ分離後、上記全件pass |
| `npm test`（追加2件込み、3716de3） | pass 358/358、fail/cancel/skip0、143.537秒。後述のレビュー修正前の結果 |
| `npm run build` | pass。TypeScript/Vite成功、既存500kB超bundle警告のみ |
| 実在候補SHAの `scripts/prepare-pages.mjs` | 3716de3330003c4b1e23833f61f844de1b96ecc7でpass。レビュー修正commitでも再実行する |
| 固定旧版 `3d751051dc6212482a129e8da596ddd349b2f9f5` 比較 | fail/調査中。変更していないscriptのbefore393×852で30秒後もgraphicsReady=false。`/tmp/kaisen-throttle-baseline.log`。判定・timeout・比較条件を弱めていない |
| `npm run test:browser`（3716de3） | 12pass、4fail、1interrupted、49not_run。9.7分で取りまとめ指示により停止し証拠を保存。全件成功ではない |

browserでは通常の出撃から両モードのheight resize/保持pitch/解放/回転を追加し、既存camera-rate経路をEasyにも適用した。既存のブラウザゲート・timeout・WebKitは維持している。画像は取得後の目視前であり、現時点では描画合格へ計上しない。独立の全差分レビューと正式CIは取りまとめ側で継続する。

## M1・公開・実機

M1の操縦用遮蔽照会は両モード0である。海だけの表示と艦捕捉時の実表示間隔p50/p95は未取得。別の開始版snapshotでもChromium/SwiftShaderにKHR_parallel_shader_compile非対応と15秒の描画準備timeoutが出たため、現時点で操作補正とGPU準備の重さを同じ原因と断定しない。追加の性能最適化は行っていない。測れた値だけを後続記録へ追加する。

取りまとめ側が2026-11-06 18:37:49 UTCに取得した公開manifestは開始版c95c9d1。index/JS/CSS/NOTICEの取得bytesはmanifestのSHA256と一致。これは修正前公開版の識別であり、本候補の公開後照合ではない。候補はmain反映・配備をしていない。iPhone17 Pro Safari実機、正式公開後の両モード操作、実機の音/性能は未検査。模擬Chromium/WebKitの結果で代替しない。

## 独立レビューの修正（2026-11-06 UTC）

独立レビューは3716de3に対してK3のImportant1件を発見した。表示補間した敵に対して、照準色だけが確定tickの選択keyを参照し、敵が円を出た直後のalpha0で白くなった。`scene.drawOverlay`からそのkeyを外し、`aimIndicator`のkey制限を削除して、表示姿勢・表示標的・表示遮蔽だけで色を決める。確定tickの自動引き金と射線は変更しない。

実際のoverlayをCanvas context stubから呼ぶ4回帰は、円へ入る/出る/二標的切替/新IDについてalpha0/.5/1を検査する。旧版でexitとswitchが赤→白の不一致となるREDを確認（`/tmp/kaisen-reticle-red.log`）、修正版は関連21/21pass（`/tmp/kaisen-reticle-green.log`）。描画前後の確定世界状態も一致。レビューのMinor1件も修正し、艦の交差fixtureが実際の艦2隻を動かし消失させるようにした。敵機側も2機を対向させ、指定したx座標とtick9の死亡を明示assertする。独立レビュー後の全件とcommitの最終対応は取りまとめ側の正式CIで確認する。

停止した旧候補browserの4失敗を保持する。WebKit568×320はtraceで各到達assert成功後のscreenshot処理中に60秒の全test上限。Easy操作はtick27で1.1889秒のframe gap、GPU queue pending1210.8msを観測し、既存のframe停止が発動していた（JS/console error0）。Easy/Normal爆弾の画像経路もplaying要求に対してpausedとなった。これらは成功へ変更せず、条件・timeout・停止保護を維持する。ローカルGPU資源競合の可能性はあるが、全件の正式成功は別に必要。証拠は取りまとめ側の `/workspace/scratch/kaisen-browser-partial-3716de3/` に退避した。

レビュー修正後の `npm run build` はpass（`/tmp/kaisen-review-build.log`）。全件 `npm test` は362/362pass、fail/cancel/skip0、113.484秒（`/tmp/kaisen-review-final-tests.log`）。新候補の正式browser・固定旧版比較はexact-tree CIへ引き継ぎ、旧候補の部分成功を付け替えない。iPhone実機・M1実表示間隔・公開後照合の未検査は継続する。

## RAF間の停止/再開境界の追加確認

他作品で発見された「停止画面を描く前に再開し、古い補間姿勢へ戻る」条件をカイセンの実境界で確認した。カイセンは既存の`pause()`がpaused view stampを破棄し、`resume()`は`scene.pausedViewReady()`を必須とする。停止後の新しい確定姿勢がGPU完了するまで、同じRAF間隔の再開要求は受理されない。新しい停止stampの作成には実`scene.render()`が非playing姿勢をsampleする経路を通り、その時点で`FlightPresentation`の旧状態を破棄する。したがって本作に追加のresetは不要と判断し、製品コードは変更していない。

`presentation-lifecycle-boundary.test.ts`は実mainのpause/resumeをVMで読み、実sceneの停止stamp判定・描画sample境界と実presentationを通す。GPU描画以降だけは明示的な完了count fixtureとし、実GPU・実機の検査とはしない。停止直後の再開拒否、pending queueでの拒否、停止sampleによる履歴破棄、submitとcompleteの区別、完了後の再開とゼロtick表示を両モードで確認し、確定世界のJSONも停止前後で一致した。2/2pass（`/tmp/kaisen-lifecycle-boundary.log`）。一時的な検査コピーで`pausedViewReady`のguardだけを除いた変異は両モードともplaying≠pausedでfail、exit1（`/tmp/kaisen-lifecycle-boundary-mutant.log`）。一時コピーは削除し、製品へ変異を入れていない。

この2件を追加した全364件はpass、fail/cancel/skip0、106.683秒（`/tmp/kaisen-lifecycle-final-tests.log`）。今回のコミットは検査と記録のみで、d34afedの製品内容を維持する。最終候補の正式CI・ブラウザ・M1・実機・公開状態は取りまとめ側へ引き継ぐ。

## 高さだけで縦横比の区分が変わる境界

共有レビューで指摘された402×430→402×390→402×430を、両モードの実入力controllerと実main `handleResize`をVMで接続して再現した。旧判定は幅が変わらなくてもwidth>heightの真偽が変わると回転とみなし、操縦pointer21をnullへ失効させた（`/tmp/kaisen-square-resize-red.log`、両モードfail）。入力の判定を幅変更だけへ限定し、既存の明示orientationchangeによる解除を維持した。mainのresize処理には回転判定・自動停止が存在せず、既にscene/HUDの寸法更新だけなので製品mainは変更していない。

新回帰は同じ指・操作量・Normalの独立射撃指、変化後のclient座標rebase、次の移動での操縦継続、main画面/phaseがplayingのまま、4回のscene更新、明示回転と幅変更の解除を検査する。関連19/19pass（`/tmp/kaisen-square-resize-green.log`）。buildもpass（`/tmp/kaisen-square-build.log`）。全366件はpass、fail/cancel/skip0、78.886秒（`/tmp/kaisen-square-final-tests.log`）。実在commit1819266のPages成果物検査もpass（`/tmp/kaisen-square-prepare-pages.log`）。ブラウザや実機の未確認をこれらの数値/VM検査で代替しない。

## 初回の正式CIとcamera測定窓の修正

Draft PR27の初回提出remote `6cb63b5f0a03c9f83d9cc05f45d0b2856cc5f158` はlocal eaf9a2fのtree `b9f2269b0b3ae56cc17b071dc88d58228ee85325` と完全一致。[CI42276362089](https://github.com/chameleonjp-lab/kaisen/actions/runs/42276362089)で単体364件、build、Pages成果物、固定旧版との同条件throttle比較が成功した。browserは64/66pass、2failで、全件成功ではない。

失敗したEasyのcamera-rate 393×852/852×393は、敵のいない測定窓に入る前の累積射撃まで0と要求していた。保存artifact13535280598の実sampleはvisibleが全て0、窓内のshotsは縦6→6→6、横38→38→38→38で、測定rateはそれぞれ0.207417926/0.207386533 rad/sだった。開始時の有効敵へのEasy自動射撃を認める今回の仕様と、累積0の期待が矛盾する。

測定窓開始時の射撃数をread-onlyで保存し、窓中に1発も増えないことを要求するよう修正した。visible0・補間alpha・各方向rate・上下左右比率のassert、全件数・timeout・workflowは維持する。元失敗とartifactは残す。この検査修正を含むローカル全366件はpass、fail/cancel/skip0、81.811秒（`/tmp/kaisen-ci-fix-final-tests.log`）、buildもpass（`/tmp/kaisen-ci-fix-build.log`）。この検査修正と高さ境界修正を含む新しい提出treeのbrowser全件結果は未取得で、初回CIの成功を付け替えない。M1のp50/p95と実機・公開後照合も引き続き未取得。
