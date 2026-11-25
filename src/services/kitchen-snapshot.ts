import type { CartLine } from '../types.js';
// The kitchen publishes this recipe with the sale product. Checkout freezes it.
export function snapshotKitchenLine(item: { metadata_json: string; price_cop: number }, line: CartLine, inheritedHeat?: string) {
  const recipe = JSON.parse(item.metadata_json || '{}').kitchen;
  if (!recipe) return null; // Legacy orders are flagged for review by kitchen reconciliation.
  const p = recipe.product;
  if (!p || !Array.isArray(recipe.ingredients) || p.priceCop !== item.price_cop) throw new Error('El precio y la receta necesitan revisión antes de vender');
  const heat = line.customization?.spice || inheritedHeat;
  if (p.requiresHeat && !['Suave','Medio'].includes(heat || '')) throw new Error('Elige Suave o Medio para cada preparación');
  if (line.customization?.sauce && line.customization.sauce !== 'Salsa de la casa') throw new Error('Este menú incluye salsa de la casa');
  return { menuVersion:JSON.parse(item.metadata_json).menu_version??null, slug:JSON.parse(item.metadata_json).slug??null, product: line.customization?.wholePiece?{...p,name:p.name+' · '+(line.customization.wholePiece==='racimo_entero'?'RACIMO ENTERO':'PATA ENTERA')+(line.customization.finalWeightPending?' (peso estimado)':' (precio fijo por pieza)')}:p, wholePiece:line.customization?.wholePiece??null,wholePieceCount:line.customization?.wholePieceCount??null,ingredients: recipe.ingredients, quantity: line.quantity * p.baseQuantity, heat: p.requiresHeat ? heat : null };
}
