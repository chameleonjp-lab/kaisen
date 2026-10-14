import test from 'node:test';
import assert from 'node:assert/strict';
import { ruleSections } from '../src/rules-guide';

for (const mode of ['easy', 'normal'] as const) {
  for (const input of ['touch', 'keyboard'] as const) {
    test(`${mode}/${input}: score rules explain five-aircraft damage cap, destruction bonuses and rounding`, () => {
      const sections = ruleSections({ mode, input, keyboardDescription: 'CUSTOM-KEYS' });
      const score = sections.find(section => section.heading === 'スコア')!.paragraphs.join('\n');
      for (const rule of [
        '敵機は1機につき500点', '2,000点', '実際に減らしたHPの割合', '船体HPへの損傷',
        '半分削ると250点', '僚機が撃破しても', '貢献点は残ります',
        '初期・増援を区別せず', '自機の先着5機まで', '5機目を撃墜した攻撃まで',
        'それ以降の敵機への攻撃は加点しません', '合計2,500点まで', '僚機の撃墜は自機の枠を減らしません',
        '敵機撃墜は1機100点', '敵艦撃沈は1隻200点', '砲台破壊は1基25点',
        '初めてHPが0になったときだけ', '船体撃沈時に残っている砲台', '体当たりには加点しません',
        '上部構造の破壊には追加点を付けません', '体当たりによる敵機撃墜は自機の撃墜数に含みます',
        '12,000点', '1秒につき20点', '最低0点', '10分以降',
        '時間切れによる終了はありません',
        '最大500点', '累計損傷1HPにつき6.25点', '80HP以上で0点', 'HPを回復しても',
        '敗北してもダメージ点・撃破ボーナスと減点は残ります', '各ボーナスは0点', 'マイナス',
        '速いクリアが必ず高得点になるわけではありません',
        '小数第2位まで', '丸める前の値をすべて合計', '最後に一度だけ',
        'オンライン順位や外部への結果送信はありません',
      ]) assert.ok(score.includes(rule), `Missing scoring explanation: ${rule}`);
      if (mode === 'normal') {
        assert.ok(score.includes('1HPにつき−10点'));
        assert.ok(score.includes('さらに−1,500点'));
      } else assert.ok(score.includes('誤射による損傷・撃墜の減点はありません'));
      const guide = sections.flatMap(section => section.paragraphs).join('\n');
      assert.ok(guide.includes('自機で撃墜するとHPが15回復'));
      for (const rule of ['誘導魚雷は1発', '安全に着水', '80m以上', '残り航走時間内', '生存敵艦', '機首方向に近い艦', '発射時に選んだ敵艦を追尾', '標的は変わりません', '再捕捉せず', '魚雷を消費しません'])
        assert.ok(guide.includes(rule), `Missing guided torpedo explanation: ${rule}`);
      assert.equal(guide.includes('CUSTOM-KEYS'), input === 'keyboard');
      assert.equal(guide.includes('別の指'), input === 'touch');
    });
  }
}
