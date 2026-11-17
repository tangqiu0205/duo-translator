import { sendAction } from '../common/utils';
import { test, expect } from '../fixtures/extension';
import { mockTranslateProviders, ZH } from '../mocks/translateRoutes';

// Website translation rules: includeSelectors (the positive gate),
// excludeSelectors, and injectCss. Everything here needs real layout and the
// real content pipeline, so it cannot live in the jsdom unit suite — the merge
// itself is pinned in main/__tests__/siteRuleResolve.test.ts.

/** One user rule matching the fixture page. Seeded as fluento_config_siteRuleUser. */
function userRule(over: Record<string, unknown>) {
    return [
        {
            id: 'e2e',
            name: 'e2e',
            includeUrls: '*://localhost:5566/site-rules.html*',
            ...over,
        },
    ];
}

test.describe('@siteRules website translation rules (mocked providers)', () => {
    test.beforeEach(async ({ context }) => {
        await mockTranslateProviders(context);
    });

    test('includeSelectors restricts translation to the matching subtree', async ({ page, seedConfig }) => {
        await seedConfig({ fluento_config_siteRuleUser: userRule({ includeSelectors: '#main' }) });
        await page.goto('/site-rules.html');

        await expect(page.locator('#wanted .fluento-translation')).toContainText(ZH);
        // Outside the include root: nothing, ever.
        await expect(page.locator('#aside .fluento-translation')).toHaveCount(0);
        await expect(page.locator('#masthead .fluento-translation')).toHaveCount(0);
    });

    test('excludeSelectors wins over includeSelectors when nested inside it', async ({ page, seedConfig }) => {
        await seedConfig({
            fluento_config_siteRuleUser: userRule({ includeSelectors: '#main', excludeSelectors: '#ads' }),
        });
        await page.goto('/site-rules.html');

        await expect(page.locator('#wanted .fluento-translation')).toContainText(ZH);
        await expect(page.locator('#ads .fluento-translation')).toHaveCount(0);
    });

    test('excludeSelectors alone leaves the rest of the page translated', async ({ page, seedConfig }) => {
        await seedConfig({ fluento_config_siteRuleUser: userRule({ excludeSelectors: '#aside' }) });
        await page.goto('/site-rules.html');

        await expect(page.locator('#wanted .fluento-translation')).toContainText(ZH);
        await expect(page.locator('#masthead-text .fluento-translation')).toContainText(ZH);
        await expect(page.locator('#aside .fluento-translation')).toHaveCount(0);
    });

    test('an includeSelectors that matches nothing translates nothing — no fallback to the whole page', async ({
        page,
        seedConfig,
    }) => {
        await seedConfig({ fluento_config_siteRuleUser: userRule({ includeSelectors: '#does-not-exist' }) });
        await page.goto('/site-rules.html');

        // Give the pipeline the same amount of time the positive cases need.
        await page.waitForTimeout(2000);
        await expect(page.locator('.fluento-translation')).toHaveCount(0);
    });

    test('content added inside the include root later is translated; outside it is not', async ({
        page,
        seedConfig,
    }) => {
        await seedConfig({ fluento_config_siteRuleUser: userRule({ includeSelectors: '#main' }) });
        await page.goto('/site-rules.html');
        await expect(page.locator('#wanted .fluento-translation')).toContainText(ZH);

        await page.evaluate(() => (window as any).__addInsideMain());
        await expect(page.locator('#late .fluento-translation')).toContainText(ZH);

        await page.evaluate(() => (window as any).__addOutsideMain());
        await page.waitForTimeout(1500);
        await expect(page.locator('#aside .fluento-translation')).toHaveCount(0);
    });

    test('injectCss applies while translated and is removed on restore', async ({ page, seedConfig, serviceWorker }) => {
        await seedConfig({
            fluento_config_siteRuleUser: userRule({
                injectCss: '#clamped { -webkit-line-clamp: unset !important; }',
            }),
        });
        await page.goto('/site-rules.html');
        await expect(page.locator('#clamped .fluento-translation')).toContainText(ZH);

        const clamp = () => page.evaluate(() => getComputedStyle(document.querySelector('#clamped')!).webkitLineClamp);
        expect(await clamp()).not.toBe('2');

        await sendAction(serviceWorker, 'showOriginal');
        await expect(page.locator('.fluento-translation')).toHaveCount(0);
        // The declaration goes out with the translation — an untranslated page
        // must look exactly as the site intended.
        await expect.poll(clamp).toBe('2');
    });

    test('injectCss applies to a single-paragraph translation, with no page translation', async ({
        page,
        seedConfig,
    }) => {
        // Strategy "never": the page switch stays off for the whole test, so
        // the only thing that can bring the CSS in is the paragraph itself.
        await seedConfig({
            fluento_config_defaultStrategy: 'never',
            fluento_config_doubleTapModifier: 'ctrl',
            fluento_config_doubleTapToggleParagraph: true,
            fluento_config_siteRuleUser: userRule({
                injectCss: '#clamped { -webkit-line-clamp: unset !important; }',
            }),
        });
        await page.goto('/site-rules.html');
        await expect(page.locator('.fluento-translation')).toHaveCount(0);

        const clamp = () => page.evaluate(() => getComputedStyle(document.querySelector('#clamped')!).webkitLineClamp);
        expect(await clamp()).toBe('2');

        // Double-tap Ctrl over the clamped paragraph — same gesture as
        // translate.paragraph-unit.spec.ts.
        const point = await page.evaluate(() => {
            const range = document.createRange();
            range.selectNodeContents(document.querySelector('#clamped')!);
            const r = Array.from(range.getClientRects()).filter((c) => c.width > 4 && c.height > 4)[0];
            return { x: r.left + 3, y: r.top + r.height / 2 };
        });
        await page.mouse.move(point.x, point.y);
        await page.keyboard.press('Control');
        await page.keyboard.press('Control');

        await expect(page.locator('#clamped .fluento-translation')).toContainText(ZH);
        // The clamp is lifted even though the page was never "translated" —
        // the CSS follows the translations, not the page switch.
        await expect.poll(clamp).not.toBe('2');

        // Toggling that one paragraph back off leaves nothing translated, so
        // the page must look untouched again.
        await page.mouse.move(point.x, point.y);
        await page.keyboard.press('Control');
        await page.keyboard.press('Control');
        await expect(page.locator('.fluento-translation')).toHaveCount(0);
        await expect.poll(clamp).toBe('2');
    });

    test('matchSelectors gates the rule: inactive when the marker is absent, active when present', async ({
        page,
        seedConfig,
    }) => {
        await seedConfig({
            fluento_config_siteRuleUser: userRule({ matchSelectors: 'body.spa-ready', excludeSelectors: '#aside' }),
        });

        // Marker absent → the whole rule is skipped, so #aside IS translated.
        await page.goto('/site-rules.html');
        await expect(page.locator('#aside .fluento-translation')).toContainText(ZH);

        // Marker server-rendered → rule applies, #aside stays untranslated.
        await page.goto('/site-rules.html?ready=1');
        await expect(page.locator('#wanted .fluento-translation')).toContainText(ZH);
        await expect(page.locator('#aside .fluento-translation')).toHaveCount(0);
    });

    test('a marker that appears after load activates the rule for content scanned afterwards', async ({
        page,
        seedConfig,
    }) => {
        await seedConfig({
            fluento_config_siteRuleUser: userRule({ matchSelectors: 'body.spa-ready', excludeSelectors: '#aside' }),
        });
        await page.goto('/site-rules.html');
        // Rule inactive at load.
        await expect(page.locator('#unwanted .fluento-translation')).toContainText(ZH);

        // Hydration / client-side view swap flips the marker, then renders more
        // content. The condition is re-probed each scan cycle, so the newly
        // added paragraph is covered by the now-active rule.
        await page.evaluate(() => {
            (window as any).__markReady();
            (window as any).__addOutsideMain();
        });
        await page.waitForTimeout(2000);
        await expect(page.locator('#late-outside .fluento-translation')).toHaveCount(0);
        // Already-translated content is NOT retroactively restored — documented
        // limitation, asserted so a future change to it is a deliberate one.
        await expect(page.locator('#unwanted .fluento-translation')).toContainText(ZH);
    });

    test('a disabled master switch turns every rule off', async ({ page, seedConfig }) => {
        await seedConfig({
            fluento_config_siteRuleSwitch: false,
            fluento_config_siteRuleUser: userRule({ includeSelectors: '#main' }),
        });
        await page.goto('/site-rules.html');

        // With the system off there is no include restriction at all.
        await expect(page.locator('#aside .fluento-translation')).toContainText(ZH);
    });
});
