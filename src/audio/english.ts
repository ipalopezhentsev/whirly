// Text → phonemes, for the speaking synthetic voice. English words use the rules below; Cyrillic
// words go to russian.ts.
//
// Letter-to-sound rules after the US Naval Research Laboratory set (Elovitz, Johnson, McHugh &
// Shore, 1976), plus a small dictionary of common words the rules get wrong.
//
// Rule format: `left[MATCH]right=PHONEMES`. The first matching rule for the current letter wins.
// Context symbols:   (space) a word boundary   # one or more vowels   : zero or more consonants
//   ^ one consonant   . one voiced consonant (B D V G J L M N R W Z)   + E, I or Y
//   % (right side only) a suffix: E, ER, ES, ED, ING, ELY
// Phonemes are written compactly: two upper-case letters for vowels and CH SH ZH TH DH NG WH,
// one lower-case letter for the other consonants (j = JH, y = Y, h = HH).
import { capitalStress, hasCyrillic, russianNumber, russianWord, RUSSIAN_DIGITS } from './russian';

const RULE_TEXT: Record<string, string[]> = {
  A: [
    '[A] =AX', ' [ARE] =AAr', ' [AR]O=AXr', '[AR]#=EHr', '^[AS]#=EYs', '[A]WA=AX', '[AW]=AO',
    ' :[ANY]=EHnIY', '[A]^+#=EY', '#:[ALLY]=AXlIY', ' [AL]#=AXl', '[AGAIN]=AXgEHn', '#:[AG]E=IHj',
    '[A]^+:#=AE', ' :[A]^+ =EY', '[A]^%=EY', ' [ARR]=AXr', '[ARR]=AEr', ' :[AR] =AAr', '[AR] =ER',
    '[AR]=AAr', '[AIR]=EHr', '[AI]=EY', '[AY]=EY', '[AU]=AO', '#:[AL] =AXl', '#:[ALS] =AXlz',
    '[ALK]=AOk', '[AL]^=AOl', ' :[ABLE]=EYbAXl', '[ABLE]=AXbAXl', '[ANG]+=EYnj', '[A]=AE',
  ],
  B: [' [BE]^#=bIH', '[BEING]=bIYIHNG', ' [BOTH] =bOWTH', ' [BUS]#=bIHz', '[BUIL]=bIHl', '[B]=b'],
  C: [
    ' [CH]^=k', '^E[CH]=k', '[CH]=CH', ' S[CI]#=sAY', '[CI]A=SH', '[CI]O=SH', '[CI]EN=SH', '[C]+=s',
    '[CK]=k', '[COM]%=kAHm', '[C]=k',
  ],
  D: [
    '#:[DED] =dIHd', '.E[D] =d', '#:^E[D] =t', ' [DE]^#=dIH', ' [DO] =dUW', ' [DOES]=dAHz',
    ' [DOING]=dUWIHNG', ' [DOW]=dAW', '[DU]A=jUW', '[D]=d',
  ],
  E: [
    '#:[E] =', "':^[E] =", ' :[E] =IY', '#[ED] =d', '#:[E]D =', '[EV]ER=EHv', '[E]^%=IY',
    '[ERI]#=IYrIY', '[ERI]=EHrIH', '#:[ER]#=ER', '[ER]#=EHr', '[ER]=ER', ' [EVEN]=IYvEHn', '#:[E]W=',
    'T[EW]=UW', 'S[EW]=UW', 'R[EW]=UW', 'D[EW]=UW', 'L[EW]=UW', 'Z[EW]=UW', 'N[EW]=UW', 'J[EW]=UW',
    'TH[EW]=UW', 'CH[EW]=UW', 'SH[EW]=UW', '[EW]=yUW', '[E]O=IY', '#:S[ES] =IHz', '#:C[ES] =IHz',
    '#:G[ES] =IHz', '#:Z[ES] =IHz', '#:X[ES] =IHz', '#:J[ES] =IHz', '#:CH[ES] =IHz', '#:SH[ES] =IHz',
    '#:[E]S =', '#:[ELY] =lIY', '#:[EMENT]=mEHnt', '[EFUL]=fUHl', '[EE]=IY', '[EARN]=ERn', ' [EAR]^=ER',
    '[EAD]=EHd', '#:[EA] =IYAX', '[EA]SU=EH', '[EA]=IY', '[EIGH]=EY', '[EI]=IY', ' [EYE]=AY', '[EY]=IY',
    '[EU]=yUW', '[E]=EH',
  ],
  F: ['[FUL]=fUHl', '[F]=f'],
  G: [
    '[GIV]=gIHv', ' [G]I^=g', '[GE]T=gEH', 'SU[GGES]=gjEHs', '[GG]=g', ' B#[G]=g', '[G]+=j',
    '[GREAT]=grEYt', '#[GH]=', '[G]=g',
  ],
  H: [' [HAV]=hAEv', ' [HERE]=hIYr', ' [HOUR]=AWER', '[HOW]=hAW', '[H]#=h', '[H]='],
  I: [
    ' [IN]=IHn', ' [I] =AY', '[IN]D=AYn', '[IER]=IYER', '#:R[IED]=IYd', '[IED] =AYd', '[IEN]=IYEHn',
    '[IE]T=AYEH', ' :[I]%=AY', '[I]%=IY', '[IE]=IY', '[I]^+:#=IH', '[IR]#=AYr', '[IZ]%=AYz',
    '[IS]%=AYz', '[I]D%=AY', '+^[I]^+=IH', '[I]T%=AY', '#:^[I]^+=IH', '[I]^+=AY', '[IR]=ER',
    '[IGH]=AY', '[ILD]=AYld', '[IGN] =AYn', '[IGN]^=AYn', '[IGN]%=AYn', '[IQUE]=IYk', '[I]=IH',
  ],
  J: ['[J]=j'],
  K: [' [K]N=', '[K]=k'],
  L: ['[LO]C#=lOW', 'L[L]=', '#:^[L]%=AXl', '[LEAD]=lIYd', '[L]=l'],
  M: ['[MOV]=mUWv', '[M]=m'],
  N: [
    'E[NG]+=nj', '[NG]R=NGg', '[NG]#=NGg', '[NGL]%=NGgAXl', '[NG]=NG', '[NK]=NGk', ' [NOW] =nAW', '[N]=n',
  ],
  O: [
    '[OF] =AXv', '[OROUGH]=EROW', '#:[OR] =ER', '#:[ORS] =ERz', '[OR]=AOr', ' [ONE]=wAHn', '[OW]=OW',
    ' [OVER]=OWvER', '[OV]=AHv', '[O]^%=OW', '[O]^EN=OW', '[O]^I#=OW', '[OL]D=OWl', '[OUGHT]=AOt',
    '[OUGH]=AHf', ' [OU]=AW', 'H[OU]S#=AW', '[OUS]=AXs', '[OUR]=AOr', '[OULD]=UHd', '^[OU]^L=AH',
    '[OUP]=UWp', '[OU]=AW', '[OY]=OY', '[OING]=OWIHNG', '[OI]=OY', '[OOR]=AOr', '[OOK]=UHk',
    '[OOD]=UHd', '[OO]=UW', '[O]E=OW', '[O] =OW', '[OA]=OW', ' [ONLY]=OWnlIY', ' [ONCE]=wAHns',
    "[ON'T]=OWnt", 'C[O]N=AA', '[O]NG=AO', ' :^[O]N=AH', 'I[ON]=AXn', '#:[ON] =AXn', '#^[ON]=AXn',
    '[O]ST =OW', '[OF]^=AOf', '[OTHER]=AHDHER', '[OSS] =AOs', '#:^[OM]=AHm', '[O]=AA',
  ],
  P: ['[PH]=f', '[PEOP]=pIYp', '[POW]=pAW', '[PUT] =pUHt', '[P]=p'],
  Q: ['[QUAR]=kwAOr', '[QU]=kw', '[Q]=k'],
  R: [' [RE]^#=rIY', '[R]=r'],
  S: [
    '[SH]=SH', '#[SION]=ZHAXn', '[SOME]=sAHm', '#[SUR]#=ZHER', '[SUR]#=SHER', '#[SU]#=ZHUW',
    '#[SSU]#=SHUW', '#[SED] =zd', '#[S]#=z', '[SAID]=sEHd', '^[SION]=SHAXn', '[S]S=', '.[S] =z',
    '#:.E[S] =z', '#:^##[S] =z', '#:^#[S] =s', 'U[S] =s', ' :#[S] =z', ' [SCH]=sk', '[S]C+=',
    '#[SM]=zm', "#[SN]'=zAXn", '[S]=s',
  ],
  T: [
    ' [THE] =DHAX', '[TO] =tUW', '[THAT] =DHAEt', ' [THIS] =DHIHs', ' [THEY]=DHEY', ' [THERE]=DHEHr',
    '[THER]=DHER', '[THEIR]=DHEHr', ' [THAN] =DHAEn', ' [THEM] =DHEHm', '[THESE] =DHIYz', ' [THEN]=DHEHn',
    '[THROUGH]=THrUW', '[THOSE]=DHOWz', '[THOUGH] =DHOW', ' [THUS]=DHAHs', '[TH]=TH', '#:[TED] =tIHd',
    'S[TI]#N=CH', '[TI]O=SH', '[TI]A=SH', '[TIEN]=SHAXn', '[TUR]#=CHER', '[TU]A=CHUW', ' [TWO]=tUW', '[T]=t',
  ],
  U: [
    ' [UN]I=yUWn', ' [UN]=AHn', ' [UPON]=AXpAOn', 'T[UR]#=UHr', 'S[UR]#=UHr', 'R[UR]#=UHr', 'D[UR]#=UHr',
    'L[UR]#=UHr', 'Z[UR]#=UHr', 'N[UR]#=UHr', 'J[UR]#=UHr', 'TH[UR]#=UHr', 'CH[UR]#=UHr', 'SH[UR]#=UHr',
    '[UR]#=yUHr', '[UR]=ER', '[U]^ =AH', '[U]^^=AH', '[UY]=AY', ' G[U]#=', 'G[U]%=', 'G[U]#=w',
    '#N[U]=yUW', 'T[U]=UW', 'S[U]=UW', 'R[U]=UW', 'D[U]=UW', 'L[U]=UW', 'Z[U]=UW', 'N[U]=UW', 'J[U]=UW',
    'TH[U]=UW', 'CH[U]=UW', 'SH[U]=UW', '[U]=yUW',
  ],
  V: ['[VIEW]=vyUW', '[V]=v'],
  W: [
    ' [WERE]=wER', '[WA]S=wAA', '[WA]T=wAA', '[WHERE]=WHEHr', '[WHAT]=WHAAt', '[WHOL]=hOWl', '[WHO]=hUW',
    '[WH]=WH', '[WAR]=wAOr', '[WOR]^=wER', '[WR]=r', '[W]=w',
  ],
  X: ['[X]=ks'],
  Y: [
    '[YOUNG]=yAHNG', ' [YOU]=yUW', ' [YES]=yEHs', ' [Y]=y', '#:^[Y] =IY', '#:^[Y]I=IY', ' :[Y] =AY',
    ' :[Y]#=AY', ' :[Y]^+:#=IH', ' :[Y]^#=AY', '[Y]=IH',
  ],
  Z: ['[Z]=z'],
};

