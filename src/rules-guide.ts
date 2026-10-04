import type { GameMode } from './types';
import { containDialogTabFocus } from './dialog-focus';

export type GuideInput = 'touch' | 'keyboard';
export interface RulesContext { mode: GameMode; input: GuideInput; keyboardDescription: string; }
export interface RuleSection { heading: string; paragraphs: string[]; }

export function ruleSections({ mode, input, keyboardDescription }: RulesContext): RuleSection[] {
  return [
    { heading: 'ゲーム概要', paragraphs: [
      '自機と4機の僚機で、敵航空隊と4隻の艦隊へ挑むタイムアタックです。短い時間での作戦完了を目指します。',
      '画面上の敵機・敵艦の大きな数字は、自機と僚機を合わせた累計撃破数です。0から増え、増援が来ても減りません。「残り」は現在戦場にいる敵の数です。',
    ] },
    { heading: '勝利と敗北', paragraphs: [
      '敵機と4隻の敵艦をすべて撃破した瞬間にクリアです。撃破数が5機に達するだけではクリアになりません。',
      '自機のHPが0になる、海面に機体が触れる、敵機・艦体・沈没中の残骸へ衝突すると作戦終了です。自機は復活しません。',
      '一時停止中は作戦時間、敵、弾、装填や復帰の時計も止まります。説明や設定を閉じても自動で飛行は再開しません。',
    ] },
    { heading: '増援と僚機', paragraphs: [
      '作戦時間40秒ごとに、生存する敵機が5機未満なら不足分が復活します。全滅クリア後に増援は来ません。',
      '復活した敵機を自機で撃墜するとHPが15回復します。最大HPを超えず、スコアへの加点はありません。僚機の撃墜では自機のHPは回復しません。',
      '僚機はそれぞれ撃墜から40秒後に復帰します。被撃墜・復帰・敵機撃墜を画面で知らせます。',
    ] },
    { heading: input === 'touch' ? 'スマートフォンの操作' : 'PCの操作', paragraphs: input === 'touch' ? [
      'ボタンのない場所に触れ、その位置からドラッグして操縦します。指を離すと操縦入力が戻ります。操縦しながら別の指でボタンを押せます。',
      mode === 'easy' ? 'イージーは照準円内・1.2km以内へ自動射撃します。弾道を見ながら相手の少し先へ向けてください。宙返りは「宙返り」ボタンです。' : 'ノーマルは「射撃」を長押しして撃ちます。「加速」「減速」も長押し、宙返りは「宙返り」ボタンです。弾の照準補助はありません。',
      '「爆弾」「魚雷」は押して指を離すと1発投下します。「残り2発」「残り1発」は弾の個数です。操作設定でボタンの配置・大きさ・透明度を調整できます。',
    ] : [
      keyboardDescription,
      mode === 'easy' ? 'イージーは照準円内・1.2km以内へ自動射撃します。弾道を見ながら相手の少し先へ向けてください。' : 'ノーマルは射撃キーを押している間だけ撃ちます。加速・減速も長押しです。弾の照準補助はありません。',
      'マウスで画面をドラッグしても操縦できます。操作設定で各操作のキーを変更できます。単発の宙返り・爆弾・魚雷は、押し直すと次の操作になります。',
    ] },
    { heading: '空戦と対艦攻撃', paragraphs: [
      '機銃と機関砲は航空機や艦の露出砲座・上部構造を攻撃します。機関砲は1発が重く、どちらも遠くなるほど威力が下がります。艦の装甲船体には爆弾・魚雷を使ってください。',
      '機銃・機関砲を撃ち切ると6秒で再装填します。照準円の周囲のゲージと残り秒数で進行を確認できます。',
      '爆弾は2発。十字は実弾道と艦の移動から計算した落下目安です。ボタンが緑の「命中見込み」「至近弾圏内」なら、現在の予測で生存艦へ損傷が届きます。操作や艦の状態が変わるため命中保証ではありません。近すぎる接触は不発になります。',
      '直撃は2,000損傷。起爆可能な爆弾の海面着弾は、船体表面から20m未満の至近弾でも距離に応じて最大500損傷です。破線の円は水面での20m目安で、中心から遠いほど弱くなります。装填中・投下待ち・停止中はボタンが緑になりません。',
      '魚雷は1発。高度20〜80mを目安に、450km/h以下で機首と翼を水平にして投下します。入水後80mの航走が必要なので、艦のすぐ脇からでは起爆しません。',
      '爆弾・魚雷はそれぞれ撃ち切ると6秒で補充されます。低空では海面・艦との衝突や対空砲火に注意してください。',
      mode === 'normal' ? 'ノーマルで自機が味方機へ与えた損傷は1HPにつき−10点。撃墜するとさらに−1500点です。照準円内の味方は青、敵は赤で表示されます。' : 'イージーでは味方機への誤射で損傷は与えません。照準円は通常白、円内に敵がいると赤、味方がいると青で表示されます。',
    ] },
  ];
}

/** Native modal keeps focus and Escape inside the guide without resuming the mission. */
export class RulesGuide {
  private readonly dialog: HTMLDialogElement;
  private readonly content: HTMLElement;
  private returnFocus: HTMLElement | null = null;
  private readonly abort = new AbortController();
  get isOpen() { return this.dialog.open; }
  constructor(private readonly context: () => RulesContext, private readonly clearInput: () => void) {
    this.dialog = document.createElement('dialog'); this.dialog.id = 'rules-guide';
    this.dialog.className = 'rules-dialog'; this.dialog.setAttribute('aria-labelledby', 'rules-title');
    this.dialog.innerHTML = '<header class="rules-header"><div><p class="eyebrow">HOW TO PLAY</p><h2 id="rules-title">ルールと操作方法</h2></div><button type="button" id="rules-close" aria-label="説明を閉じる">×</button></header><div id="rules-content" class="rules-content" tabindex="0" role="region" aria-label="ルール説明の内容"></div><footer><button type="button" id="rules-back" class="primary">元の画面へ戻る</button></footer>';
    document.getElementById('app')!.append(this.dialog);
    this.content = this.dialog.querySelector('#rules-content')!;
    for (const id of ['rules-close', 'rules-back']) this.dialog.querySelector('#' + id)!.addEventListener('click', () => this.close(), { signal: this.abort.signal });
    this.dialog.addEventListener('cancel', event => { event.preventDefault(); this.close(); }, { signal: this.abort.signal });
    this.dialog.addEventListener('keydown', event => containDialogTabFocus(this.dialog, event), { signal: this.abort.signal });
    this.dialog.addEventListener('close', () => { this.clearInput(); this.returnFocus?.focus({ preventScroll: true }); }, { signal: this.abort.signal });
  }
  open(button: HTMLElement) {
    if (this.isOpen) return;
    this.returnFocus = button; this.clearInput(); this.content.replaceChildren();
    for (const section of ruleSections(this.context())) {
      const element = document.createElement('section'), heading = document.createElement('h3');
      heading.textContent = section.heading; element.append(heading);
      for (const text of section.paragraphs) { const p = document.createElement('p'); p.textContent = text; element.append(p); }
      this.content.append(element);
    }
    this.dialog.showModal(); this.content.scrollTop = 0;
    this.dialog.querySelector<HTMLButtonElement>('#rules-close')!.focus({ preventScroll: true });
  }
  close() { if (this.isOpen) this.dialog.close(); }
  dispose() { this.close(); this.abort.abort(); this.dialog.remove(); }
}
