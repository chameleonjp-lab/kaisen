import { test, expect } from '@playwright/test';
test.use({trace:'off'});

test('changing from touch to mouse or back cannot move a pressed home control', async ({page}) => {
  await page.goto('/'); await expect(page.locator('#start')).toBeEnabled();
  await expect(page.locator('#app')).toHaveAttribute('data-input','touch');
  const radio=page.locator('input[value="normal"]'); const before=await radio.boundingBox(); expect(before).not.toBeNull();
  await page.mouse.move(before!.x+before!.width/2,before!.y+before!.height/2); await page.mouse.down();
  await expect(page.locator('#app')).toHaveAttribute('data-input','touch');
  expect(await radio.boundingBox()).toEqual(before);
  await page.mouse.up(); await expect(radio).toBeChecked();
  await expect(page.locator('#app')).toHaveAttribute('data-input','keyboard');
  await page.locator('#home-controls').click(); await expect(page.locator('#control-editor-keyboard')).toHaveAttribute('aria-pressed','true');
  await expect(page.locator('#control-close')).toBeFocused();
  await page.keyboard.press('Shift+Tab'); await expect(page.locator('#control-save')).toBeFocused();
  await page.keyboard.press('Tab'); await expect(page.locator('#control-close')).toBeFocused();
  await page.locator('#control-close').click();
  await page.locator('#home-rules').click(); await page.keyboard.press('Shift+Tab');
  await expect(page.locator('#rules-back')).toBeFocused(); await page.keyboard.press('Escape');
  await page.locator('#start').tap();
  await expect.poll(async()=>page.evaluate(()=>(window as any).__kaisenReadState(false).phase)).toBe('playing');
  await expect(page.locator('#app')).toHaveAttribute('data-input','touch');
  await page.locator('#pause').click(); await page.locator('#pause-home').click();
  await page.locator('#start').tap();
  await expect.poll(async()=>page.evaluate(()=>(window as any).__kaisenReadState(false).phase)).toBe('playing');
});
