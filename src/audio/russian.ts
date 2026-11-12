// Russian text → phonemes, for the speaking synthetic voice.
//
// Russian spelling is close to phonetic, so plain rules get most of the way: soft (palatalized)
// consonants before е ё и ю я ь, vowel reduction away from the stress, final devoicing and voicing
// assimilation in consonant clusters. Stress is the hard part: it is unpredictable, so it comes
// from (1) a mark in the text — "+" before the vowel (молок+о) or a combining acute accent after it —
// (2) ё, (3) a small dictionary of common words, else (4) a guess from the ending.
// "=" before a vowel (мол=око) keeps it as written, without reduction, but unstressed.
//
// Phonemes are ARPAbet-like, plus YI (ы), OH (о), UU (у), AR (weak unstressed а), KH (х), TS (ц), SHH (щ), RR (trilled р),
// LX (hard л); a trailing ' marks a soft consonant.
import type { Word } from './english';

const VOWELS = 'аеёиоуыэюя';
const IOTATED = 'еёюя';
const SOFTENERS = 'еёиюяь';
const CONS: Record<string, string> = {
  б: 'B', в: 'V', г: 'G', д: 'D', ж: 'ZH', з: 'Z', й: 'Y', к: 'K', л: 'LX', м: 'M', н: 'N', п: 'P', р: 'RR',
  с: 'S', т: 'T', ф: 'F', х: 'KH', ц: 'TS', ч: 'CH', ш: 'SH', щ: 'SHH',
};
const ALWAYS_HARD = 'жшц';
/** Soft by nature: never take a soft mark. */
const ALWAYS_SOFT = 'чщй';

const DEVOICE: Record<string, string> = { B: 'P', V: 'F', G: 'K', D: 'T', ZH: 'SH', Z: 'S' };
const VOICE: Record<string, string> = { P: 'B', F: 'V', K: 'G', T: 'D', SH: 'ZH', S: 'Z' };
const VOICELESS = new Set(['P', 'F', 'K', 'T', 'SH', 'S', 'KH', 'TS', 'CH', 'SHH']);
/** Voiced obstruents that voice a consonant before them (в does not). */
const VOICING = new Set(['B', 'G', 'D', 'ZH', 'Z']);
const VOWEL_PHONES = new Set(['AA', 'AH', 'AR', 'OH', 'UU', 'YI', 'EH', 'IY', 'IH']);

/** Common words with their stress marked. */
const STRESSED = new Map(
  (
    'прив+ет спас+ибо пож+алуйста здр+авствуйте хорош+о пок+а сейч+ас тепер+ь сег+одня з+автра вчер+а ' +
    '+утро в+ечер вр+емя челов+ек л+юди вод+а земл+я раб+ота г+ород стран+а сл+ово г+олос м+узыка рук+а ' +
    'голов+а м+ама п+апа он+а он+о он+и мен+я теб+я ег+о ем+у мо+я тво+я сво+я н+аша в+аша +ей +этот ' +
    '+эта +это +эти вс+е всег+о когд+а почем+у зач+ем как+ой как+ая как+ое ск+олько +очень т+оже т+акже ' +
    'т+олько уж+е м+ожно н+ужно н+адо д+елать д+умать в+идеть сл+ышать сл+ушать идт+и ид+у б+ыло б+ыли ' +
    'был+а б+удет б+удут м+ожет м+ожно хоч+у зн+аю любл+ю дав+ай дав+айте больш+ой м+аленький н+овый ' +
    'ст+арый хор+оший пл+охо крас+ивый од+ин одн+а одн+о чет+ыре в+осемь д+евять д+есять од+иннадцать ' +
    'двен+адцать трин+адцать чет+ырнадцать пятн+адцать шестн+адцать семн+адцать восемн+адцать ' +
    'девятн+адцать дв+адцать тр+идцать с+орок пятьдес+ят шестьдес+ят с+емьдесят в+осемьдесят девян+осто ' +
    'дв+ести тр+иста чет+ыреста пятьс+от шестьс+от семьс+от восемьс+от девятьс+от т+ысяча т+ысячи ' +
    'т+ысяч милли+он милли+она милли+онов т+очка м+инус проц+ент проц+ентов Росс+ия р+усский яз+ык ' +
    'Москв+а вним+ание извин+ите прош+у сл+ушай смотр+и вперед+и сз+ади спр+ава сл+ева наверх+у вниз+у ' +
    'р+ядом далек+о бл+изко сюд+а туд+а оп+ять сн+ова пот+ом снач+ала пр+осто пр+авда кон+ечно вообщ+е ' +
    'напр+имер говор+ю сл+ышишь сл+ышите зов+ут +имя дел+а дев+ушка д+ети д+оброе ' +
    'д+обрый д+обрый д+ень спок+ойной н+очи свид+ания п+омощь пом+огите сп+ать ' +
    'рубл+ей сто+ят Иль+я молок+о окн+о письм+о сестр+а от+ец отц+а наобор+от ' +
    'кон+ец сапог+и сапог+ах больш+ое п+ишет говор+ит см+отрит д+елает вопр+ос отв+ет ' +
    'дев+очка мальч+ик соб+ака корол+ева зв+ёзды пес+ок лес+а +есть п+ить ид+ёт ид+ём пойдём игр+ать м+ожет +если ч+ерез п+осле п+еред м+ежду +или'
  ).split(/\s+/).filter(Boolean).map((w) => [w.replace(/\+/g, '').toLowerCase(), w.toLowerCase()]),
);

