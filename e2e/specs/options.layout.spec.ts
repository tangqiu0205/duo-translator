import { test, expect } from '../fixtures/extension';

test.use({ classicScrollbars: true });

test('options layout stays put when switching between short and scrolling tabs', async ({ page, extensionId }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`chrome-extension://${extensionId}/options.html#settings`);
    const tabs = page.locator('nav button');
    await expect(tabs.first()).toBeVisible();

    const layout = () => page.evaluate(() => {
        const root = document.documentElement;
        const box = (selector: string) => {
            const { left, right } = document.querySelector(selector)!.getBoundingClientRect();
            return { left, right };
        };
        return {
            scrollable: root.scrollHeight > root.clientHeight,
            positions: { header: box('header'), sidebar: box('nav'), content: box('main') },
        };
    });
    await expect.poll(async () => (await layout()).scrollable).toBe(false);
    const initial = (await layout()).positions;

    await tabs.nth(1).click(); // Services
    await expect(page).toHaveURL(/#services$/);
    await expect.poll(async () => (await layout()).scrollable).toBe(true);
    expect((await layout()).positions).toEqual(initial);

    await tabs.first().click(); // General settings
    await expect(page).toHaveURL(/#settings$/);
    await expect.poll(async () => (await layout()).scrollable).toBe(false);
    expect((await layout()).positions).toEqual(initial);
});
