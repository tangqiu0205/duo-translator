import logo from '@/public/Fluento.svg?raw';

// Inline the shared artwork so injected Shadow DOM controls do not need
// web_accessible_resources. Keep the public SVG as the single source of truth.
export const FLUENTO_LOGO_SVG = logo.replace(
    /^<svg[^>]*>/,
    '<svg width="100%" height="100%" viewBox="0 0 1024 1024" fill="none" xmlns="http://www.w3.org/2000/svg">',
);
