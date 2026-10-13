import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';

// These DOM routes also run in WebKit. They do not claim WebGL or iPhone hardware coverage.
for (const viewport of [{ width: 393, height: 648 }, { width: 568, height: 320 }]) {
  test(`Safari-sized touch settings and rules remain readable ${viewport.width}x${viewport.height}`, async ({ page, browserName }) => {
    await page.addInitScript(() => {
      const events:unknown[]=[]; (window as any).__qaGuidePointers=events;
      for(const type of ['pointerdown','pointerup','pointercancel','click']) window.addEventListener(type,event=>{
        if(!(event.target instanceof Element)||!event.target.closest('#home-rules'))return;
        const pointer=event as PointerEvent;
        events.push({type,pointerType:pointer.pointerType??null,detail:pointer.detail,time:performance.now()});
      },{capture:true});
    });
    await page.setViewportSize(viewport); await page.goto('/');
    await page.locator('#home-rules').tap(); await expect(page.locator('#rules-guide')).toBeVisible();
    await mkdir('test-results/evidence', { recursive: true });
    await writeFile(`test-results/evidence/guide-input-${browserName}-${viewport.width}x${viewport.height}.json`,JSON.stringify(await page.evaluate(()=>({events:(window as any).__qaGuidePointers,presentation:document.getElementById('app')!.dataset.input})),null,2));
    await page.keyboard.press('Shift+Tab'); await expect(page.locator('#rules-back')).toBeFocused();
    await page.keyboard.press('Tab'); await expect(page.locator('#rules-close')).toBeFocused();
    const text = await page.locator('#rules-content').innerText();
    expect(text).toContain('スマートフォンの操作'); expect(text).not.toContain('PCの操作'); expect(text).not.toContain('キーボード：');
    expect(text).toContain('初期敵機のHPを自機が半分削ると250点');
    expect(text).toContain('敗北しても貢献点と減点は残ります');
    const speedRule = page.locator('#rules-content p').filter({ hasText: '速いクリアが必ず高得点になるわけではありません' });
    await speedRule.scrollIntoViewIfNeeded(); await expect(speedRule).toBeInViewport();
    await page.screenshot({ path: `test-results/evidence/score-rules-${browserName}-${viewport.width}x${viewport.height}.png` });
    const torpedoText = '誘導魚雷は1発。高度20〜80mを目安に、450km/h以下で機首と翼を水平にして投下します。安全に着水でき、着水後80m以上の航走で船体へ届き、残り航走時間内に到達できる生存敵艦がいると投下できます。条件を満たす艦のうち機首方向に近い艦を選びます。';
    const torpedoRule = page.locator('#rules-content p').filter({ hasText: '誘導魚雷は1発。' });
    await expect(torpedoRule).toHaveCount(1);
    await torpedoRule.scrollIntoViewIfNeeded();
    await expect(torpedoRule).toBeVisible(); await expect(torpedoRule).toBeInViewport({ ratio: 1 });
    await expect(torpedoRule).toHaveText(torpedoText);
    await page.screenshot({ path: `test-results/evidence/guide-torpedo-${browserName}-${viewport.width}x${viewport.height}.png` });

    const originalHtmlFontSize = await page.locator('html').evaluate(element => element.style.fontSize);
    try {
      await page.locator('html').evaluate(element => { element.style.fontSize = '200%'; });
      await expect(page.locator('html')).toHaveCSS('font-size', '32px');
      await torpedoRule.scrollIntoViewIfNeeded();
      await expect(page.locator('#rules-guide')).toBeVisible();
      await expect(torpedoRule).toBeVisible();
      await expect(page.locator('#rules-close')).toBeVisible(); await expect(page.locator('#rules-close')).toBeInViewport();
      await expect(page.locator('#rules-back')).toBeVisible(); await expect(page.locator('#rules-back')).toBeInViewport();
      await expect(torpedoRule).toHaveText(torpedoText);
      const unclipped = await torpedoRule.evaluate(element => ({
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
      }));
      expect(unclipped.scrollHeight).toBeLessThanOrEqual(unclipped.clientHeight);
      const beginning = '誘導魚雷は1発。';
      const beginningVisible = await page.evaluate(text => {
        const paragraph = Array.from(document.querySelectorAll('#rules-content p')).find(element => element.textContent?.includes(text));
        const container = document.getElementById('rules-content');
        if (!paragraph || !container) return false;
        const paragraphRect = paragraph.getBoundingClientRect(), containerRect = container.getBoundingClientRect();
        container.scrollTop += paragraphRect.top - containerRect.top;
        const node = paragraph.firstChild;
        if (!node || node.nodeType !== Node.TEXT_NODE) return false;
        const offset = node.textContent!.indexOf(text);
        if (offset < 0) return false;
        const range = document.createRange();
        range.setStart(node, offset); range.setEnd(node, offset + text.length);
        const rect = range.getBoundingClientRect(), contentRect = container.getBoundingClientRect();
        return rect.top >= contentRect.top && rect.bottom <= contentRect.bottom;
      }, beginning);
      expect(beginningVisible, 'the first sentence remains reachable by scrolling at 200% text size').toBe(true);
      await page.screenshot({ path: `test-results/evidence/guide-torpedo-${browserName}-${viewport.width}x${viewport.height}-200.png` });
      const ending = '条件を満たす艦のうち機首方向に近い艦を選びます。';
      const endingVisible = await page.evaluate(text => {
        const paragraph = Array.from(document.querySelectorAll('#rules-content p')).find(element => element.textContent?.includes(text));
        const container = document.getElementById('rules-content');
        if (!paragraph || !container) return false;
        const paragraphRect = paragraph.getBoundingClientRect(), containerRect = container.getBoundingClientRect();
        container.scrollTop += paragraphRect.bottom - containerRect.bottom;
        const node = paragraph.firstChild;
        if (!node || node.nodeType !== Node.TEXT_NODE) return false;
        const offset = node.textContent!.lastIndexOf(text);
        if (offset < 0) return false;
        const range = document.createRange();
        range.setStart(node, offset); range.setEnd(node, offset + text.length);
        const rect = range.getBoundingClientRect(), contentRect = container.getBoundingClientRect();
        return rect.top >= contentRect.top && rect.bottom <= contentRect.bottom;
      }, ending);
      expect(endingVisible, 'the final sentence remains reachable by scrolling at 200% text size').toBe(true);
      await expect(page.locator('#rules-close')).toBeInViewport(); await expect(page.locator('#rules-back')).toBeInViewport();
    } finally {
      await page.locator('html').evaluate((element, fontSize) => { element.style.fontSize = fontSize; }, originalHtmlFontSize);
    }
    await page.locator('#rules-content').evaluate(element => { element.scrollTop = element.scrollHeight; });
    await expect(page.locator('#rules-content')).toContainText('残り2発');
    await page.locator('#rules-back').tap(); await expect(page.locator('#home-rules')).toBeFocused();
    await page.locator('#home-controls').tap(); await expect(page.locator('#control-settings')).toBeVisible();
    await expect(page.locator('#control-editor-touch')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('#control-mode').selectOption('normal');
    await page.locator('#control-target').selectOption('bomb');
    const styles = await page.locator('#control-mode').evaluate(element => ({ color: getComputedStyle(element).color, fill: getComputedStyle(element).webkitTextFillColor }));
    expect(styles.color).toBe('rgb(237, 242, 233)'); expect(styles.fill).toBe('rgb(237, 242, 233)');
    for (const id of ['control-x','control-y','control-size','control-opacity']) {
      await page.locator('#'+id).scrollIntoViewIfNeeded();
      const visible = await page.locator('#'+id).evaluate(element => { const r = element.getBoundingClientRect(); return r.width > 40 && r.height >= 34 && r.y >= 0 && r.bottom <= innerHeight && element.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)); });
      expect(visible, `${id} is visible and hit-testable above the footer`).toBe(true);
    }
    await page.locator('#control-preview').scrollIntoViewIfNeeded();
    const previewBox=await page.locator('#control-preview').boundingBox();
    const scrollerBox=await page.locator('.settings-main').boundingBox();
    expect(previewBox!.height).toBeLessThanOrEqual(scrollerBox!.height);
    for(const name of ['bomb','torpedo'])await expect(page.locator(`.preview-control[data-control="${name}"]`)).toBeInViewport();
    const labels = await page.locator('.preview-control').allTextContents();
    expect(labels).toEqual(expect.arrayContaining(['爆弾','魚雷'])); expect(labels.join('')).not.toContain('残り');
    const fits = await page.locator('.preview-control:not([hidden]) > span').evaluateAll(elements => elements.map(element => { const r=element.getBoundingClientRect(), preview=element.closest('#control-preview')!.getBoundingClientRect(); return { name: element.textContent, fits: r.left>=preview.left && r.right<=preview.right, whiteSpace: getComputedStyle(element).whiteSpace }; }));
    for (const item of fits) { expect(item.fits, `${item.name} fits the miniature control`).toBe(true); expect(item.whiteSpace).toBe('nowrap'); }
    await mkdir('test-results/evidence', { recursive: true });
    await page.screenshot({ path: `test-results/evidence/settings-${browserName}-${viewport.width}x${viewport.height}-preview.png` });
    await page.locator('.settings-main').evaluate(element=>{element.scrollTop=0;});
    await page.screenshot({ path: `test-results/evidence/settings-${browserName}-${viewport.width}x${viewport.height}-fields.png` });
    await page.locator('#control-close').tap(); await expect(page.locator('#home-controls')).toBeFocused();
    await page.locator('#home-rules').tap(); await page.keyboard.press('Escape');
    await expect(page.locator('#rules-guide')).not.toBeVisible(); await expect(page.locator('#home-rules')).toBeFocused();
  });
}

