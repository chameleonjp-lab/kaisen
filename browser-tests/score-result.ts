import { expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import type { GameMode, GameResult } from '../src/types';

const components = [
  ['aircraft', '初期敵機への貢献'],
  ['ships', '初期敵艦への貢献'],
  ['clear', 'クリアボーナス'],
  ['speed', '速さボーナス'],
  ['damageAvoidance', '損傷回避ボーナス'],
  ['friendlyDamagePenalty', '味方への損傷減点'],
  ['friendlyKillPenalty', '味方撃墜の減点'],
] as const;

/** Reuse genuine mission outcomes. This helper never injects or changes game state. */
export async function expectScoreResult(page: Page, result: GameResult, mode: GameMode, outcome: GameResult['outcome']) {
  expect(result.mode).toBe(mode);
  expect(result.outcome).toBe(outcome);
  expect(result.scoreRulesVersion).toBe('kaisen-contribution-1');
  expect(Number.isInteger(result.score)).toBe(true);
  const breakdown = result.scoreBreakdown;
  const total = components.reduce((sum, [key]) => sum + breakdown[key], 0);
  expect(total).toBeCloseTo(breakdown.totalBeforeRounding, 8);
  expect(result.score).toBe(Math.round(total) || 0);
  expect(breakdown.aircraft).toBeGreaterThanOrEqual(0);
  expect(breakdown.aircraft).toBeLessThanOrEqual(2500);
  expect(breakdown.ships).toBeGreaterThanOrEqual(0);
  expect(breakdown.ships).toBeLessThanOrEqual(8000);
  expect(breakdown.friendlyDamagePenalty).toBeLessThanOrEqual(0);
  expect(breakdown.friendlyKillPenalty).toBeLessThanOrEqual(0);
  if (outcome === 'victory') {
    expect(result.score).toBeGreaterThan(0);
    expect(breakdown.aircraft + breakdown.ships).toBeGreaterThan(0);
    expect(breakdown.clear).toBe(12000);
    expect(breakdown.speed).toBeCloseTo(Math.max(0, 12000 - 20 * result.time), 8);
    expect(breakdown.damageAvoidance).toBeGreaterThanOrEqual(0);
    expect(breakdown.damageAvoidance).toBeLessThanOrEqual(500);
  } else {
    expect(breakdown.clear).toBe(0);
    expect(breakdown.speed).toBe(0);
    expect(breakdown.damageAvoidance).toBe(0);
  }
  await expect(page.locator('#result-mode')).toHaveText(mode === 'normal' ? 'ノーマル' : 'イージー');
  await expect(page.locator('#result-score')).toHaveText(String(result.score));
  await expect(page.locator('#result-score-version')).toHaveText('得点ルール1 · 貢献スコア');
  await expect(page.locator('#result-score-version')).toHaveAttribute('data-score-rules-version', result.scoreRulesVersion);
  await expect(page.locator('#score-rounding-note')).toContainText('丸める前の値を合計');
  await expect(page.locator('#score-rounding-note')).toContainText('最後に一度だけ');
  await expect(page.locator('#score-scope-note')).toContainText('撃破数には増援を含みます');
  await expect(page.locator('#score-scope-note')).toContainText('増援の撃墜はHP回復のみ');
  await expect(page.locator('#score-breakdown > div')).toHaveCount(components.length);
  for (const [key, label] of components) {
    const row = page.locator(`#result-score-${key}`);
    await expect(row.locator('..').locator('dt')).toHaveText(label);
    const rendered = (await row.innerText()).replaceAll(',', '');
    expect(rendered, 'Every component is a readable number with at most two decimals').toMatch(/^-?\d+(?:\.\d{1,2})?$/);
    expect(Math.abs(Number(rendered) - breakdown[key])).toBeLessThanOrEqual(0.00500001);
  }
}

/** Scroll through the real result at narrow and short viewports; preserve screenshot evidence. */
export async function inspectScoreResultLayout(page: Page, result: GameResult, options: { narrow?: boolean; enlarged?: boolean } = {}) {
  const original = page.viewportSize()!;
  const viewports = options.narrow
    ? [{ width: 320, height: 568 }, { width: 568, height: 320 }]
    : [original];
  await mkdir('test-results/evidence', { recursive: true });
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    if (options.enlarged) {
      // Text-only accessibility inspection, never a world/result/time modification.
      await page.locator('#result').evaluate(root => {
        const originalSizes = [...root.querySelectorAll<HTMLElement>('h2,h3,p,span,strong,dt,dd,button')]
          .map(node => ({ node, size: parseFloat(getComputedStyle(node).fontSize) }));
        for (const { node, size } of originalSizes) node.style.fontSize = `${size * 2}px`;
      });
    }
    const name = `score-${result.mode}-${result.outcome}-${viewport.width}x${viewport.height}${options.enlarged ? '-text-200' : ''}`;
    for (const id of ['result-title', 'result-mode', 'result-reason', 'result-time-label', 'result-time', 'result-score', ...components.map(([key]) => `result-score-${key}`), 'score-scope-note', 'score-rounding-note', 'result-score-version', 'retry', 'result-home']) {
      const locator = page.locator(`#${id}`);
      await locator.scrollIntoViewIfNeeded();
      await expect(locator).toBeInViewport();
      const box = await locator.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x, `${id} left edge`).toBeGreaterThanOrEqual(-0.01);
      expect(box!.x + box!.width, `${id} right edge`).toBeLessThanOrEqual(viewport.width + 0.01);
      const textWidth = await locator.evaluate(node => ({ scroll: node.scrollWidth, client: node.clientWidth }));
      expect(textWidth.scroll, `${id} text fits its box`).toBeLessThanOrEqual(textWidth.client + 1);
      if (id === 'retry' || id === 'result-home') {
        expect(box!.height).toBeGreaterThanOrEqual(44);
        expect(box!.width).toBeGreaterThanOrEqual(44);
      }
      if (id === 'result-time' || id === 'result-score-aircraft' || id === 'result-score-damageAvoidance' || id === 'score-rounding-note') {
        await page.screenshot({ path: `test-results/evidence/${name}-${id}.png` });
      }
    }
    const metrics = await page.locator('#result').evaluate(node => ({
      scrollWidth: node.scrollWidth, clientWidth: node.clientWidth,
      scrollHeight: node.scrollHeight, clientHeight: node.clientHeight,
    }));
    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth);
    await page.screenshot({ path: `test-results/evidence/${name}-actions.png` });
    await page.locator('#result-title').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `test-results/evidence/${name}-top.png` });
    await writeFile(`test-results/evidence/${name}.json`, JSON.stringify({
      note: 'Real-input result; only viewport, scrolling and optional CSS font enlargement change. No score, outcome, time or health injection. Emulated viewport, not iPhone hardware.',
      viewport, enlarged: Boolean(options.enlarged), metrics, result,
    }, null, 2));
    const observed = await page.evaluate(() => (window as any).__kaisenReadState(false));
    expect(observed.phase).toBe('ended');
    expect(observed.result).toEqual(result);
    if (options.enlarged) await page.locator('#result').evaluate(root => {
      for (const node of root.querySelectorAll<HTMLElement>('h2,h3,p,span,strong,dt,dd,button')) node.style.removeProperty('font-size');
    });
  }
  await page.setViewportSize(original);
  await page.locator('#result-title').scrollIntoViewIfNeeded();
}
