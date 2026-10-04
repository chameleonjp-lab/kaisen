import test from 'node:test';
import assert from 'node:assert/strict';
import { ruleSections } from '../src/rules-guide';

for (const mode of ['easy', 'normal'] as const) {
  for (const input of ['touch', 'keyboard'] as const) {
    test(`${mode}/${input}: score rules explain contribution, clear-only bonuses and rounding`, () => {
      const sections = ruleSections({ mode, input, keyboardDescription: 'CUSTOM-KEYS' });
      const score = sections.find(section => section.heading === 'スコア')!.paragraphs.join('\n');
      for (const rule of [
        '開始時の敵機', '500点', '2,000点', '実際に減らしたHPの割合', '船体HPへの損傷',
        '半分削ると250点', '僚機が撃破しても', '貢献点は残ります',
        '増援機への損傷・撃墜', '砲座の損傷・破壊', '体当たりには加点しません',
        '12,000点', '1秒につき20点', '最低0点', '10分以降',
        '最大500点', '累計損傷1HPにつき6.25点', '80HP以上で0点', 'HPを回復しても',
        '敗北しても貢献点と減点は残ります', '各ボーナスは0点', 'マイナス',
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
      assert.equal(guide.includes('CUSTOM-KEYS'), input === 'keyboard');
      assert.equal(guide.includes('別の指'), input === 'touch');
    });
  }
}