/** Words that stay unstressed in a phrase. */
const UNSTRESSED = new Set('и а но в во на с со к ко у о об по за из от до не ни же ли бы б для про без под над при'.split(' '));

/** Pronunciation spellings: same vowels, so stress positions still line up. */
const RESPELL: [RegExp, string][] = [
  [/^что(бы)?$/, 'што$1'], [/^конечно$/, 'конешно'], [/^скучно$/, 'скушно'], [/^нарочно$/, 'нарошно'],
  [/^сегодня$/, 'севодня'], [/ться$/, 'ца'], [/тся$/, 'ца'], [/[сз]ч/g, 'щ'], [/вств/g, 'ств'],
  [/лнц/g, 'нц'], [/[тд]ц/g, 'ц'], [/[тд]ч/g, 'ч'], [/здн/g, 'зн'], [/стн/g, 'сн'], [/гк/g, 'хк'], [/гч/g, 'хч'],
];
const GO_EXCEPTIONS = new Set(['много', 'строго', 'дорого', 'убого', 'полого', 'немного']);

export const hasCyrillic = (s: string) => /[\u0400-\u04FF]/.test(s);

/**
 * A capital vowel inside a word marks stress (молокО → молок+о). The first letter is skipped, since
 * it is capitalized at sentence starts and in names, and so are all-caps words.
 */
export function capitalStress(word: string) {
  const letters = word.replace(/[+=\u0301]/g, '');
  if (letters.length > 1 && letters === letters.toUpperCase()) return word;
  return word.replace(/(?<=.)[АЕЁИОУЫЭЮЯ]/g, (v) => `+${v.toLowerCase()}`);
}

const countVowels = (w: string) => [...w].filter((c) => VOWELS.includes(c)).length;

/**
 * Strip stress marks. Returns the plain word, the index (among its vowels) of the stressed one, and
 * the indices of vowels marked "=" (said as written).
 */
function parseStress(raw: string): [string, number, Set<number>] {
  let out = '';
  let stress = -1;
  let vi = 0;
  let plus = false;
  let eq = false;
  const full = new Set<number>();
  for (const c of raw) {
    if (c === '+') { plus = true; continue; }
    if (c === '=') { eq = true; continue; }
    if (c === '\u0301') { if (vi > 0) stress = vi - 1; continue; }
    if (VOWELS.includes(c)) {
      if (plus) stress = vi;
      if (eq) full.add(vi);
      plus = eq = false;
      vi++;
    }
    out += c;
  }
  if (stress < 0) {
    const yo = [...out].filter((c) => VOWELS.includes(c)).indexOf('ё');
    if (yo >= 0) stress = yo;
  }
  return [out, stress, full];
}

function guessStress(w: string) {
  const n = countVowels(w);
  if (n <= 1) return n - 1;
  if (/(ать|ять|еть|ить|уть|ти)$/.test(w)) return n - 1;
  if (/(ция|сия|зия|ние|тие)$/.test(w)) return Math.max(0, n - 3);
  // Adjective endings (-ая, -ое, -ые, -ую…) are unstressed: хор+ошая, кр+асное.
  if (/(ая|яя|ое|ее|ые|ие|ую|юю|ого|его|ому|ему)$/.test(w)) return Math.max(0, n - 3);
  return n - 2;
}