/** Common words the rules get wrong. */
const DICT: Record<string, string> = {
  a: 'AX', an: 'AEn', i: 'AY', is: 'IHz', his: 'hIHz', as: 'AEz', has: 'hAEz', was: 'wAAz', of: 'AXv',
  to: 'tUW', do: 'dUW', you: 'yUW', your: 'yAOr', are: 'AAr', one: 'wAHn', two: 'tUW', eye: 'AY',
  says: 'sEHz', said: 'sEHd', what: 'wAHt', give: 'gIHv', live: 'lIHv', have: 'hAEv', love: 'lAHv',
  come: 'kAHm', some: 'sAHm', done: 'dAHn', gone: 'gAOn', none: 'nAHn', once: 'wAHns', word: 'wERd',
  work: 'wERk', world: 'wERld', woman: 'wUHmAXn', women: 'wIHmIHn', could: 'kUHd', should: 'SHUHd',
  would: 'wUHd', there: 'DHEHr', where: 'wEHr', here: 'hIYr', were: 'wER', be: 'bIY', he: 'hIY',
  she: 'SHIY', we: 'wIY', me: 'mIY', my: 'mAY', by: 'bAY', ok: 'OWkEY', okay: 'OWkEY', hi: 'hAY',
  many: 'mEHnIY', any: 'EHnIY', very: 'vEHrIY', again: 'AXgEHn', because: 'bIHkAHz', people: 'pIYpAXl',
  from: 'frAHm', listen: 'lIHsAXn', voice: 'vOYs', claude: 'klAOd', hello: 'hEHlOW', yes: 'yEHs',
  no: 'nOW', go: 'gOW', so: 'sOW', they: 'DHEY', their: 'DHEHr', who: 'hUW', whose: 'hUWz',
  friend: 'frEHnd', four: 'fAOr', eight: 'EYt', minus: 'mAYnAXs', zero: 'zIYrOW', point: 'pOYnt',
  today: 'tAXdEY', tomorrow: 'tAXmAArOW', together: 'tAXgEHDHER', down: 'dAWn', town: 'tAWn',
  brown: 'brAWn', crown: 'krAWn', cow: 'kAW', wow: 'wAW', owl: 'AWl', crowd: 'krAWd', allow: 'AXlAW',
  power: 'pAWER', flower: 'flAWER', tower: 'tAWER', shower: 'SHAWER', browser: 'brAWzER',
  audio: 'AOdIYOW', video: 'vIHdIYOW', radio: 'rEYdIYOW', "there's": 'DHEHrz',
};

