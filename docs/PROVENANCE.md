# 再利用と素材の来歴

取得日: 2026-10-02
元作品: [chameleonjp-lab/faitofuraito](https://github.com/chameleonjp-lab/faitofuraito/tree/025cad4930b487628675a0e20a88323aae0fac89)
固定commit: 025cad4930b487628675a0e20a88323aae0fac89

所有者の「飛行機のモデルとか操作感を残しつつ、別のゲームに派生させたい」という依頼に基づき、本作へ選択的に複製。元リポジトリは読み取りのみ。元作品が一般向けライセンスを付与しているとは扱わない。

| 本作 | 原本 | 変更 |
|---|---|---|
| src/aircraft.ts | 同名ファイル | バイト同一。翼、機体、風防、可動部、材質、手続きテクスチャを維持 |
| src/input.ts | 同名ファイル | バイト同一。相対スティックとpointer/keyboard所有・解除を維持 |
| src/flight-view.ts | 同名ファイル | バイト同一。後方offset、64度FOV、バンク伝達45%を維持 |
| src/audio.ts | 同名ファイル | 合成エンジン・射撃・命中・損傷音の実装を維持。新作イベントの対応はmain.tsで行う |
| src/flight.ts | simulation.ts | 操縦・速度・姿勢・スロットル・宙返りを抽出。本体終了や敵補充から分離 |
| src/flight-assist.ts | 同名ファイル | 標的を航空機/艦へ一般化し、共有投影と手動優先を保持 |
| src/simulation.ts | simulation.ts | 弾のsweep方式・銃口・基本周期を参照。陣営・艦・固定目標・時計/結果は新作専用 |
| src/scene.ts | scene.tsの操縦面更新 | 機体の姿勢、プロペラ、補助翼/昇降舵更新を参照。海、光、船、HUDは新規 |

機体/入力/カメラの取得時SHA-256:
- aircraft.ts: 1a9c18f93e5a48869882b2aa2946cdeb352dc4a8acd76b4fd9beade8ded621d5
- input.ts: 767e194b080a2db4a330c548ad855aef29e645df67aec5bc02ae499ef1aaef5f
- flight-view.ts: 1f9b7e040c2270de5838f24bad93c7ac1c75c7827ba3c1b58591ef6271a20363

艦の形状、海の波/反射、UIは本作向けにコードで制作。実在艦の精密再現や写真の転用はない。機体に含まれる手続き模様以外の画像・有料素材は追加していない。音は録音でなく合成音。一般的なシステムフォントを使い、外部フォントへ接続しない。

Three.js 0.186.1 / @types/three 0.183.1 / TypeScript 5.9.3 / Vite 8.3.1 / tsx 4.21.0は元作の固定依存から継承。Playwright 1.61.1はブラウザ検査のための開発依存。package-lock.jsonに解決版と整合性値を固定。Three.jsのMIT表記を public/third-party-notices.txt に保持する。

元作のランキング接続、ゲーム識別子、保存キー、共有画像、得点式、無限補充、1,200m低高度終了、検査画像は移植していない。

音の6件の単体回帰検査も同じ元作commitの tests/audio.test.ts から複製した。ブラウザ音APIのfakeによる論理検査であり、実聴の評価ではない。src/aircraft-batch.ts は本作独自の描画専用まとめ処理で、元のaircraft.tsのバイト列は変更せず、同じ材質/形状の静的部分を共有キャッシュへまとめる。


## 追加改修の出典（2026-10-02）
- 元機体/入力/カメラの3ファイルは引き続き同一バイト。`sea-contact.ts`の支持頂点はそのFactory形状から抽出した派生データで、テストで両detailの形状・source SHA-256を再照合する
- 艦モデルは独自の手続き生成。歴史資料の画像・図面・有料素材はコピーしていない。大和ミュージアム/NHHC/米海軍戦後調査/米陸軍技術書の確認事項は `NAVAL_REFERENCE.md` に資料ごとの確度とゲーム化の限界を記録
- 元作の飛行/機銃操作は維持し、艦砲の数/弾速/重力/砲口と表示、海面接触、弾倉、有限増援は本作で新設した。オンライン得点/ランキング/外部AIサービスは追加していない