test.describe('desktop keyboard editor', () => {
  test.use({ isMobile: false, hasTouch: false, viewport: { width: 1280, height: 800 } });
  test('keys can be changed, conflicts cancelled, restored after reload and described without phone instructions', async ({ page, browserName }) => {
    await page.goto('/'); await page.locator('#home-controls').click();
    await expect(page.locator('#control-editor-keyboard')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('[data-key-action="fire"]').click(); await page.keyboard.press('KeyL');
    await expect(page.locator('#keyboard-capture-note')).toContainText('宙返り');
    await page.keyboard.press('Escape'); await expect(page.locator('#control-settings')).toBeVisible();
    await page.locator('[data-key-action="fire"]').click(); await page.keyboard.press('KeyF');
    await expect(page.locator('[data-key-action="fire"]')).toHaveText('F');
    await page.locator('[data-key-action="pause"]').click(); await page.keyboard.press('KeyP');
    await page.locator('#control-save').click();
    await page.locator('input[value="normal"]').check();
    await expect(page.locator('#keyboard-guide')).toContainText('F 射撃');
    await page.locator('#home-rules').click();
    const text = await page.locator('#rules-content').innerText();
    expect(text).toContain('PCの操作'); expect(text).toContain('F 射撃'); expect(text).not.toContain('スマートフォン'); expect(text).not.toContain('別の指');
    expect(text).toContain('1HPにつき−10点'); expect(text).toContain('さらに−1,500点');
    expect(text).toContain('最後に一度だけ整数に丸めます');
    await page.locator('#rules-close').click();
    await page.locator('#home-controls').click(); await page.locator('#keyboard-reset').click(); await page.locator('#control-cancel').click();
    await page.reload(); await page.locator('#home-controls').click();
    await expect(page.locator('[data-key-action="fire"]')).toHaveText('F'); await expect(page.locator('[data-key-action="pause"]')).toHaveText('P');
    await mkdir('test-results/evidence', { recursive: true });
    await page.screenshot({ path: `test-results/evidence/keyboard-settings-${browserName}.png` });
    await page.locator('#keyboard-reset').click(); await page.locator('#control-save').click();
    await page.locator('#home-controls').click(); await expect(page.locator('[data-key-action="fire"]')).toHaveText('Space');
  });
});