/** Words that stay unstressed in a phrase. */
const FUNCTION_WORDS = new Set(
  ('a an the of to in on at for by with and or but nor is are was were be been am it its as that this ' +
    'these those i you he she we they me him her us them my your his our their do does did has have ' +
    'had not so if than then from up into will would can could should shall may might must there ' +
    'here which who whom whose some such just very').split(' '),
);

const LETTER_NAMES: Record<string, string> = {
  A: 'EY', B: 'bIY', C: 'sIY', D: 'dIY', E: 'IY', F: 'EHf', G: 'jIY', H: 'EYCH', I: 'AY', J: 'jEY',
  K: 'kEY', L: 'EHl', M: 'EHm', N: 'EHn', O: 'OW', P: 'pIY', Q: 'kyUW', R: 'AAr', S: 'EHs', T: 'tIY',
  U: 'yUW', V: 'vIY', W: 'dAHbAXlyUW', X: 'EHks', Y: 'wAY', Z: 'zIY',
};

// ---------------------------------------------------------------- rule engine

interface Rule { left: string; match: string; right: string; out: string }

const RULES: Record<string, Rule[]> = Object.fromEntries(
  Object.entries(RULE_TEXT).map(([k, list]) => [k, list.map((s) => {
    const m = /^(.*)\[(.+)\](.*)=(.*)$/.exec(s);
    if (!m) throw new Error(`Bad rule ${s}`);
    return { left: m[1], match: m[2], right: m[3], out: m[4] };
  })]),
);

