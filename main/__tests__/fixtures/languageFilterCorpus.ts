// Small, hand-labelled SYNTHETIC corpus for reproducible offline evaluation.
// Not a representative real-web accuracy or production latency benchmark.
const en = 'This paragraph explains how the translation extension examines source text before making a request and preserves uncertain material so that foreign content remains available for translation';
const fr = 'Cette phrase décrit comment le programme analyse les textes avant de demander une traduction et conserve les passages incertains pour éviter de masquer du contenu étranger';
const de = 'Dieser Absatz erklärt wie die Übersetzungserweiterung funktioniert und welche Inhalte vor dem Senden einer Anfrage überprüft werden damit bekannte Sprachen nicht unnötig übersetzt werden und unsichere Inhalte weiterhin verfügbar bleiben';
const cn = '这是一个用于测试网页翻译功能的中文段落其中包含明确的简体字形证据';
const tw = '這是一段用於測試網頁翻譯功能的繁體中文內容並且包含清楚的字形證據';
const ja = 'これは日本語の文章であり翻訳機能の動作を確認するための説明です';
const ko = '이 문장은 번역 확장 프로그램이 어떻게 작동하는지 설명합니다';

export const languageFilterCorpus = [
    { id: 'foreign-English-single', text: en, languages: ['zh-CN'], mustTranslate: true },
    { id: 'foreign-English-multiple', text: [en, en, en].join('. '), languages: ['zh-CN'], mustTranslate: true },
    { id: 'foreign-French', text: [fr, fr].join('. '), languages: ['zh-CN'], mustTranslate: true },
    { id: 'foreign-German', text: [de, de].join('. '), languages: ['en', 'zh-CN'], mustTranslate: true },
    { id: 'English-excluded', text: en, languages: ['en', 'zh-CN'], mustTranslate: false },
    { id: 'English-repeated-sentences', text: [en, en, en].join('. '), languages: ['en', 'zh-CN'], mustTranslate: false },
    { id: 'English-distinct-sentences', text: en + '. Readers should always be able to compare the original paragraph with its complete translation without losing any foreign quotation or meaningful explanatory sentence', languages: ['en', 'zh-CN'], mustTranslate: false },
    { id: 'French-excluded', text: fr, languages: ['fr'], mustTranslate: false },
    { id: 'Latin-mixed-one-foreign', text: en + '. ' + fr, languages: ['en', 'zh-CN'], mustTranslate: true },
    { id: 'Latin-mixed-both-excluded', text: en + '. ' + fr, languages: ['en', 'fr'], mustTranslate: false },
    { id: 'short-French-quote', text: en + ' "Bonjour le monde"', languages: ['en'], mustTranslate: true },
    { id: 'short-single-quote', text: en + " 'Bonjour'", languages: ['en'], mustTranslate: true },
    { id: 'short-technical-quote', text: en + ' 「API」', languages: ['en'], mustTranslate: true },
    { id: 'short-path-like-phrase', text: en + '. /Click here', languages: ['en'], mustTranslate: true },
    { id: 'unpunctuated-Latin-tail-known-limit', text: en + ' Bonjour le monde', languages: ['en'], mustTranslate: true },
    { id: 'short-English', text: 'Click here', languages: ['en'], mustTranslate: true },
    { id: 'Chinese-target', text: cn, languages: ['zh-CN'], mustTranslate: false },
    { id: 'Chinese-traditional-target', text: tw, languages: ['zh-TW'], mustTranslate: false },
    { id: 'simplified-to-traditional', text: cn, languages: ['zh-TW'], mustTranslate: true },
    { id: 'traditional-to-simplified', text: tw, languages: ['zh-CN'], mustTranslate: true },
    { id: 'Japanese-excluded', text: ja, languages: ['ja', 'zh-CN'], mustTranslate: false },
    { id: 'Korean-excluded', text: ko, languages: ['ko', 'zh-CN'], mustTranslate: false },
    { id: 'Chinese-Japanese-both-skippable', text: cn + '。' + ja, languages: ['zh-CN', 'ja'], mustTranslate: false },
    { id: 'Chinese-Japanese-one-foreign', text: cn + '。' + ja, languages: ['ja'], mustTranslate: true },
    { id: 'Chinese-English-mixed', text: cn + ' Click here', languages: ['zh-CN'], mustTranslate: true },
    { id: 'shared-Han-ambiguous', text: '一二三四五六七八九十百千', languages: ['zh-CN'], mustTranslate: true },
    { id: 'explicit-URL-and-numbers', text: en + '. 1234.56. "https://example.com/a?lang=fr"', languages: ['en'], mustTranslate: false },
    { id: 'Chinese-with-URL', text: cn + ' https://example.com/docs', languages: ['zh-CN'], mustTranslate: false },
    { id: 'sentence-budget', text: (en + '. ').repeat(13), languages: ['en'], mustTranslate: false },
    { id: 'oversize-budget', text: en.repeat(30), languages: ['en'], mustTranslate: false },
];
