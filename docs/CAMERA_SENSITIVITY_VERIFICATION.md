# 2026-10-13 JST PR17: 操縦判断・実入力・画像確認を分ける

再開対象は head `349ed823b15d7d406e09e69084c0fcd32c88e803` / tree `701788307409c1be49d30354966fe2f3fdfc9c93`。本人の原因調査・作業再開・根本的な見直しの依頼により、検査の入力順序と記録処理を修正する。製品の飛行・戦闘・画質・依存・公式workflowはこの再開差分で変更しない。

[CI55](https://github.com/chameleonjp-lab/kaisen/actions/runs/38289541275)は当時の334単体、型/build、manifest、固定旧版比較が成功し、browserは59件中57成功・2失敗、24.0分だった。Normalは9回の投下要求がすべてfresh確認で失効し、600秒でも実投下0・残弾2・自機の艦撃破0。Easyの最初の照準画像保存は26tick、Normalは28tickを消費し、保存前の有効表示と保存後の実表示が一致しなかった。Normalに描画停止はない。照合したartifactと再生の識別は [CI55失敗記録](evidence/camera-sensitivity/ci55-failure.json) に残す。

実消費入力を製品の計算へ再生すると、Normalは最大数値差1.27e-10以内で記録された36,004tickへ一致した。Easyは証拠にある67/364tickの通常停止・再開も再生し、最大差2.73e-12以内で2,504tickの敵機射撃による敗北へ一致した。単に入力auditだけを再生したEasyは停止時の補助履歴解除を欠いて一致しなかったため、完全再現の証拠には使わない。

共有入力helperは現時点の実cueと受理済みの操舵を読み、その操舵を保って通常CDPのtouchStart/touchEndを連続送信する。押下中のRAF待機を挟まず、送達後に同じ操縦指・投下指の解放・実残弾減少を確認する。失効cueは押下せず記録する。投下後の最新状態で次の操舵を一度だけ確定する。独立レビューで見つかった未送信指令の履歴混入は、閉包を保存・復元するpreviewと実消費だけのEasy退出ackで修正し、CI53実観測fixtureによる非干渉回帰を追加した。

長い勝利経路はlive cueのJSONと実消費auditを保持し、照準PNGの待機を置かない。既存bomb-guide2件が通常の直進操舵で持続した有効表示を作り、通常時計が進むままPNGを保存する。撮影前後の実cue・同じ指・残弾保持・読取の世界不変・撮影中のDOM状態を検査し、画像実見は別に行う。画像とJSONの名前を分け、長い経路の記録で画像証拠を上書きしない。

先行候補の単体336/336・型/build・既存59browserの列挙、短い実browserのnaval1件(17.8秒)と照準/装填/停止2件(11.2/11.4秒)は成功した。しかし、その後のEasyは実投下20回でも600.2667秒で艦100のHP972.966を残して失敗した。Normalは共有原因を調べるため中断(exit130)し、成功へ計上しない。原記録・厳密再生・限定比較は [関連失敗記録](evidence/camera-sensitivity/ci55-followup-failure.json) に残す。

その20発を再生すると14発は実損傷、5発は入力送達中に照準が外れて水面へ落ち、最後の1発は時間切れ時点で着弾前だった。また、試験pilotのEuler yaw推定には手動カメラの球面角補正が欠けていた。現在の見直しは製品を変えず、試験操縦の既存Euler指令上限を保持して実旋回へ換算し、直撃または撃沈可能な至近弾を選ぶ。Easyは投下前に短い直進入力の受理を確認し、Normalは受理済みの現操舵を保って次の操舵を送る前に投下する。既存のblast表示と投下要求の検査は保持する。短い回帰も現在のcurrentBombGuide/bombReleaseCueと実測の観測・送達間隔を用い、古い中心予測だけの成功をブラウザ成功へ付け替えない。ローカル遅延の新Easy因果回帰は267.0667秒・実投下6回、公式CI55の観測間隔とローカルEasyの投下遅延を組み合わせたNormal因果回帰は458.7秒・実投下8回・実爆弾損傷8500で全滅へ到達した。いずれもHP80で、Node検査を実browser入力受理の証明として扱わない。新候補の単体338/338（40.7445秒、fail/skip0）・型/build・59browserの列挙は成功し、短い実browser3件も成功（照準Easy10.1秒/Normal11.6秒、naval15.5秒、合計38.4秒）。確定差分の独立静的レビューに必須残件はない。確定候補の実browser勝利2件も成功（合計8.8分）。Easyは294.7167秒/HP78.944/実投下6回、Normalは208.5167秒/HP78.384/実投下8回で全敵全艦0。照準失効skip・audit欠落・Normal描画復帰はすべて0。入力所有と結果画面を含む実入力検査の成功であり、実機iPhoneや人間の遊びやすさの証明ではない。全内容識別と各検査結果は [最終候補記録](evidence/camera-sensitivity/ci55-code-candidate.json)。この提出内容に対応する正式CIのrun・完全head・成果物識別・結果は、同じ[Draft PR17](https://github.com/chameleonjp-lab/kaisen/pull/17)の検証欄へ確定後に記録する。古いheadの成功を流用しない。

600秒、実入力による全滅と勝利、HP、実弾消費監査、独立5秒待機上限、1秒描画監視、Normalの復帰1回、59件/18files(Chromium49/WebKit10)、workers1/retries0、画質、job30分上限を維持する。進捗はゲーム内1分ごとの小さな診断で観測し、未確認の同じ失敗を全時間待って反復しない。

ローカルはNode24.19.0/Playwright1.61.1/Sparticuz shell153で、正式CIのChromium149と異なる。ローカルPNGで有効状態の色は確認したが日本語glyphが不足するため、日本語の表示合格には数えない。正式artifactの画像を実見する。Draft PR17を維持し、マージ・Ready化・公開を行わない。採用ハーネスc60683b504b68262dae8b4fc723b416077def8b5は維持する。

# 2026-10-12 UTC CI54の投下順序修正と通信待機の集約

head `efadcb17ab2b7ab72504044aefa030fc51b13c01` / tree `5b40ebf9687d103e88b5b3a563ecd9439321c1b8` の[CI54](https://github.com/chameleonjp-lab/kaisen/actions/runs/38282901314)は334単体・型/build・実SHAのmanifest・固定旧版比較が成功。browserは56成功・勝利2失敗の後、既存30分のjob上限で最後のreloadがcancelledとなった。成功済みの旧headを今回の全件成功とは扱わない。artifact11763690517、16,521,005 bytes、ZIP SHA256 `619c75c76a582c85ff17bb9b593611e13b14a237033b39d24ab41679c4d45e0b` を照合した。

実消費入力の厳密再生はEasy1360観測・Normal2077観測と終了状態に一致した。Easyは332.35秒で敵機の射撃による敗北、5回の実投下のうち1回だけ艦へ1800ダメージ。Normalは600.1167秒で生存艦400HPを残し、有効投下3回・水面への外れ11回・未着弾1回だった。観測時のgreenはどちらも、実投下まで旧操舵が続く間にwaterへ変化した。Normalの観測→投下は18〜45tick、既に投下前の再読取でwaterになったものも6回あった。描画停止/GL failureは両経路で観測0。

今回の候補は操舵の受理を先に確認し、投下直前の実表示・現guide・生存艦・操作ボタンの矩形を同じread-only読取で確かめる。照準が失効したら実ボタンを押さず、未押下のnullとして記録する。実投下の成功数は残弾低下だけから数え、終了/停止は従来のphase分岐へ戻る。初回green画像の保存後も状態を取り直してから次の入力を決める。前節の「新操舵より先に旧操舵を保持して投下する」候補は、CI54の実測に基づき置き換えた。

入力受付のRAF待機とその成立時のtick/phase読取を1回のbrowser呼出しにまとめた。爆弾/魚雷も指のrelease・同一操縦指・実残弾の低下を同じ待機で確認する。5秒の独立timerは非表示のRAF停止でも働き、ゲーム時計を進めない。reloadの通常観測は既存のcompact読取、tick待機はclock読取を使い、停止時の完全状態比較と画像/最終証拠を維持する。navalの既存経路に、実際の有効圏外表示で未押下・残弾保持・同じ操縦指・auditの投下pulseなしを確認する回帰を加えた。

試験pilotの戦略・製品source・物理/HP/兵装/AI・描画/素材・依存・公式workflowはCI54 headと一致する。どのgreenでも中立操舵にする案は、Easyの5つの区間で悪化する場合があり不採用。艦の未来位置の線形近似誤差はNormalで最大1.90mと小さく、今回の変更に含めない。区間の合法入力による数値比較を、実ブラウザの入力送達や全勝利の証明へ読み替えない。

全334単体（fail/skip0）・型/buildが成功、関連browser3件が成功（naval15.9秒・clock5.0秒・reload57.7秒）。独立コードレビューは必須残件なし。Easyの関連勝利は257.35秒/HP80・全敵全艦0・実投下9回/失効skip1回で成功。Normalも229.1167秒/HP80.000・全敵全艦0・実投下10回/失効skip2回・描画停止0回で成功（勝利2経路の合計8.5分）。全59件/18files（Chromium49＋WebKit10）を維持して列挙した。600秒・全滅・HP>0・実入力・1秒監視・Normal回復1回・workers1/retries0・画質・job30分上限を緩めない。

ローカルはNode24.19.0 / Playwright1.61.1 / Sparticuz headless_shell153.0.8010.0、393×852/DPR1。正式CIの通常Chromium149とは異なり、日本語glyph不足もある。新しい候補の全体CIと正式画像は、同じDraft PRの実SHAで確認する。マージ・Ready化・公開はしない。

失敗と原因の根拠は [CI54原本識別](evidence/camera-sensitivity/ci54-failure.json)、[Easy厳密再生](evidence/camera-sensitivity/ci54-easy-payload-replay.json)、[Easyの限定照準比較](evidence/camera-sensitivity/ci54-easy-cue-horizons.json)、[Normal厳密再生と投下調査](evidence/camera-sensitivity/ci54-normal-release-analysis.json)。現在のsource識別と検査結果は [候補記録](evidence/camera-sensitivity/ci54-code-candidate.json)にまとめる。

以下は前回までの候補・検査履歴。

# 2026-10-12 UTC CI53の実入力修正と検査観測の軽量化

head `14190408feb4b09d71d914c986653520d9eeecc4` / tree `9901ae860fabf6e55c507484de4a59549b8ebceb` の[CI53](https://github.com/chameleonjp-lab/kaisen/actions/runs/38273855546)は331単体・型/build・manifest・固定旧版比較成功、browser53/58成功・5失敗。Easyは299.6667秒の艦対空砲、Normalは66.9秒の機体衝突で敗北し、両方のbomb要求は0だった。両ルートでrender停止/GL failureは観測0だが、Chromium方式変更の一般的な性能改善や根因確定とは扱わない。artifact11759132178、18,322,928 bytes、SHA256 `4d7981e40a84add388e5454241705575425428def1476fce1f730c4197608920` を照合した。

- 実green cueはEasy tick1460・Normal tick1636で生存艦にblastを予測していたが、試験pilotの狭い中心判定が拒否した。DOMの投下可能表示と実blast/direct予測を併せて読む。browser feedbackがある場合はready=falseも拒否し、feedbackなしの数値試験だけ中心予測を使う。合法な残弾・reload/cooldown・上限・HPを保つ。
- 実ボタンは新操舵の待機より先に、現在受理されている操舵を保って押す。成功数は実bomb残数の低下でのみ増やす。phase変化は旧結果/停止分岐へ戻し、飛行中の操縦指所有消失は失敗とする。投下前後tick・phase・残弾・操作順を別記録し、旧fixtureの操舵受付後投下という解釈を新記録へ流用しない。
- Normalの228消費行は205観測点と衝突tick4014を再現した。tick3941の259.06m/TTC1.252秒/最短14.62mが距離240mだけで除外されていた。観測間隔0.15秒超を既に検出したpilotだけTTC/最接近距離を直接使い、従来の高速6tick経路は維持する。17/34/42tick遅延の合法入力による2秒の数値比較は生存したが、全勝利や実ブラウザの代用ではない。
- 404はtraceで既定の `/favicon.ico` と確認し、既存KマークのインラインSVGを指定した。console error検査は維持する。
- DEV限定のclock/input読取を追加し、RAFの待機やtouch受理確認で全機・全艦・爆弾予測・描画診断を毎回複製しない。Easyも旧35ms固定待機から同じ6tick条件のRAF待機へ変える。全状態・消費監査・実画像は必要箇所で保存する。同paused worldの100回読取はfull16.7ms/31,365 bytes、clock0.1ms/42 bytes、input0.8ms/253 bytes。局所実測であり、全CIの所要時間や実端末性能の保証ではない。

現在の全334単体・型/buildは成功。新clock/inputの実phase遷移・不変と魚雷/装填の関連browser3件は成功。途中の全距離回避候補は高速Easyの全滅試験を退行させたため不採用とし、原failログを保存した。最終の遅い観測だけへの変更で全334件を再実行し成功。独立レビューの必須指摘は解消した。

製品の監視1秒・画質・ゲーム時計・HP・勝利/全滅条件・回復1回・600秒・workers1/retries0・依存・正式workflow・WebKitを維持する。既存58browserにread-only観測の回帰1件を追加し、59件/18filesを列挙した。ローカルの勝利2経路は両方成功（Easy 572.9000秒/HP80・実投下16回、Normal 334.1333秒/HP77.248・実投下20回・描画回復0回）。新headの正式全CIはこれから実行し、終了後の結果をPRへ記録する。ローカルはSparticuz shell153であり、正式CIの通常Chromium149と同一ではない。利用可能なfull153の起動はUnix socket制約で実行前に失敗し、受入証明には使わない。マージ・Ready化・公開はしない。

失敗原本と観測統計は [CI53](evidence/camera-sensitivity/ci53-failure.json)、正確な衝突再生と限定比較は [回避調査](evidence/camera-sensitivity/ci53-collision-analysis.json)、現source識別と検査集合は [候補記録](evidence/camera-sensitivity/ci53-code-candidate.json)。ローカルの日本語glyph不足は正式CIの画像で別途確認する。

# カメラ感度の変更と検査

## CI52で残ったChromium実行方式の対応候補（2026-10-12 UTC）

head `d59f1dd854bde50ca910e8790d4700c33f1a3725` / tree `aa361578998f04089c429feca7bc98e5421e58f6` の[CI52](https://github.com/chameleonjp-lab/kaisen/actions/runs/38269526457) は331単体・型/build・manifest・固定旧版比較成功、browser57/58成功。Normalだけ反復描画停止が残った。原本ではpaused提出10/完了10がreadyで150ms安定してから再開し、次のplaying提出11が1298.3ms待機で停止。前回の受付修正は動いたが、描画待機そのものの原因は未特定である。

公式CIの実行物はPlaywright1.61.1が選ぶheadless shell149.0.7827.55、ローカルはSparticuzのheadless shell153.0.8010.0で、ローカルも通常Chromiumではなかった。固定実装と[公式Playwright資料](https://playwright.dev/docs/browsers#chromium-new-headless-mode)で、`channel: "chromium"`は同じ149の通常Chromiumによる統合headlessを選ぶことを確認した。CIには両方が既にインストールされるため、Chromium projectのこの1項目だけを変更する。資料は速度向上を保証しておらず、性能改善や遅延原因の確定とはまだ扱わない。

製品src・画質・物理・素材・依存・公式workflow・WebKit・SwiftShader引数・viewport/DPR・workers1/retries0・1秒監視・回復許容1回・600秒・全58検査を維持する。58件/17filesの列挙は成功。ローカルのexecutablePathはchannelより優先するので、既存ローカルbinaryで候補の実行成功を主張しない。正式な新headの全CIで検証する。原本counter/環境識別/候補SHA/未実行は `evidence/camera-sensitivity/ci52-channel-candidate.json`。

## CI51の描画復帰受付を修正（2026-10-12）

対象はPR17の `19a4db4bc51360f4a2ec31fed7d07fbb7208c10b` / tree `b6a841c364d206a238915eefcf90ee75cda5a540`。[CI51](https://github.com/chameleonjp-lab/kaisen/actions/runs/38258798280) は329単体・型/build・成果物・固定旧版比較が成功、browserは56/57成功だった。前回のEasy勝利と魚雷投下は成功し、Normalの反復描画停止だけが残った。artifact11752526178は17,337,548 bytes、ZIP SHA256 `6eee9f9ce267bcf0d4622e7fd1d3434bc6bef1a779e36f0b340798c4a5459a05`。

CI51の初回停止はtick283で提出10/完了9。復帰中に確定したpaused poseを提出11へ描いた後も、完了10のままResumeを受け付けていた。150ms待った記録でも提出11がpending225.9msで残り、再開後tick322で同じ提出11の1秒超を2回目の停止として扱った。初回の遅延と同じframeを二重検出したのではなく、停止中の未完了frameを残したまま再開する受付不整合である。

停止時の確定poseは一度描き、GPU完了後にのみ再開を許可する。完了した同一paused viewは再提出せず、resize・mission変更・context復帰等で無効化する。再開ボタンは描画提出後の状態で更新し、キーボードからの再開も同じ完了条件を確認する。paused以外の描画と結果演出時計、画質、1秒監視、Normalの回復許容1回・600秒・全敵全艦撃破条件は維持する。

同条件のローカルprofileでは、整数pow展開と海/空の描画順変更に一貫した改善がなく、採用しなかった。GPU timer62.23ms・CPU送信8.0msに対しfence観測1139.8msという標本があり、初回1秒待機そのものの原因は未特定。測定条件・標本数・指標の区別・CI51 counterの原本照合は `evidence/camera-sensitivity/ci51-render-investigation.json` に保存した。GPU演算値をfence待ち時間や実iPhone性能へ読み替えない。

修正候補の全331単体・型/buildは成功。新GL回帰は候補で1成功し、同じspec/helperを隔離した旧headへ実行すると、新診断へ進む前の実DOM検査「未完了fence中はResume disabled」で期待どおり失敗した。明示した描画待機だけを与え、ゲーム状態や時計を注入していない。独立担当が最新コード、正負例、旧sourceとのbyte一致を確認し、修正必須の残件はない。

初回の全ローカルChromium48件は47成功・1失敗（17.6分）。旧カスタムキー手順がrulesを閉じた直後に描画完了を待たずKeyPを送ったため、新しい再開guardが正しく拒否した。その1件の終了後に試験手順へ完了待ちを加え、同specの2件を再実行して両方成功。初回結果を最終全件成功へ読み替えない。Easyは393.3167秒/HP80、Normalは158.7667秒/HP80・描画停止0回で全敵全艦撃破、魚雷・補充・再装填・画面回転・設定・再出撃・資源上限も初回集合で成功した。

最終カスタムキー訂正後の全ローカル集合は再実行していない。現在候補の全体判定は、新headをcheckoutする既存GitHub CIの331単体・型/build・成果物・固定旧版比較・58browserで別に確定する。59/61の製品・素材・依存・設定・workflow blobはCI51 headと一致し、製品差分はmain/sceneだけ。149実行関連ファイルのSHA、初回失敗手順と訂正後の結果、正負例と6ログは `evidence/camera-sensitivity/ci51-followup-evidence.json` に保存した。配布manifestは実在する候補commit作成後に検査し、結果を同PRへ記録する。物理iPhone・体感・ローカル日本語画像の受入は未確認。

## CI50の3失敗への追補（2026-10-12）

対象は既存Draft PR17の `11b83a050deb721abe2e824bc5bd26c2ada9238f` / tree `b89fa4faf88bcda8e439b9768a1809e4d6702c0a`。全199 blobとmodeが一致する独立コピーで再開した。[CI50](https://github.com/chameleonjp-lab/kaisen/actions/runs/38244735823) は327単体・型/build・成果物・旧版比較が成功、browserは54/57成功・3失敗だった。artifact11746226117は20,980,909 bytes、ZIP SHA256 `7238480bc56ba3a17a44fe442068d9f78129f1cb2e53b4bc5efeefff3f6593b2`。展開した3件の状態記録とZIP内のbytesも一致する。

Easyはtick4534 / 75.5667秒で艦砲による敗北。提出済みpilotは爆撃後も艦の近くで操縦を続けていた。今回の試験操縦は、投下前には従来の命中予測に合わせた入力を保持し、後続観測で実際の爆弾数の減少を確認してから既存360tickの離脱へ移る。対象変更中もその離脱を保持する。ゲーム本体の艦砲・HP・兵装・勝敗は変更しない。

魚雷の実画面試験は、旧絶対pitch指令を新しい手動回転速度として保持し、tick291 / 4.85秒で艦へ衝突した。試験入力を既存の変換関数へ通し、受理後の観測間隔を使う。高度20–80m・絶対pitch0.2未満、実投下と水面到達・実時計の装填・停止中の凍結という元の条件を維持し、投下前後の高度/姿勢も検査する。

Normalは正常なWebGL fenceの完了待ちが2回1秒を超えた。tick503で1040.4ms、tick537で1128.3ms、GL failureはnull。ゲーム更新は平均1.46msだが、renderer呼出しCPU区間とrunner負荷は未計測のため、根本原因は不明。製品コード・1秒監視・試験の1回だけの通常回復条件を変更していない。同じ製品/試験コードの独立したローカル単独実行では179.7833秒・HP77.44で全滅勝利、保護停止0回だった。この再現しなかった結果を原因修正の証明とは扱わない。

CI50から追加したfixtureは実測の入力受理/消費/次観測間隔を保存し、監査のdedupにより消費時刻が未記録の25行、非投下行の投下遅延、最終行の次観測遅延は推定・仮値と明記する。600秒までの延長は測定間隔を循環させた数値試験であり、原本browser敗北を勝利へ書き換えた再生ではない。最終fixtureを旧helperで実行すると原本と同じtick4534で敗北したが、全状態のbyte一致までの検証とは区別する。原本tick1434と同じ投下前入力、stepGameによる実投下、投下後120tickの高度上昇を局所回帰で確認する。

最終ローカルは329単体成功・失敗/skip0（44.67秒）、型/build成功。実ブラウザの旧3失敗経路も3/3成功（10分）で、Easyは343.65秒・HP80の全滅勝利、Normalは213.1833秒・HP80の全滅勝利・保護停止0回、魚雷は高度76.61mで実投下後の水面航走・装填・停止凍結・再出撃を確認した。旧helper blob `9db275ecd9326601bf6e4207a061502e78dfa608` をscratchだけで隔離して新しい局所回帰を実行すると、投下後の離脱入力検査で期待どおり失敗（exit1）した。提出候補は書き換えていない。

全57browserを含む最終GitHub検査は同PRの新headに対応するChecksで別に確定する。詳しい実行対象/内容の識別と限界は `evidence/camera-sensitivity/ci50-followup-evidence.json`、ログは同じフォルダの `ci50-local-browser-final.log` / `ci50-unit-final.log` / `ci50-build-final.log` / `ci50-old-pilot-negative.log`。今回の製品src・公開素材・build設定・依存・公式workflowの61 blobは開始headと同一。独立読取レビューの指摘を修正し、最終4pathも再確認済み。物理iPhone Safari・操作感・熱性能の確認とは区別する。

以下は前回までの検査履歴。

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
