import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';

const root = new URL('../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

it('uses a fixed Fluento identity for UI, storage, cache and sync without environment aliases', async () => {
    vi.resetModules();
    const constants = await import('@/main/constants');
    expect(constants.APP_NAME).toBe('Fluento');
    expect(constants.APP_NAME_WITH_SUFFIX).toBe('Fluento - ');
    expect(constants.APP_NAME_KEBAB_CASE).toBe('fluento');
    expect(constants.APP_NAME_PASCAL_CASE).toBe('Fluento');
    expect(constants.APP_LOGO_PATH).toBe('/Fluento.svg');
    expect(existsSync(new URL('public' + constants.APP_LOGO_PATH, root))).toBe(true);
    expect(read('main/storage/dictCache.ts')).toContain('`${APP_NAME_KEBAB_CASE}-dict-cache`');
    expect(read('main/storage/translationCache.ts')).toContain('`${APP_NAME_KEBAB_CASE}-translation-cache`');
    for (const name of ['webdavProvider', 'googleDriveProvider']) {
        expect(read(`main/storage/sync/${name}.ts`)).toContain('`${APP_NAME_KEBAB_CASE}-config.json`');
    }
});
it('uses a separate namespace and never starts the removed upstream data migration', async () => {
    const { STORAGE_PREFIX, INTERNAL_STORAGE_KEYS } = await import('@/main/storage/configStore');
    expect(STORAGE_PREFIX).toEqual({ CONFIG: 'fluento_config_', DOMAIN: 'fluento_domain_', RULE: 'fluento_rule_' });
    expect(INTERNAL_STORAGE_KEYS.every((key) => key.startsWith('__fluento_'))).toBe(true);
    expect(existsSync(new URL('main/storage/migrateFromPouch.ts', root))).toBe(false);
    expect(read('main/background.ts')).not.toContain('migrateFromPouch');
});
it('updates the installed extension name in every manifest locale', () => {
    for (const locale of readdirSync(new URL('public/_locales/', root))) {
        const messages = JSON.parse(read(`public/_locales/${locale}/messages.json`));
        expect(messages.extName.message.startsWith('Fluento'), locale).toBe(true);
    }
});
it('does not retain old brand labels in UI translations', () => {
    for (const locale of readdirSync(new URL('assets/locales/', root)).filter((path) => path.endsWith('.json'))) {
        const values = JSON.parse(read(`assets/locales/${locale}`));
        expect(JSON.stringify(values), locale).not.toMatch(/Duo Translator|DuoTranslator/);
    }
});
it('uses the Fluento package and independent Firefox identity', () => {
    expect(JSON.parse(read('package.json')).name).toBe('fluento');
    expect(read('.env.example')).not.toContain('VITE_APP_NAME');
    expect(read('wxt.config.ts')).toContain("'fluento@fluento.app'");
    expect(read('wxt.config.ts')).toContain("'fluento-dev@fluento.app'");
});
it('uses Fluento for Safari targets, bundle identifiers and packaging paths', () => {
    const project = read('safari/Fluento.xcodeproj/project.pbxproj');
    const names = [...project.matchAll(/INFOPLIST_KEY_CFBundleDisplayName = "([^"]+)";/g)].map((match) => match[1]);
    expect(names).toEqual(Array(4).fill('Fluento for Safari'));
    expect(project).toContain('PRODUCT_NAME = "Fluento for Safari";');
    expect(project).toContain('PRODUCT_BUNDLE_IDENTIFIER = com.fluento.safari;');
    expect(project).toContain('PRODUCT_BUNDLE_IDENTIFIER = com.fluento.safari.extension;');
    expect(read('scripts/safari.mjs')).toContain("const project = join(safariDir, 'Fluento.xcodeproj');");
    expect(read('scripts/safari.mjs')).toContain("const scheme = 'Fluento';");
    expect(read('scripts/safari.mjs')).toContain("const appName = 'Fluento for Safari';");
    expect(read('wxt.config.ts')).toContain("manifest.name = 'Fluento for Safari';");
    expect(read('safari/Fluento.xcodeproj/xcshareddata/xcschemes/Fluento.xcscheme')).toContain('container:Fluento.xcodeproj');
    expect(existsSync(new URL('safari/App/FluentoApp.swift', root))).toBe(true);
    expect(existsSync(new URL('safari/DuoTranslator.xcodeproj', root))).toBe(false);
    const strings = JSON.parse(read('safari/App/Localizable.xcstrings')).strings;
    expect(strings['Fluento for Safari']).toBeDefined();
    expect(strings['Turn on Fluento for Safari under Safari › Settings › Extensions.']).toBeDefined();
});
