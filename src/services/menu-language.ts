type MenuItem = {
  id: string;
  sku: string;
  name: string;
  category: 'plate' | 'addon' | 'drink';
  metadata_json: string;
};

type Metadata = {
  kitchen?: { product?: { unit: string; baseQuantity: number } };
  product_type?: 'set' | 'byo_protein';
  aliases?: string[];
  upsell_skus?: string[];
};

export type ParsedMenuText = {
  quantities?: Record<string,number>;
  primaryIds: string[];
  extraIds: string[];
  sauce?: string;
  spice?: string;
};

const SAUCES = [
  { name: 'Mantequilla de ajo', aliases: ['mantequilla de ajo', 'ajo y mantequilla', 'garlic butter'] },
  { name: 'Limón y pimienta', aliases: ['limon y pimienta', 'limon pimienta', 'lemon pepper'] },
  { name: 'Salsa de la casa', aliases: ['salsa de la casa', 'estilo de la casa', 'backyard style', 'backyard', 'cajun de la casa'] }
];

const SPICES = [
  { name: 'Suave', aliases: ['suave', 'sin picante', 'mild'] },
  { name: 'Medio', aliases: ['medio', 'medium'] },
  { name: 'Picante', aliases: ['picante', 'hot'] },
  { name: 'Muy picante', aliases: ['muy picante', 'extra picante', 'nawlins hot', 'nawlins'] }
];

export function normalizeMenuInput(value:string) {
  return value.toLowerCase().replace(/(\d)[.,](?=\d)/g,'$1decimalmarker').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ').replace(/decimalmarker/g,'.');
}
export function parseMenuText(text: string, menu: MenuItem[]): ParsedMenuText {
  if(/-\s*\d+(?:[.,]\d+)?\s*(g|kg|gramos?|kilos?)/i.test(text))throw new Error('El peso debe ser positivo');
  text=normalizeMenuInput(text);
  const sauce = matchNamed(text, SAUCES);
  const spice = matchNamed(text, SPICES);
  const sets = menu.filter((item) => metadata(item).product_type === 'set');
  const proteins = menu.filter((item) => metadata(item).product_type === 'byo_protein');
  const extras = menu.filter((item) => item.category === 'addon' || item.category === 'drink');
  const quantities:Record<string,number>={};
  const matchedSets = matchItems(text, sets,quantities);
  let proteinText = text;
  for (const id of new Set(matchedSets)) {
    const item = sets.find(i => i.id === id)!;
    for (const alias of [...(metadata(item).aliases || [item.name.toLowerCase()])].sort((a,b)=>b.length-a.length)) proteinText = (' ' + proteinText + ' ').replace(phrasePattern(alias),' ');
  }
  return {
    quantities,
    primaryIds: menu.some(item => metadata(item).kitchen) ? [...matchedSets, ...matchItems(proteinText, proteins,quantities)] : matchedSets.length ? matchedSets : matchItems(text, proteins,quantities),
    extraIds: matchItems(text, extras,quantities),
    sauce,
    spice
  };
}

export function parseSauce(text: string) { return matchNamed(text, SAUCES); }
export function parseSpice(text: string) { return matchNamed(text, SPICES); }

export function saucePrompt() {
  return `¿Qué salsa quieres? Puedes decir *mantequilla de ajo*, *limón y pimienta* o *salsa de la casa*.`;
}

export function spicePrompt() {
  return `¿Qué nivel de picante quieres? *Suave*, *medio*, *picante* o *muy picante*.`;
}

export function metadata(item: MenuItem): Metadata {
  return JSON.parse(item.metadata_json || '{}') as Metadata;
}

function matchNamed(text: string, choices: Array<{ name: string; aliases: string[] }>) {
  const aliases = choices.flatMap((choice) => choice.aliases.map((alias) => ({ name: choice.name, alias })))
    .sort((a, b) => b.alias.length - a.alias.length);
  for (const choice of aliases) {
    if (includesPhrase(text, choice.alias)) return choice.name;
  }
  return undefined;
}

function matchItems(text: string, items: MenuItem[], quantities:Record<string,number>) {
  let remaining = ` ${text} `;
  const matches: string[] = [];
  const candidates = items.flatMap((item) => {
    const aliases = metadata(item).aliases ?? [item.name.toLowerCase()];
    return aliases.map((alias) => ({ item, alias })).sort((a, b) => b.alias.length - a.alias.length);
  }).sort((a, b) => b.alias.length - a.alias.length);

  for (const candidate of candidates) {
    const pattern = phrasePattern(candidate.alias);
    const match = remaining.match(pattern);
    if (!match || matches.includes(candidate.item.id)) continue;
    let quantity = detectQuantity(remaining, candidate.alias);
    const product = metadata(candidate.item).kitchen?.product;
    if(product?.unit==='piece'&&metadata(candidate.item).product_type==='byo_protein'){
      const escaped=escapeRegExp(candidate.alias).replace(/\s+/g,'\\s+');
      if(new RegExp(`(?:\\d+(?:[.,]\\d+)?\\s*(?:kg|g|gramos?)\\s+(?:de\\s+)?|(?:media?|mitad de)\\s+)${escaped}|${escaped}\\s+\\d+(?:[.,]\\d+)?\\s*(?:kg|g|gramos?)`,'i').test(remaining))throw new Error(`${candidate.item.name} se vende por pieza entera. ¿Cuántas piezas enteras quieres?`);
    }
    if (product?.unit === 'g') {
      const escaped = escapeRegExp(candidate.alias).replace(/\s+/g, '\\s+');
      const weighted = remaining.match(new RegExp(`(?:^|\\s)(\\d+(?:[.,]\\d+)?)\\s*(kg|g|gramos?|kilos?)\\s+(?:de\\s+)?${escaped}(?=\\s|$)`, 'i'));
      const after = remaining.match(new RegExp(`${escaped}\\s+(\\d+(?:[.,]\\d+)?)\\s*(kg|g|gramos?|kilos?)(?=\\s|$)`, 'i'));
      const weight = weighted || after;
      if (weight) {
        const grams = Number(weight[1]!.replace(',','.')) * (/^(kg|kilo)/i.test(weight[2]!) ? 1000 : 1);
        quantity = grams / product.baseQuantity;
        if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 100) throw new Error(`Pide entre 0 y ${100*product.baseQuantity} g de ${candidate.item.name}`);
        if (!Number.isSafeInteger(quantity)) {quantities[candidate.item.id]=quantity; quantity=1;}
      }
    }
    for (let index = 0; index < quantity; index++) matches.push(candidate.item.id);
    remaining = remaining.replace(pattern, ' ');
  }
  return matches;
}

function detectQuantity(text: string, alias: string) {
  const escaped = escapeRegExp(alias).replace(/\s+/g, '\\s+');
  const match = text.match(new RegExp(`(?:^|\\s)(\\d+|un|una|dos|tres)\\s+(?:porciones?\\s+de\\s+)?${escaped}(?=\\s|$)`, 'i'));
  if (!match) return 1;
  const words: Record<string, number> = { un: 1, una: 1, dos: 2, tres: 3 };
  const quantity = words[match[1]!] ?? Number(match[1]);
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 100) throw new Error('Pide entre 1 y 100 unidades por producto');
  return quantity;
}

function includesPhrase(text: string, phrase: string) { return phrasePattern(phrase).test(` ${text} `); }
function phrasePattern(phrase: string) {
  const escaped = escapeRegExp(phrase).replace(/\s+/g, '\\s+');
  return new RegExp(`(?:^|\\s)${escaped}(?=\\s|$)`, 'i');
}
function escapeRegExp(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
