"use client";

/**
 * English / French translations for the page.
 * The chosen language is saved in the browser (localStorage).
 * Default: French if the browser is in French, English otherwise.
 */

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type Lang = "en" | "fr";
const LANG_STORAGE_KEY = "clipping.lang";

type Tag = "fun" | "hype" | "ban" | "sub" | "donation";

const en = {
  tag: { fun: "Fun", hype: "Hype", ban: "Ban", sub: "Sub", donation: "Donation" } as Record<Tag, string>,

  // Header
  designedBy: "Designed by",
  loginNote:
    "If you are already logged in to Twitch, you can access the clip functionality. If you don't see the clip option, please make sure you log in to Twitch in another window.",
  videoUrl: "Video URL",
  language: "Language",

  // Highlight navigation under the video
  prevTitle: "Previous highlight (P)",
  prev: "Prev",
  nextTitle: "Next highlight (N)",
  firstHighlight: "First highlight",
  nextHighlight: "Next highlight",
  highlightsFound: (n: number) => `${n} highlight${n !== 1 ? "s" : ""} found`,

  // Chat replay panel
  chatReplay: "Chat Replay",
  msgs: "msgs",
  searchChat: "Search chat",
  searchPlaceholder: "Search chat messages...",
  search: "Search",
  scanningFullChat: "Scanning full chat replay...",
  resultsFound: (n: number) => `${n} result${n !== 1 ? "s" : ""} found`,
  noResults: "No results. Try a different keyword.",
  chatWillAppear: "Chat messages will appear here as the video plays...",
  loadingChat: "Loading chat...",
  resumeAutoScroll: "Resume auto-scroll",
  failedLoadChat: "Failed to load chat",
  searchFailed: "Search failed",

  // Counter
  scansPerformed: "Highlight scans performed",

  // Analysis
  analysisTitle: "Chat Analysis & Highlights",
  analyzing: "Analyzing chat...",
  reanalyze: "Re-analyze Chat",
  detect: "Detect Highlights from Chat",
  scanningChat: "Scanning chat for fun moments, hype, bans, subs & donations...",
  analysisError: "Analysis error:",
  unknownError: "Unknown error",
  serverError: (status: number) => `Server error ${status}`,
  analysisFailed: "Analysis failed",
  enterUrl: "Enter a Twitch VOD URL to detect highlights from chat replay.",
  clickDetect: "Click “Detect Highlights from Chat” to scan chat replay and find the best moments.",
  foundHighlights: (n: number, total: string) =>
    `Found **${n}** highlight${n !== 1 ? "s" : ""} from ${total} chat messages. Click to jump to a moment:`,
  tagCountTitle: (n: number, label: string) => `${n} ${label} highlight${n !== 1 ? "s" : ""}`,
  burstDetected: (x: string) => `Burst detected · ${x} intensity`,
  keywordTitle: (n: number, word: string) => `${n} messages with "${word}"`,
  chatActivity: "Chat activity (messages per minute)",
  msgsPerMin: "msgs/min",
  chartHint: "Colored bands = detected highlights. Click anywhere on the chart to jump to that moment.",
  noHighlights: "No clear highlights found. The chat may be too quiet or evenly distributed.",

  // Explanation
  howTitle: "How are highlights picked?",
  howIntro: (site: string) =>
    `${site} scans every chat message from the VOD replay and picks the **top 100 best moments**, with up to 50 slots reserved for the funniest ones. Only the strongest signals make the cut:`,
  step1Title: "1. Chat bucketing",
  step1: "All chat messages are grouped into 30-second time windows. Each window tracks total messages, recognized emotes, and reaction keywords.",
  step2Title: "2. Precise event detection",
  step2Ban: "are detected from the exact _\"has been banned\"_ system message.",
  step2Sub: "are detected from _\"is gifting N\"_ only when N ≥ 15.",
  step2Fun: "counts every laugh from the keyword list, including 7TV/BTTV emotes (KEKW, OMEGALUL, ICANT, xdd) and typed laughter (MDR, PTDR, JPP, LMAO, hahaha, 💀).",
  step2Hype: "uses PogChamp, lets go, OMG, WTF.",
  step2Don: "pick up Cheer bits and donation messages.",
  plural: { ban: "Bans", sub: "Subs", fun: "Fun", hype: "Hype", donation: "Donations" } as Record<Tag, string>,
  step3Title: "3. Spike detection",
  step3: "A sliding window merges adjacent buckets, then a velocity score rewards sudden spikes: if chat goes from quiet to wild, that moment gets a big boost (up to 2.5x).",
  step4Title: "4. Strict threshold",
  step4: "Only moments well above the stream's average activity are kept (mean + 1× standard deviation). This filters out ordinary chatter and keeps only the real peaks.",
  step5Title: "5. Funny moments first, then top 100",
  step5: "Funny moments are ranked by how many _different_ chatters laughed, how much of chat was laughing, and how suddenly it started. The best ones fill up to 50 slots, then the rest are filled by composite score (reactions + emotes + velocity + diversity), with a 60-second gap between clips. Each clip is centered on the reaction peak: it starts 20 seconds before chat explodes, to catch the setup and the punchline, and ends 10 seconds after, to keep the streamer's reaction.",
  legend: {
    fun: "Many chatters laughing (see Detection keywords)",
    hype: "PogChamp, lets go, OMG, WTF... (editable)",
    ban: "Exact \"has been banned\" system messages",
    sub: "Mass gifting events (15+ subs)",
    donation: "Cheer bits, donations, tips (editable)",
  } as Record<Tag, string>,

  // Footer
  footerHint: "Paste a Twitch VOD URL to preview the video, browse chat replay, and detect highlight moments from chat activity.",
  developedBy: "Developed by",

  // Keyword editor
  kwTitle: "Detection keywords",
  kwCustomized: "customized",
  kwShow: "Show & edit",
  kwHide: "Hide",
  kwIntro:
    "These words are what the analysis looks for in chat. Matching ignores case and catches stretched forms (_mdr_ also finds _mdrrrr_, _haha_ finds _hahahaha_). Your list is saved in **this browser only**. Click _Re-analyze Chat_ to apply changes.",
  kwReset: (label: string) => `Reset ${label}`,
  kwRemove: (word: string) => `Remove ${word}`,
  kwEmpty: "No keywords: this category is turned off.",
  kwAddPlaceholder: (label: string) => `Add to ${label} (comma-separated)`,
  kwAdd: "Add",
  kwAlways: "Always detected (Twitch system messages, not editable):",
  kwAlwaysBans: "bans (\"has been banned\")",
  kwAlwaysSubs: "sub gifts of 15 or more (\"is gifting N\")",
  kwAnd: "and",
  kwResetAll: "Reset all keywords to default",
  kwConfirmResetAll: "Restore all default keywords?",
};