const isLetter = (c: string | undefined) => c !== undefined && c >= 'A' && c <= 'Z';
const isVowel = (c: string | undefined) => c !== undefined && c.length === 1 && 'AEIOU'.includes(c);
const isCons = (c: string | undefined) => isLetter(c) && !isVowel(c);
const inSet = (set: string, c: string | undefined) => c !== undefined && c.length === 1 && set.includes(c);

function leftMatch(pat: string, s: string, pos: number) {
  for (let k = pat.length - 1; k >= 0; k--) {
    const p = pat[k];
    const c = s[pos];
    switch (p) {
      case ' ': if (isLetter(c)) return false; pos--; break;
      case '#': if (!isVowel(c)) return false; pos--; while (isVowel(s[pos])) pos--; break;
      case ':': while (isCons(s[pos])) pos--; break;
      case '^': if (!isCons(c)) return false; pos--; break;
      case '.': if (!inSet('BDVGJLMNRWZ', c)) return false; pos--; break;
      case '+': if (!inSet('EIY', c)) return false; pos--; break;
      default: if (c !== p) return false; pos--;
    }
  }
  return true;
}

function rightMatch(pat: string, s: string, pos: number) {
  for (const p of pat) {
    const c = s[pos];
    switch (p) {
      case ' ': if (isLetter(c)) return false; pos++; break;
      case '#': if (!isVowel(c)) return false; pos++; while (isVowel(s[pos])) pos++; break;
      case ':': while (isCons(s[pos])) pos++; break;
      case '^': if (!isCons(c)) return false; pos++; break;
      case '.': if (!inSet('BDVGJLMNRWZ', c)) return false; pos++; break;
      case '+': if (!inSet('EIY', c)) return false; pos++; break;
      case '%':
        if (c === 'E') {
          pos++;
          if (s[pos] === 'L') {
            if (s[pos + 1] === 'Y') pos += 2;
          } else if (inSet('RSD', s[pos])) pos++;
        } else if (c === 'I' && s[pos + 1] === 'N' && s[pos + 2] === 'G') pos += 3;
        else return false;
        break;
      default: if (c !== p) return false; pos++;
    }
  }
  return true;
}

