export type PageTranslationScope = 'all' | 'main';

export const NON_ARTICLE_SELECTOR = 'nav, aside, footer, button, [role="navigation"], [role="complementary"], [role="contentinfo"], [role="button"]';

// Bound the work per candidate. A navigation shell or placeholder is not an
// article, and finding out should not require reading its entire textContent.
function hasReadingText(root: Element): boolean {
    if (root.closest(`${NON_ARTICLE_SELECTOR}, [hidden], [aria-hidden="true"]`) ||
        getComputedStyle(root).display === 'none' || getComputedStyle(root).visibility === 'hidden') return false;
    const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            return node.nodeType === Node.ELEMENT_NODE && (node as Element).matches(
                `${NON_ARTICLE_SELECTOR}, script, style, template, noscript, [hidden], [aria-hidden="true"]`,
            ) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
        },
    });
    let chars = 0;
    for (let i = 0, node; i < 160 && (node = walker.nextNode()); i++) {
        if (node.nodeType === Node.TEXT_NODE) {
            chars += (node.nodeValue ?? '').slice(0, 160).replace(/\s/g, '').length;
            if (chars >= 24) return true;
        }
    }
    return false;
}

function outermost(elements: Element[]): Element[] {
    const set = new Set(elements);
    return elements.filter(el => {
        for (let p = el.parentElement; p; p = p.parentElement) if (set.has(p)) return false;
        return true;
    });
}

export function findMainContentRoots(body: HTMLElement, selector?: string): HTMLElement[] {
    const explicit = selector ? outermost(Array.from(body.querySelectorAll(selector))) : [];
    const matched = explicit.filter((el): el is HTMLElement => el instanceof HTMLElement && (
        hasReadingText(el) || el.matches('h1, h2, h3, h4, h5, h6') && Boolean(el.textContent?.trim()) && !el.closest(NON_ARTICLE_SELECTOR)
    ));
    if (matched.length) return matched;

    // A unique semantic root is useful; a feed of equally plausible cards is
    // not. Do not pick an arbitrary article or quietly translate the feed.
    const mains = outermost(Array.from(body.querySelectorAll('main, [role="main"]'))).filter(hasReadingText);
    const articles = outermost(Array.from((mains.length === 1 ? mains[0] : body).querySelectorAll('article')))
        .filter(hasReadingText);
    if (articles.length === 1 && articles[0] instanceof HTMLElement) {
        const article = articles[0];
        // Some templates put the article heading immediately before <article>
        // in the same main region. Don't search the whole page for an h1.
        const previous = article.previousElementSibling;
        const title = previous?.matches('h1') ? previous : previous?.matches('header') ? previous.querySelector('h1') : null;
        return mains.length === 1 && mains[0].contains(article) && title instanceof HTMLElement
            && !article.querySelector('h1') ? [title, article] : [article];
    }
    if (articles.length === 0 && mains.length === 1 && mains[0] instanceof HTMLElement) return [mains[0]];
    return [];
}