export type Strings = typeof en;

const fr: Strings = {
  tag: { fun: "Drôle", hype: "Hype", ban: "Ban", sub: "Sub", donation: "Don" },

  designedBy: "Conçu par",
  loginNote:
    "Si vous êtes déjà connecté à Twitch, vous pouvez accéder à la fonctionnalité de clip. Si vous ne voyez pas l'option clip, veuillez vous connecter à Twitch dans une autre fenêtre.",
  videoUrl: "URL de la vidéo",
  language: "Langue",

  prevTitle: "Moment précédent (P)",
  prev: "Préc.",
  nextTitle: "Moment suivant (N)",
  firstHighlight: "Premier moment",
  nextHighlight: "Moment suivant",
  highlightsFound: (n) => `${n} moment${n > 1 ? "s" : ""} trouvé${n > 1 ? "s" : ""}`,

  chatReplay: "Replay du chat",
  msgs: "msgs",
  searchChat: "Rechercher dans le chat",
  searchPlaceholder: "Rechercher des messages...",
  search: "Rechercher",
  scanningFullChat: "Recherche dans tout le replay du chat...",
  resultsFound: (n) => `${n} résultat${n > 1 ? "s" : ""} trouvé${n > 1 ? "s" : ""}`,
  noResults: "Aucun résultat. Essayez un autre mot.",
  chatWillAppear: "Les messages du chat apparaîtront ici pendant la lecture...",
  loadingChat: "Chargement du chat...",
  resumeAutoScroll: "Reprendre le défilement automatique",
  failedLoadChat: "Impossible de charger le chat",
  searchFailed: "La recherche a échoué",

  scansPerformed: "Analyses de moments forts réalisées",

  analysisTitle: "Analyse du chat et moments forts",
  analyzing: "Analyse du chat en cours...",
  reanalyze: "Relancer l'analyse",
  detect: "Détecter les moments forts du chat",
  scanningChat: "Analyse du chat : moments drôles, hype, bans, subs et dons...",
  analysisError: "Erreur d'analyse :",
  unknownError: "Erreur inconnue",
  serverError: (status) => `Erreur serveur ${status}`,
  analysisFailed: "L'analyse a échoué",
  enterUrl: "Collez l'URL d'une VOD Twitch pour détecter les moments forts à partir du replay du chat.",
  clickDetect:
    "Cliquez sur « Détecter les moments forts du chat » pour analyser le replay et trouver les meilleurs moments.",
  foundHighlights: (n, total) =>
    `**${n}** moment${n > 1 ? "s" : ""} fort${n > 1 ? "s" : ""} trouvé${n > 1 ? "s" : ""} sur ${total} messages. Cliquez pour aller au moment :`,
  tagCountTitle: (n, label) => `${n} moment${n > 1 ? "s" : ""} « ${label} »`,
  burstDetected: (x) => `Rafale détectée · intensité ${x}`,
  keywordTitle: (n, word) => `${n} messages avec « ${word} »`,
  chatActivity: "Activité du chat (messages par minute)",
  msgsPerMin: "msgs/min",
  chartHint:
    "Bandes colorées = moments détectés. Cliquez n'importe où sur le graphique pour aller à ce moment.",
  noHighlights: "Aucun moment fort clair. Le chat est peut-être trop calme ou trop régulier.",

  howTitle: "Comment les moments forts sont-ils choisis ?",
  howIntro: (site) =>
    `${site} analyse chaque message du replay du chat et garde les **100 meilleurs moments**, dont jusqu'à 50 places réservées aux plus drôles. Seuls les signaux les plus forts sont retenus :`,
  step1Title: "1. Découpage du chat",
  step1:
    "Tous les messages sont regroupés par fenêtres de 30 secondes. Chaque fenêtre compte les messages, les emotes reconnues et les mots-clés de réaction.",
  step2Title: "2. Détection précise des événements",
  step2Ban: "sont détectés grâce au message système exact _« has been banned »_.",
  step2Sub: "sont détectés grâce à _« is gifting N »_, seulement quand N ≥ 15.",
  step2Fun:
    "compte chaque rire de la liste de mots-clés, y compris les emotes 7TV/BTTV (KEKW, OMEGALUL, ICANT, xdd) et les rires tapés (MDR, PTDR, JPP, LMAO, hahaha, 💀).",
  step2Hype: "utilise PogChamp, lets go, OMG, WTF.",
  step2Don: "repèrent les Cheers (bits) et les messages de dons.",
  plural: { ban: "Les bans", sub: "Les subs", fun: "Drôle", hype: "Hype", donation: "Les dons" },
  step3Title: "3. Détection des pics",
  step3:
    "Une fenêtre glissante fusionne les tranches voisines, puis un score de vitesse récompense les pics soudains : si le chat passe du calme à l'explosion, ce moment reçoit un gros bonus (jusqu'à ×2,5).",
  step4Title: "4. Seuil strict",
  step4:
    "Seuls les moments nettement au-dessus de l'activité moyenne du stream sont gardés (moyenne + 1 écart-type). Cela élimine les discussions ordinaires pour ne garder que les vrais pics.",
  step5Title: "5. Les moments drôles d'abord, puis le top 100",
  step5:
    "Les moments drôles sont classés selon le nombre de personnes _différentes_ qui rient, la part du chat qui rit, et la soudaineté du rire. Les meilleurs occupent jusqu'à 50 places, puis le reste est complété par le score global (réactions + emotes + vitesse + diversité), avec 60 secondes d'écart entre deux clips. Chaque clip est calé sur le pic de réaction : il commence 20 secondes avant que le chat explose, pour avoir la mise en place et la chute, et se termine 10 secondes après, pour garder la réaction du streamer.",
  legend: {
    fun: "Beaucoup de personnes qui rient (voir Mots-clés de détection)",
    hype: "PogChamp, lets go, OMG, WTF... (modifiable)",
    ban: "Messages système exacts « has been banned »",
    sub: "Gros gifts de subs (15 ou plus)",
    donation: "Cheers (bits), dons, tips (modifiable)",
  },

  footerHint:
    "Collez l'URL d'une VOD Twitch pour voir la vidéo, parcourir le replay du chat et détecter les moments forts grâce à l'activité du chat.",
  developedBy: "Développé par",

  kwTitle: "Mots-clés de détection",
  kwCustomized: "personnalisés",
  kwShow: "Afficher et modifier",
  kwHide: "Masquer",
  kwIntro:
    "Ce sont les mots que l'analyse cherche dans le chat. Les majuscules sont ignorées et les formes allongées sont reconnues (_mdr_ trouve aussi _mdrrrr_, _haha_ trouve _hahahaha_). Votre liste est enregistrée **dans ce navigateur uniquement**. Cliquez sur _Relancer l'analyse_ pour appliquer les changements.",
  kwReset: (label) => `Réinitialiser ${label}`,
  kwRemove: (word) => `Retirer ${word}`,
  kwEmpty: "Aucun mot-clé : cette catégorie est désactivée.",
  kwAddPlaceholder: (label) => `Ajouter à ${label} (séparés par des virgules)`,
  kwAdd: "Ajouter",
  kwAlways: "Toujours détectés (messages système de Twitch, non modifiables) :",
  kwAlwaysBans: "les bans (« has been banned »)",
  kwAlwaysSubs: "les gifts de 15 subs ou plus (« is gifting N »)",
  kwAnd: "et",
  kwResetAll: "Remettre tous les mots-clés par défaut",
  kwConfirmResetAll: "Remettre tous les mots-clés par défaut ?",
};