const LOWER: Record<string, string> = {
  b: 'B', d: 'D', f: 'F', g: 'G', h: 'HH', j: 'JH', k: 'K', l: 'L', m: 'M', n: 'N', p: 'P', r: 'R',
  s: 'S', t: 'T', v: 'V', w: 'W', y: 'Y', z: 'Z',
};

/** Split the compact phoneme notation into ARPAbet symbols. */
function splitPhones(s: string) {
  const out: string[] = [];
  for (let i = 0; i < s.length;) {
    const c = s[i];
    if (LOWER[c]) {
      out.push(LOWER[c]);
      i++;
    } else {
      const two = s.slice(i, i + 2);
      out.push(two === 'WH' ? 'W' : two);
      i += 2;
    }
  }
  // Doubled consonant letters ("apple", "summer") are said once.
  return out.filter((p, i) => p !== out[i - 1] || VOWELS.has(p));
}

function wordToCompact(word: string) {
  const s = ` ${word} `;
  let out = '';
  for (let i = 1; i < s.length - 1;) {
    const rules = RULES[s[i]];
    const rule = rules?.find((r) => s.startsWith(r.match, i) && leftMatch(r.left, s, i - 1) && rightMatch(r.right, s, i + r.match.length));
    if (!rule) {
      i++;
      continue;
    }
    out += rule.out;
    i += rule.match.length;
  }
  return out;
}

// ---------------------------------------------------------------- numbers

const ONES = 'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen'.split(' ');
const TENS = ' ten twenty thirty forty fifty sixty seventy eighty ninety'.split(' ');

function numberWords(n: number): string {
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? ` ${ONES[n % 10]}` : '');
  if (n < 1000) return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${numberWords(n % 100)}` : ''}`;
  for (const [v, name] of [[1e9, 'billion'], [1e6, 'million'], [1e3, 'thousand']] as const) {
    if (n >= v) return `${numberWords(Math.floor(n / v))} ${name}${n % v ? ` ${numberWords(n % v)}` : ''}`;
  }
  return String(n);
}

function expandNumbers(text: string, ru: boolean) {
  const digits = ru ? RUSSIAN_DIGITS : ONES;
  const spell = (s: string) => s.split('').map((d) => digits[+d]).join(' ');
  return text.replace(/\d+(?:[.,]\d+)?/g, (m) => {
    const [int, frac] = m.split(/[.,]/);
    const n = parseInt(int, 10);
    const words = int.length > 12 ? spell(int) : ru ? russianNumber(n) : numberWords(n);
    return ` ${words}${frac ? ` ${ru ? 'т+очка' : 'point'} ${spell(frac)}` : ''} `;
  });
}

// ---------------------------------------------------------------- public

export interface Word {
  phones: string[];
  /** Index into `phones` of the stressed vowel, or −1. */
  stress: number;
  /** Russian word (affects how stops are released). */
  ru?: boolean;
}

export interface Phrase {
  words: Word[];
  /** Punctuation that ended the phrase: shapes the pitch contour. */
  end: '.' | ',' | '?' | '!';
  /** Pause after it from punctuation, seconds at normal speed (scaled by the speaking rate). */
  pause: number;
  /** Explicit `[n]` silence after it, seconds (not scaled). */
  silence: number;
  /** Exclamation strength: 0 none, 1 for "!", 2 for "!!", 3 for "!!!" or more. */
  excl: number;
}

const VOWELS = new Set(['IY', 'IH', 'EY', 'EH', 'AE', 'AA', 'AO', 'OW', 'UH', 'UW', 'AH', 'AX', 'ER', 'AY', 'AW', 'OY', 'YI', 'OH', 'UU', 'AR']);
export const isVowelPhone = (p: string) => VOWELS.has(p);