export function russianWord(raw: string): Word {
  let [w, stress, full] = parseStress(raw.toLowerCase().replace(/ъ(?=[^еёюя]|$)/g, ''));
  if (stress < 0 && STRESSED.has(w)) [, stress] = parseStress(STRESSED.get(w)!);
  if (stress < 0 && !UNSTRESSED.has(w)) stress = guessStress(w);
  for (const [re, to] of RESPELL) w = w.replace(re, to);
  if (w.length >= 3 && /[ео]го$/.test(w) && !GO_EXCEPTIONS.has(w)) w = `${w.slice(0, -2)}во`;
  if (UNSTRESSED.has(w)) stress = -1;

  const ph: string[] = [];
  let stressPhone = -1;
  let vi = 0;
  for (let i = 0; i < w.length; i++) {
    const c = w[i];
    const prev = w[i - 1];
    const next = w[i + 1];
    if (c === 'ь' || c === 'ъ') continue;
    if (CONS[c]) {
      if (next === c) continue; // doubled letters are one (slightly longer) sound
      const soft = !ALWAYS_HARD.includes(c) && !ALWAYS_SOFT.includes(c) && next !== undefined && SOFTENERS.includes(next);
      if (c === 'л') ph.push(soft ? "L'" : 'LX');
      else ph.push(soft ? `${CONS[c]}'` : CONS[c]);
      continue;
    }
    if (!VOWELS.includes(c)) continue;
    const stressed = vi === stress;
    /** Full vowel quality: stressed, or marked "=". */
    const q = stressed || full.has(vi);
    const pretonic = vi === stress - 1;
    vi++;
    const afterVowel = !prev || VOWELS.includes(prev);
    if ((IOTATED.includes(c) && (afterVowel || prev === 'ь' || prev === 'ъ')) || (c === 'и' && prev === 'ь')) ph.push('Y');
    const hardPrev = prev !== undefined && ALWAYS_HARD.includes(prev);
    const softPrev = prev === 'ч' || prev === 'щ';
    const final = i === w.length - 1;
    let v: string;
    switch (c) {
      case 'а':
      case 'о':
        v = q ? (c === 'а' ? 'AA' : 'OH') : softPrev ? 'IH' : (pretonic || afterVowel) && !final ? 'AH' : 'AR';
        break;
      case 'у': case 'ю': v = 'UU'; break;
      case 'ы': v = 'YI'; break;
      case 'э': v = 'EH'; break;
      case 'и': v = hardPrev ? 'YI' : q ? 'IY' : 'IH'; break;
      case 'е': v = q ? 'EH' : hardPrev ? 'YI' : 'IH'; break;
      case 'ё': v = 'OH'; break;
      default: v = q ? 'AA' : final ? 'AR' : 'IH'; // я
    }
    if (stressed) stressPhone = ph.length;
    ph.push(v);
  }

  // Final devoicing and voicing assimilation, right to left so whole clusters agree ("вств").
  for (let i = ph.length - 1; i >= 0; i--) {
    const soft = ph[i].endsWith("'");
    const base = soft ? ph[i].slice(0, -1) : ph[i];
    const next = ph[i + 1]?.replace("'", '');
    let to = base;
    if (next === undefined || VOICELESS.has(next)) to = DEVOICE[base] ?? base;
    else if (VOICING.has(next)) to = VOICE[base] ?? base;
    ph[i] = soft ? `${to}'` : to;
  }
  // Assimilation can leave a doubled consonant ("сзади" → з-з): say it once.
  const phones: string[] = [];
  let stressAt = -1;
  ph.forEach((p, i) => {
    if (i === stressPhone) stressAt = phones.length;
    else if (p === ph[i - 1] && !VOWEL_PHONES.has(p)) return;
    phones.push(p);
  });
  return { phones, stress: stressAt, ru: true };
}

// ---------------------------------------------------------------- numbers

const ONES = 'ноль од+ин дв+а тр+и чет+ыре п+ять ш+есть с+емь в+осемь д+евять д+есять од+иннадцать двен+адцать трин+адцать чет+ырнадцать пятн+адцать шестн+адцать семн+адцать восемн+адцать девятн+адцать'.split(' ');
const TENS = ' д+есять дв+адцать тр+идцать с+орок пятьдес+ят шестьдес+ят с+емьдесят в+осемьдесят девян+осто'.split(' ');
const HUNDREDS = ' ст+о дв+ести тр+иста чет+ыреста пятьс+от шестьс+от семьс+от восемьс+от девятьс+от'.split(' ');

function plural(n: number, one: string, few: string, many: string) {
  const a = n % 100;
  const b = n % 10;
  if (a >= 11 && a <= 14) return many;
  return b === 1 ? one : b >= 2 && b <= 4 ? few : many;
}

function below1000(n: number, feminine = false): string {
  const parts: string[] = [];
  if (n >= 100) parts.push(HUNDREDS[Math.floor(n / 100)]);
  const r = n % 100;
  if (r >= 20) {
    parts.push(TENS[Math.floor(r / 10)]);
    if (r % 10) parts.push(ONES[r % 10]);
  } else if (r > 0 || !parts.length) parts.push(ONES[r]);
  const last = parts.length - 1;
  if (feminine && parts[last] === ONES[1]) parts[last] = 'одн+а';
  if (feminine && parts[last] === ONES[2]) parts[last] = 'дв+е';
  return parts.join(' ');
}

export function russianNumber(n: number): string {
  if (n < 1000) return below1000(n);
  const groups: [number, string, string, string, boolean][] = [
    [1e9, 'милли+ард', 'милли+арда', 'милли+ардов', false],
    [1e6, 'милли+он', 'милли+она', 'милли+онов', false],
    [1e3, 'т+ысяча', 'т+ысячи', 'т+ысяч', true],
  ];
  const parts: string[] = [];
  for (const [v, one, few, many, fem] of groups) {
    const k = Math.floor(n / v) % 1000;
    if (k) parts.push(k === 1 && v === 1e3 ? one : `${below1000(k, fem)} ${plural(k, one, few, many)}`);
  }
  if (n % 1000) parts.push(below1000(n % 1000));
  return parts.join(' ');
}

export const RUSSIAN_DIGITS = ONES.slice(0, 10);