const STRINGS: Record<Lang, Strings> = { en, fr };

/** Renders **bold** and _italic_ markers from a translated string. */
export function rich(text: string, boldClass = "text-gray-300"): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|_[^_]+_)/g);
  return parts.map((p, i) => {
    if (p.startsWith("**") && p.endsWith("**")) return <strong key={i} className={boldClass}>{p.slice(2, -2)}</strong>;
    if (p.length > 2 && p.startsWith("_") && p.endsWith("_")) return <em key={i}>{p.slice(1, -1)}</em>;
    return p;
  });
}

interface I18n {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: Strings;
}

const I18nContext = createContext<I18n>({ lang: "en", setLang: () => {}, t: en });

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>("en");

  useEffect(() => {
    let initial: Lang = "en";
    try {
      const saved = window.localStorage.getItem(LANG_STORAGE_KEY);
      if (saved === "en" || saved === "fr") initial = saved;
      else if (navigator.language?.toLowerCase().startsWith("fr")) initial = "fr";
    } catch {
      if (navigator.language?.toLowerCase().startsWith("fr")) initial = "fr";
    }
    setLangState(initial);
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  function setLang(l: Lang) {
    setLangState(l);
    try {
      window.localStorage.setItem(LANG_STORAGE_KEY, l);
    } catch {
      // Storage unavailable: the choice lasts for this visit only
    }
  }

  return <I18nContext.Provider value={{ lang, setLang, t: STRINGS[lang] }}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  return useContext(I18nContext);
}

/** EN / FR switch, meant for the top-right corner of the page. */
export function LanguageSwitch() {
  const { lang, setLang, t } = useI18n();
  return (
    <div
      role="group"
      aria-label={t.language}
      className="inline-flex shrink-0 overflow-hidden rounded-lg border border-gray-700 bg-gray-900 text-xs font-semibold"
    >
      {(["fr", "en"] as Lang[]).map((l) => (
        <button
          key={l}
          type="button"
          onClick={() => setLang(l)}
          aria-pressed={lang === l}
          className={`px-3 py-1.5 transition ${
            lang === l ? "bg-purple-600 text-white" : "text-gray-400 hover:bg-gray-800 hover:text-gray-200"
          }`}
        >
          {l === "fr" ? "🇫🇷 FR" : "🇬🇧 EN"}
        </button>
      ))}
    </div>
  );
}