function wordPhones(raw: string): Word {
  const lower = raw.toLowerCase().replace(/^'+|'+$/g, '');
  const up = lower.toUpperCase();
  let compact: string;
  if (DICT[lower]) compact = DICT[lower];
  else if (up.length === 1 || !/[AEIOUY]/.test(up)) compact = up.split('').map((c) => LETTER_NAMES[c] ?? '').join('');
  else compact = wordToCompact(up);
  const phones = splitPhones(compact);
  let stress = -1;
  if (!FUNCTION_WORDS.has(lower)) {
    const vowels = phones.flatMap((p, i) => (VOWELS.has(p) && p !== 'AX' ? [i] : []));
    stress = vowels[0] ?? phones.findIndex((p) => VOWELS.has(p));
    // be-, de-, re- prefixes are usually unstressed
    if (vowels.length > 1 && /^(be|de|re)./.test(lower) && (phones[stress] === 'IH' || phones[stress] === 'IY')) stress = vowels[1];
  }
  return { phones, stress };
}

/** Placeholder for a `[1.5]` pause marker while the text is normalized (it holds digits). */
const PAUSE = '\uE000';
const PUNCT_PAUSE = { ',': 0.2, '.': 0.42, '?': 0.42, '!': 0.42 } as const;

/** Turn text into phrases of phonemes. */
export function textToPhrases(text: string): Phrase[] {
  const ru = hasCyrillic(text);
  const silences: number[] = [];
  const marked = text.replace(/\[\s*(\d+(?:[.,]\d+)?)\s*s?\s*\]/gi, (_, n: string) => {
    silences.push(Math.min(60, parseFloat(n.replace(',', '.'))));
    return ` ${PAUSE} `;
  });
  // A '+' right before a Cyrillic vowel marks stress (молок+о); anywhere else it reads as "plus".
  const norm = expandNumbers(marked, ru)
    .replace(/[\u2019\u2018]/g, "'")
    .replace(/&/g, ru ? ' и ' : ' and ').replace(/%/g, ru ? ' проц+ентов ' : ' percent ')
    .replace(/\+(?![аеёиоуыэюяАЕЁИОУЫЭЮЯ])/g, ru ? ' пл+юс ' : ' plus ').replace(/@/g, ' at ')
    .replace(/[\u2014\u2013]|\s-\s/g, ',');
  const phrases: Phrase[] = [];
  let words: Word[] = [];
  let prefix = '';
  const tokens = norm.match(/[A-Za-z']+|[\u0400-\u04FF+=\u0301]*[\u0400-\u04FF][\u0400-\u04FF+=\u0301]*|[.,!?;:\n\uE000]/g) ?? [];
  for (const tok of tokens) {
    if (/^[A-Za-z']+$/.test(tok)) {
      const w = wordPhones(tok);
      if (w.phones.length) words.push(w);
      continue;
    }
    if (hasCyrillic(tok)) {
      // One-consonant prepositions (в, к, с) are said as part of the next word.
      if (!/[аеёиоуыэюя]/i.test(tok)) {
        prefix += tok;
        continue;
      }
      const w = russianWord(prefix + capitalStress(tok));
      prefix = '';
      if (w.phones.length) words.push(w);
      continue;
    }
    const last = phrases[phrases.length - 1];
    if (tok === PAUSE) {
      const secs = silences.shift() ?? 0;
      // Mid-sentence, the phrase before the pause keeps a level, unfinished pitch.
      if (words.length) phrases.push({ words, end: ',', pause: 0, silence: secs, excl: 0 });
      else if (last) last.silence += secs;
      else phrases.push({ words: [], end: ',', pause: 0, silence: secs, excl: 0 });
      words = [];
      continue;
    }
    const end = tok === '?' ? '?' : tok === '!' ? '!' : tok === ',' || tok === ';' || tok === ':' ? ',' : '.';
    if (words.length) {
      phrases.push({ words, end, pause: PUNCT_PAUSE[end], silence: 0, excl: end === '!' ? 1 : 0 });
      words = [];
    } else if (last && tok === '!' && (last.end === '!' || last.end === '?')) {
      // "!!" and "!!!" shout harder; "?!" is an emphatic question.
      last.excl = Math.min(3, last.excl + 1);
    } else if (last && end !== '?' && end !== '!') {
      // Repeated punctuation ("...", ",,", blank lines) stretches the pause.
      last.pause += PUNCT_PAUSE[end] / 2;
    }
  }
  if (words.length) phrases.push({ words, end: '.', pause: PUNCT_PAUSE['.'], silence: 0, excl: 0 });
  // Text that ends on a pause marker still ends like a sentence.
  const final = phrases[phrases.length - 1];
  if (final?.words.length && final.end === ',' && !final.pause) final.end = '.';
  return phrases;
}
